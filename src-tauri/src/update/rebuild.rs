use std::{
    env,
    ffi::CStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

use super::progress::{spawn_output_reader, UpdateProgressReporter};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) const UPDATE_BUILD_COMMAND: &str = "exec npm run rebuild";

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn run_rebuild(
    app: &tauri::AppHandle,
    source_root: &Path,
    expected_commit: &str,
) -> Result<(), String> {
    // The installer is detached before this process exits. Passing our PID
    // explicitly lets the rebuild script stop exactly this stale instance
    // instead of relying on a broad process-name match.
    let old_pid = std::process::id().to_string();
    let mut command = release_build_command(source_root, expected_commit, &old_pid);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // The rebuild must survive the app process exiting after install, and
        // must not share the app's terminal/process group.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start npm run rebuild: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reporter = Arc::new(UpdateProgressReporter::new(app.clone()));
    let stdout_reader = stdout.map(|reader| spawn_output_reader(reporter.clone(), reader, false));
    let stderr_reader = stderr.map(|reader| spawn_output_reader(reporter.clone(), reader, true));
    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for npm run rebuild: {error}"))?;
    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    reporter.finish();
    if !status.success() {
        let status = format!("npm run rebuild failed (status {status}).");
        return match reporter.latest_diagnostic() {
            Some(detail) => Err(format!("{status} Last output: {detail}")),
            None => Err(status),
        };
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn release_build_command(
    source_root: &Path,
    expected_commit: &str,
    old_pid: &str,
) -> Command {
    let mut command = shell_command(UPDATE_BUILD_COMMAND);
    command
        .env("LEETCODER_EXPECTED_COMMIT", expected_commit)
        .env("LEETCODER_UPDATE_OLD_PID", old_pid)
        .current_dir(source_root);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_command(value: &str) -> Command {
    let mut command = Command::new(configured_shell());
    // Desktop launchers provide a minimal PATH. Login-interactive mode loads
    // the user's shell setup, including fnm/nvm-managed Node and npm paths.
    command.args(["-l", "-i", "-c", value]);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn configured_shell() -> PathBuf {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| is_usable_shell(path))
        .or_else(login_shell_from_passwd);
    shell_path_or_fallback(shell)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn login_shell_from_passwd() -> Option<PathBuf> {
    let passwd = unsafe { libc::getpwuid(libc::getuid()) };
    if passwd.is_null() || unsafe { (*passwd).pw_shell.is_null() } {
        return None;
    }
    let shell = unsafe { CStr::from_ptr((*passwd).pw_shell) }
        .to_string_lossy()
        .into_owned();
    (!shell.is_empty()).then(|| PathBuf::from(shell))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn shell_path_or_fallback(candidate: Option<PathBuf>) -> PathBuf {
    candidate
        .filter(|path| is_usable_shell(path))
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn is_usable_shell(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

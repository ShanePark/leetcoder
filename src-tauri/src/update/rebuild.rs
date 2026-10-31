use std::{
    env,
    ffi::CStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use super::progress::{spawn_output_reader, UpdatePhase, UpdateProgressReporter};

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) const UPDATE_BUILD_COMMAND: &str = "exec nice -n 10 npm run rebuild -- --stage-only";
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) const UPDATE_APPLY_COMMAND: &str = "exec npm run rebuild -- --apply-staged";

/// Process group of the running background build, if any. The build runs in
/// its own session, so its PID is also the group that holds every compiler
/// process it started.
#[cfg(any(target_os = "macos", target_os = "linux"))]
static BUILD_PROCESS_GROUP: Mutex<Option<libc::pid_t>> = Mutex::new(None);

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct TrackedBuildGroup;

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl TrackedBuildGroup {
    fn record(pid: u32) -> Self {
        *lock_build_group() = libc::pid_t::try_from(pid).ok();
        Self
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for TrackedBuildGroup {
    fn drop(&mut self) {
        *lock_build_group() = None;
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn lock_build_group() -> std::sync::MutexGuard<'static, Option<libc::pid_t>> {
    BUILD_PROCESS_GROUP
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Cancels a running background build by terminating its whole process group.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn terminate_running_build() {
    if let Some(group) = lock_build_group().take() {
        if group > 0 && unsafe { libc::kill(-group, libc::SIGTERM) } == -1 {
            eprintln!(
                "Could not cancel the update build: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

/// Builds the release for `expected_commit` and stages it next to the
/// installed app without touching the running instance.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn stage_update_build(
    app: &tauri::AppHandle,
    source_root: &Path,
    expected_commit: &str,
) -> Result<(), String> {
    let command = stage_build_command(source_root, expected_commit);
    run_rebuild_script(app, command, UpdatePhase::Build)
}

/// Installs the staged build for `ready_commit` and relaunches the app.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn apply_staged_update(
    app: &tauri::AppHandle,
    source_root: &Path,
    ready_commit: &str,
) -> Result<(), String> {
    // The installer is detached before this process exits. Passing our PID
    // explicitly lets the rebuild script stop exactly this stale instance
    // instead of relying on a broad process-name match.
    let old_pid = std::process::id().to_string();
    let command = apply_staged_command(source_root, ready_commit, &old_pid);
    run_rebuild_script(app, command, UpdatePhase::Apply)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_rebuild_script(
    app: &tauri::AppHandle,
    mut command: Command,
    phase: UpdatePhase,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // The installer must survive the app process exiting after install,
        // and neither phase may share the app's terminal/process group. A
        // separate group also lets a build be cancelled as a whole.
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
    // Only the build is cancelled on exit; the installer must outlive the app.
    let tracked_group =
        (phase == UpdatePhase::Build).then(|| TrackedBuildGroup::record(child.id()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reporter = Arc::new(UpdateProgressReporter::new(app.clone(), phase));
    let stdout_reader = stdout.map(|reader| spawn_output_reader(reporter.clone(), reader, false));
    let stderr_reader = stderr.map(|reader| spawn_output_reader(reporter.clone(), reader, true));
    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for npm run rebuild: {error}"))?;
    drop(tracked_group);
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
pub(super) fn stage_build_command(source_root: &Path, expected_commit: &str) -> Command {
    let mut command = shell_command(UPDATE_BUILD_COMMAND);
    // A relaunched app inherits the installer's environment; staging must
    // never be pointed at a process to stop.
    command
        .env("LEETCODER_EXPECTED_COMMIT", expected_commit)
        .env_remove("LEETCODER_UPDATE_OLD_PID")
        .current_dir(source_root);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn apply_staged_command(
    source_root: &Path,
    ready_commit: &str,
    old_pid: &str,
) -> Command {
    let mut command = shell_command(UPDATE_APPLY_COMMAND);
    command
        .env("LEETCODER_EXPECTED_COMMIT", ready_commit)
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

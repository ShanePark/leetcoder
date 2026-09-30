use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tempfile::{Builder, TempDir};

pub(super) const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
pub(super) const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(200);
pub(super) const MAX_CAPTURED_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct OutputCapture {
    bytes: Vec<u8>,
}

pub(super) fn create_private_temp_dir(prefix: &str) -> Result<TempDir, String> {
    let directory = Builder::new()
        .prefix(prefix)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| format!("Unable to create private Java metadata workspace: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "Unable to secure Java metadata workspace '{}': {error}",
                    directory.path().display()
                )
            },
        )?;
    }
    Ok(directory)
}

pub(super) fn write_private_file(
    path: &Path,
    contents: &[u8],
    description: &str,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Unable to create {description} '{}': {error}",
                path.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Unable to secure {description} '{}': {error}",
                path.display()
            )
        })?;
    }
    file.write_all(contents)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to write {description}: {error}"))
}

pub(super) fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<BoundedOutput, String> {
    isolate_process_session(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {description}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .map(|stream| spawn_bounded_reader(stream));
    let stderr = child
        .stderr
        .take()
        .map(|stream| spawn_bounded_reader(stream));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate_process_tree(&mut child);
                return Err(format!("Unable to wait for {description}: {error}"));
            }
        }
        if started.elapsed() >= timeout {
            terminate_process_tree(&mut child);
            let output = collect_output(stdout, stderr);
            return Err(format!(
                "{description} exceeded the {} second timeout.{}",
                timeout.as_secs(),
                output_diagnostic_suffix(&output)
            ));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    };
    let output = collect_output(stdout, stderr);
    Ok(BoundedOutput {
        success: status.success(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn spawn_bounded_reader<R: Read + Send + 'static>(reader: R) -> JoinHandle<OutputCapture> {
    thread::spawn(move || {
        let mut reader = reader;
        let mut capture = OutputCapture::default();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let remaining = MAX_CAPTURED_OUTPUT.saturating_sub(capture.bytes.len());
                    capture
                        .bytes
                        .extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
        capture
    })
}

pub(super) struct BoundedOutput {
    pub(super) success: bool,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

fn collect_output(
    stdout: Option<JoinHandle<OutputCapture>>,
    stderr: Option<JoinHandle<OutputCapture>>,
) -> BoundedOutput {
    BoundedOutput {
        success: false,
        stdout: join_reader(stdout),
        stderr: join_reader(stderr),
    }
}

fn join_reader(reader: Option<JoinHandle<OutputCapture>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .map(|capture| capture.bytes)
        .unwrap_or_default()
}

pub(super) fn format_process_failure(message: &str, output: &BoundedOutput) -> String {
    let detail = first_output_line(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| first_output_line(&String::from_utf8_lossy(&output.stdout)));
    match detail {
        Some(detail) => format!("{message}: {detail}"),
        None => message.to_string(),
    }
}

fn output_diagnostic_suffix(output: &BoundedOutput) -> String {
    first_output_line(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| first_output_line(&String::from_utf8_lossy(&output.stdout)))
        .map(|line| format!(" Output: {line}"))
        .unwrap_or_default()
}

pub(super) fn first_output_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(500).collect())
}

fn isolate_process_session(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
        let _ = child.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub(super) fn java_executable_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;

/// Git treats path arguments as pathspecs, so a filename containing glob or
/// pathspec-magic characters could otherwise select additional files. The
/// literal prefix keeps a selected row mapped to exactly one repository path.
pub(crate) fn git_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

pub(crate) fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}
pub(crate) fn has_head(root: &Path) -> bool {
    run_git(root, ["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}
pub(crate) fn run_git<I, S>(root: &Path, args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    const MAX_STREAM_BYTES: usize = 1024 * 1024;
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", noninteractive_askpass())
        .env("SSH_ASKPASS", noninteractive_askpass())
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Unable to run Git. Install Git and try again.".to_string()
        } else {
            format!("Unable to run Git: {error}")
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture Git standard output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to capture Git standard error".to_string())?;
    let stdout_thread = thread::spawn(move || read_bounded_stream(stdout, MAX_STREAM_BYTES));
    let stderr_thread = thread::spawn(move || read_bounded_stream(stderr, MAX_STREAM_BYTES));
    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for Git: {error}"))?;
    let stdout = stdout_thread
        .join()
        .map_err(|_| "Git standard output reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Unable to read Git standard output: {error}"))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "Git standard error reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Unable to read Git standard error: {error}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

pub(crate) fn read_bounded_stream<R: Read>(mut stream: R, max_bytes: usize) -> io::Result<Vec<u8>> {
    const TRUNCATION_MARKER: &[u8] = b"\n...[output truncated by leetcoder]...\n";
    let payload_limit = max_bytes.saturating_sub(TRUNCATION_MARKER.len());
    let mut captured = Vec::with_capacity(max_bytes.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if captured.len() < payload_limit {
            let take = (payload_limit - captured.len()).min(read);
            captured.extend_from_slice(&buffer[..take]);
            truncated |= take < read;
        } else {
            truncated = true;
        }
    }
    if truncated {
        captured.extend_from_slice(&TRUNCATION_MARKER[..max_bytes - captured.len()]);
    }
    Ok(captured)
}

pub(crate) fn noninteractive_askpass() -> &'static str {
    #[cfg(unix)]
    {
        return "/usr/bin/false";
    }
    #[cfg(windows)]
    {
        "cmd.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "false"
    }
}

pub(crate) fn require_success(operation: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(operation, &output))
    }
}

pub(crate) fn command_error(operation: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!("{operation} failed (exit code {:?})", output.status.code())
    } else {
        format!("{operation} failed: {detail}")
    }
}

pub(crate) fn utf8_stdout(output: &Output, operation: &str) -> Result<String, String> {
    String::from_utf8(output.stdout.clone())
        .map_err(|_| format!("{operation} returned invalid UTF-8 output"))
}

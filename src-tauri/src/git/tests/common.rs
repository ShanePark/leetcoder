use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

pub(super) fn run_fixture_git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("git is installed for Rust tests");
    assert!(status.success(), "git {:?} failed", args);
}

pub(super) fn run_fixture_git_capture(root: &Path, args: &[String]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git is installed for Rust tests");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture git output is UTF-8")
        .trim()
        .to_string()
}

pub(super) fn fixture() -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("tempdir");
    run_fixture_git(directory.path(), &["init", "--quiet"]);
    run_fixture_git(directory.path(), &["config", "user.name", "Test User"]);
    run_fixture_git(
        directory.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    fs::write(directory.path().join("tracked.txt"), "before\n").expect("tracked file");
    run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
    run_fixture_git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
    directory
}

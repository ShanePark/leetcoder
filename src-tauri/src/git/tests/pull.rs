use super::super::pull::pull;
use super::common::{fixture, run_fixture_git, run_fixture_git_capture};
use std::fs;
use std::path::Path;

fn capture(root: &Path, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    run_fixture_git_capture(root, &args)
}

/// A local repository tracking `origin/main` in a bare remote, plus a second
/// clone standing in for another machine that pushes to the same branch.
struct Remotes {
    local: tempfile::TempDir,
    remote: tempfile::TempDir,
    other: tempfile::TempDir,
}

impl Remotes {
    fn new() -> Self {
        let local = fixture();
        let remote = tempfile::tempdir().expect("bare remote");
        run_fixture_git(remote.path(), &["init", "--bare", "--quiet"]);
        run_fixture_git(local.path(), &["branch", "-M", "main"]);
        let remote_path = remote.path().to_str().unwrap();
        run_fixture_git(local.path(), &["remote", "add", "origin", remote_path]);
        run_fixture_git(
            local.path(),
            &["push", "--quiet", "-u", "origin", "HEAD:refs/heads/main"],
        );
        let other = tempfile::tempdir().expect("other clone");
        run_fixture_git(
            other.path(),
            &["clone", "--quiet", "--branch", "main", remote_path, "."],
        );
        run_fixture_git(other.path(), &["config", "user.name", "Other User"]);
        run_fixture_git(
            other.path(),
            &["config", "user.email", "other@example.invalid"],
        );
        Remotes {
            local,
            remote,
            other,
        }
    }

    fn root(&self) -> &str {
        self.local.path().to_str().unwrap()
    }

    fn push_from_other(&self, path: &str, contents: &str) {
        fs::write(self.other.path().join(path), contents).expect("other file");
        run_fixture_git(self.other.path(), &["add", "--", path]);
        run_fixture_git(self.other.path(), &["commit", "--quiet", "-m", "other"]);
        run_fixture_git(self.other.path(), &["push", "--quiet", "origin", "main"]);
    }

    fn local_head(&self) -> String {
        capture(self.local.path(), &["rev-parse", "HEAD"])
    }

    fn remote_head(&self) -> String {
        capture(self.remote.path(), &["rev-parse", "refs/heads/main"])
    }
}

#[test]
fn pull_is_a_no_op_when_already_up_to_date() {
    let remotes = Remotes::new();
    let before = remotes.local_head();

    let result = pull(remotes.root()).unwrap();

    assert!(!result.updated);
    assert_eq!(remotes.local_head(), before);
}

#[test]
fn pull_keeps_local_commits_that_are_ahead_of_the_upstream() {
    let remotes = Remotes::new();
    run_fixture_git(
        remotes.local.path(),
        &["commit", "--quiet", "--allow-empty", "-m", "local"],
    );
    let before = remotes.local_head();

    let result = pull(remotes.root()).unwrap();

    assert!(!result.updated);
    assert_eq!(remotes.local_head(), before);
}

#[test]
fn pull_fast_forwards_and_keeps_unrelated_local_edits() {
    let remotes = Remotes::new();
    remotes.push_from_other("incoming.txt", "incoming\n");
    fs::write(remotes.local.path().join("tracked.txt"), "local edit\n").unwrap();

    let result = pull(remotes.root()).unwrap();

    assert!(result.updated);
    assert_eq!(remotes.local_head(), remotes.remote_head());
    assert_eq!(
        fs::read_to_string(remotes.local.path().join("incoming.txt")).unwrap(),
        "incoming\n"
    );
    assert_eq!(
        fs::read_to_string(remotes.local.path().join("tracked.txt")).unwrap(),
        "local edit\n"
    );
    // The remote-tracking ref follows, so the unpushed count stays accurate.
    assert_eq!(
        capture(
            remotes.local.path(),
            &["rev-parse", "refs/remotes/origin/main"]
        ),
        remotes.remote_head()
    );
}

#[test]
fn pull_refuses_a_diverged_branch_without_merging() {
    let remotes = Remotes::new();
    remotes.push_from_other("incoming.txt", "incoming\n");
    run_fixture_git(
        remotes.local.path(),
        &["commit", "--quiet", "--allow-empty", "-m", "local"],
    );
    let before = remotes.local_head();

    let error = pull(remotes.root()).unwrap_err();

    assert!(
        error.contains("main has diverged from origin/main"),
        "{error}"
    );
    assert!(error.contains("1 local and 1 remote"), "{error}");
    assert_eq!(remotes.local_head(), before);
    assert!(!remotes.local.path().join("incoming.txt").exists());
}

#[test]
fn pull_refuses_to_overwrite_local_edits_and_preserves_them() {
    let remotes = Remotes::new();
    remotes.push_from_other("tracked.txt", "remote edit\n");
    fs::write(remotes.local.path().join("tracked.txt"), "local edit\n").unwrap();
    let before = remotes.local_head();

    let error = pull(remotes.root()).unwrap_err();

    assert!(
        error.contains("Could not fast-forward main to origin/main"),
        "{error}"
    );
    assert!(error.contains("tracked.txt"), "{error}");
    assert_eq!(remotes.local_head(), before);
    assert_eq!(
        fs::read_to_string(remotes.local.path().join("tracked.txt")).unwrap(),
        "local edit\n"
    );
}

#[test]
fn pull_requires_a_configured_upstream() {
    let directory = fixture();

    let error = pull(directory.path().to_str().unwrap()).unwrap_err();

    assert!(
        error.contains("No upstream remote is configured"),
        "{error}"
    );
}

#[test]
fn pull_treats_a_deleted_upstream_branch_as_nothing_to_pull() {
    let remotes = Remotes::new();
    run_fixture_git(
        remotes.remote.path(),
        &["update-ref", "-d", "refs/heads/main"],
    );
    let before = remotes.local_head();

    let result = pull(remotes.root()).unwrap();

    assert!(!result.updated);
    assert_eq!(remotes.local_head(), before);
}

#[test]
fn pull_reports_a_fetch_failure() {
    let remotes = Remotes::new();
    let missing = remotes.remote.path().join("missing.git");
    run_fixture_git(
        remotes.local.path(),
        &["remote", "set-url", "origin", missing.to_str().unwrap()],
    );

    let error = pull(remotes.root()).unwrap_err();

    assert!(error.starts_with("Fetching origin/main failed"), "{error}");
}

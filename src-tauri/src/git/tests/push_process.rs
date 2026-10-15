use super::super::{
    process::read_bounded_stream,
    push::{push, unpushed_commit_count},
};
use super::common::{fixture, run_fixture_git, run_fixture_git_capture};
use std::io::Cursor;

#[test]
fn bounded_stream_capture_keeps_marker_and_does_not_retain_unbounded_output() {
    let input = vec![b'x'; 4096];
    let captured = read_bounded_stream(Cursor::new(input), 128).unwrap();
    assert!(captured.len() <= 128);
    assert!(String::from_utf8_lossy(&captured).contains("output truncated"));

    let short = read_bounded_stream(Cursor::new(b"short".to_vec()), 128).unwrap();
    assert_eq!(short, b"short");
}

#[test]
fn pushes_to_the_configured_upstream_ref_explicitly() {
    let directory = fixture();
    let remote = tempfile::tempdir().expect("bare remote");
    run_fixture_git(remote.path(), &["init", "--bare", "--quiet"]);
    run_fixture_git(directory.path(), &["branch", "-M", "main"]);
    run_fixture_git_capture(
        directory.path(),
        &[
            "remote".to_string(),
            "add".to_string(),
            "origin".to_string(),
            remote.path().to_string_lossy().into_owned(),
        ],
    );
    run_fixture_git_capture(
        directory.path(),
        &[
            "push".to_string(),
            "-u".to_string(),
            "origin".to_string(),
            "HEAD:refs/heads/main".to_string(),
        ],
    );

    let result = push(directory.path().to_str().unwrap()).unwrap();
    assert_eq!(result.branch.as_deref(), Some("main"));
    let local_head = run_fixture_git_capture(
        directory.path(),
        &["rev-parse".to_string(), "HEAD".to_string()],
    );
    let remote_head = run_fixture_git_capture(
        remote.path(),
        &["rev-parse".to_string(), "refs/heads/main".to_string()],
    );
    assert_eq!(local_head, remote_head);
}

#[test]
fn counts_commits_the_upstream_does_not_have() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    assert_eq!(unpushed_commit_count(root).unwrap(), 0);

    let remote = tempfile::tempdir().expect("bare remote");
    run_fixture_git(remote.path(), &["init", "--bare", "--quiet"]);
    run_fixture_git(directory.path(), &["branch", "-M", "main"]);
    run_fixture_git_capture(
        directory.path(),
        &[
            "remote".to_string(),
            "add".to_string(),
            "origin".to_string(),
            remote.path().to_string_lossy().into_owned(),
        ],
    );
    run_fixture_git_capture(
        directory.path(),
        &[
            "push".to_string(),
            "-u".to_string(),
            "origin".to_string(),
            "HEAD:refs/heads/main".to_string(),
        ],
    );
    assert_eq!(unpushed_commit_count(root).unwrap(), 0);

    run_fixture_git(
        directory.path(),
        &["commit", "--quiet", "--allow-empty", "-m", "local"],
    );
    assert_eq!(unpushed_commit_count(root).unwrap(), 1);

    push(root).unwrap();
    assert_eq!(unpushed_commit_count(root).unwrap(), 0);
}

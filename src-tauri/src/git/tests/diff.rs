use super::super::diff::diff;
use super::common::{fixture, run_fixture_git};
use std::fs;

#[test]
fn diff_combines_tracked_and_untracked_selected_files() {
    let directory = fixture();
    fs::write(directory.path().join("tracked.txt"), "after\n").expect("modify tracked");
    fs::write(directory.path().join("new.txt"), "new\n").expect("new file");

    let patch = diff(
        directory.path().to_str().unwrap(),
        vec!["tracked.txt".to_string(), "new.txt".to_string()],
    )
    .unwrap();
    assert!(patch.contains("diff --git a/tracked.txt b/tracked.txt"));
    assert!(patch.contains("diff --git a/new.txt b/new.txt"));
    assert!(patch.contains("+after"));
    assert!(patch.contains("+new"));
}

#[test]
fn diff_uses_final_worktree_content_for_staged_and_unstaged_changes() {
    let directory = fixture();
    fs::write(directory.path().join("tracked.txt"), "staged\n").expect("stage content");
    run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
    fs::write(
        directory.path().join("tracked.txt"),
        "staged and unstaged\n",
    )
    .expect("worktree content");

    let patch = diff(
        directory.path().to_str().unwrap(),
        vec!["tracked.txt".to_string()],
    )
    .unwrap();
    assert!(patch.contains("+staged and unstaged"));
    assert!(!patch.contains("+staged\n"));
}

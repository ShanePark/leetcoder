use super::super::{commit::commit, diff::diff, service::list_changes};
use super::common::{fixture, run_fixture_git};
use std::fs;

#[test]
fn selecting_rename_destination_also_commits_original_source_deletion() {
    let directory = fixture();
    fs::rename(
        directory.path().join("tracked.txt"),
        directory.path().join("renamed.txt"),
    )
    .expect("rename tracked file");
    run_fixture_git(directory.path(), &["add", "--all"]);

    let patch = diff(
        directory.path().to_str().unwrap(),
        vec!["renamed.txt".to_string()],
    )
    .unwrap();
    assert!(patch.contains("rename from tracked.txt"));
    assert!(patch.contains("rename to renamed.txt"));

    let result = commit(
        directory.path().to_str().unwrap(),
        vec!["renamed.txt".to_string()],
        "Rename tracked.txt".to_string(),
    )
    .unwrap();
    assert_eq!(result.paths, vec!["renamed.txt"]);
    assert!(!directory.path().join("tracked.txt").exists());
    assert!(directory.path().join("renamed.txt").exists());
    assert!(list_changes(directory.path().to_str().unwrap())
        .unwrap()
        .is_empty());
}

#[test]
fn commit_only_preserves_unrelated_staged_changes() {
    let directory = fixture();
    fs::write(directory.path().join("other.txt"), "other before\n").expect("other file");
    run_fixture_git(directory.path(), &["add", "--", "other.txt"]);
    fs::write(directory.path().join("tracked.txt"), "selected after\n").expect("selected change");

    let result = commit(
        directory.path().to_str().unwrap(),
        vec!["tracked.txt".to_string()],
        "Create tracked.txt".to_string(),
    )
    .unwrap();
    assert_eq!(result.message, "Create tracked.txt");
    assert!(!result.commit_hash.is_empty());

    let status = list_changes(directory.path().to_str().unwrap()).unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].path, "other.txt");
    assert_eq!(status[0].status, "A");
}

#[test]
fn commit_batches_existing_literal_paths_and_keeps_deleted_paths_isolated() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    let existing = "existing [*].txt";
    let deleted = "deleted [x].txt";
    let renamed = "renamed [a]*.txt";
    let unrelated = "unrelated staged.txt";

    fs::write(directory.path().join(existing), "before\n").expect("existing file");
    fs::write(directory.path().join(deleted), "before\n").expect("deleted file");
    run_fixture_git(directory.path(), &["add", "--all"]);
    run_fixture_git(directory.path(), &["commit", "--quiet", "-m", "baseline"]);

    fs::rename(
        directory.path().join("tracked.txt"),
        directory.path().join(renamed),
    )
    .expect("rename tracked file");
    run_fixture_git(directory.path(), &["add", "--all"]);
    fs::write(directory.path().join(existing), "after\n").expect("modify existing file");
    fs::remove_file(directory.path().join(deleted)).expect("delete tracked file");
    fs::write(directory.path().join(unrelated), "keep staged\n").expect("unrelated file");
    run_fixture_git(directory.path(), &["add", "--", unrelated]);

    let result = commit(
        root,
        vec![
            renamed.to_string(),
            deleted.to_string(),
            existing.to_string(),
        ],
        "Batch literal paths".to_string(),
    )
    .expect("selected changes should commit");

    assert_eq!(
        result.paths,
        vec![
            renamed.to_string(),
            deleted.to_string(),
            existing.to_string()
        ]
    );
    assert!(!directory.path().join("tracked.txt").exists());
    assert!(directory.path().join(renamed).exists());
    assert!(!directory.path().join(deleted).exists());
    assert_eq!(
        fs::read_to_string(directory.path().join(existing)).unwrap(),
        "after\n"
    );

    let status = list_changes(root).expect("status after commit");
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].path, unrelated);
    assert_eq!(status[0].status, "A");
}

#[test]
fn rejects_parent_path_before_running_mutating_commands() {
    let directory = fixture();
    let error = commit(
        directory.path().to_str().unwrap(),
        vec!["../outside.txt".to_string()],
        "unsafe".to_string(),
    )
    .unwrap_err();
    assert!(error.contains("may not contain '..'"));
}

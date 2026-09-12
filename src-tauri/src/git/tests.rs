use super::{
    commit::commit,
    diff::diff,
    path::{
        append_original_paths, changed_path_selection, file_manager_target, validate_worktree_path,
    },
    process::read_bounded_stream,
    push::push,
    service::{discard_changes, list_changes, show_in_file_manager},
};
use crate::models::GitFileChange;
use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

fn run_fixture_git(root: &Path, args: &[&str]) {
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

fn run_fixture_git_capture(root: &Path, args: &[String]) -> String {
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

fn fixture() -> tempfile::TempDir {
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

#[test]
fn rename_source_lookup_preserves_first_duplicate_status_record() {
    let changes = vec![
        GitFileChange {
            path: "renamed.txt".to_string(),
            status: "R".to_string(),
            index_status: "R".to_string(),
            worktree_status: ".".to_string(),
            original_path: Some("first.txt".to_string()),
        },
        GitFileChange {
            path: "renamed.txt".to_string(),
            status: "R".to_string(),
            index_status: "R".to_string(),
            worktree_status: ".".to_string(),
            original_path: Some("second.txt".to_string()),
        },
        GitFileChange {
            path: "other.txt".to_string(),
            status: "M".to_string(),
            index_status: ".".to_string(),
            worktree_status: "M".to_string(),
            original_path: None,
        },
    ];
    let selected = vec!["renamed.txt".to_string(), "other.txt".to_string()];
    let mut seen = selected.iter().cloned().collect();
    let mut command_paths = selected.clone();

    append_original_paths(&changes, &selected, &mut seen, &mut command_paths);

    assert_eq!(command_paths, ["renamed.txt", "other.txt", "first.txt"]);
}

#[test]
#[ignore = "manual native path-selection benchmark"]
fn benchmark_rename_source_lookup() {
    let change_count = 10_000usize;
    let selected_count = 500usize;
    const WARMUPS: usize = 4;
    const SAMPLES: usize = 20;
    const CALLS_PER_SAMPLE: usize = 10;
    let changes: Vec<GitFileChange> = (0..change_count)
        .map(|index| GitFileChange {
            path: format!("src/problem-{index}.java"),
            status: "R".to_string(),
            index_status: "R".to_string(),
            worktree_status: ".".to_string(),
            original_path: (index % 20 == 0).then(|| format!("src/original-{index}.java")),
        })
        .collect();
    let selected: Vec<String> = (0..selected_count)
        .map(|index| {
            format!(
                "src/problem-{}.java",
                index * (change_count / selected_count)
            )
        })
        .collect();

    fn reference_lookup(changes: &[GitFileChange], selected: &[String]) -> Vec<String> {
        let mut seen: HashSet<String> = selected.iter().cloned().collect();
        let mut command_paths = selected.to_vec();
        for selected_path in selected {
            let Some(change) = changes.iter().find(|change| change.path == *selected_path) else {
                continue;
            };
            let Some(original_path) = change.original_path.as_deref() else {
                continue;
            };
            if seen.insert(original_path.to_string()) {
                command_paths.push(original_path.to_string());
            }
        }
        command_paths
    }

    fn production_lookup(changes: &[GitFileChange], selected: &[String]) -> Vec<String> {
        let mut seen: HashSet<String> = selected.iter().cloned().collect();
        let mut command_paths = selected.to_vec();
        append_original_paths(changes, selected, &mut seen, &mut command_paths);
        command_paths
    }

    fn measure_batch<F>(calls: usize, mut lookup: F) -> (u128, Vec<Vec<String>>, usize)
    where
        F: FnMut() -> Vec<String>,
    {
        let started = Instant::now();
        let mut outputs = Vec::with_capacity(calls);
        for _ in 0..calls {
            outputs.push(lookup());
        }
        let elapsed_ns_per_call = started.elapsed().as_nanos() / calls as u128;
        let checksum = outputs.iter().map(Vec::len).sum();
        (elapsed_ns_per_call, outputs, checksum)
    }

    let measure_pair = |reference_first: bool| {
        let (reference, production) = if reference_first {
            (
                measure_batch(CALLS_PER_SAMPLE, || reference_lookup(&changes, &selected)),
                measure_batch(CALLS_PER_SAMPLE, || production_lookup(&changes, &selected)),
            )
        } else {
            let production =
                measure_batch(CALLS_PER_SAMPLE, || production_lookup(&changes, &selected));
            let reference =
                measure_batch(CALLS_PER_SAMPLE, || reference_lookup(&changes, &selected));
            (reference, production)
        };
        assert_eq!(reference.1, production.1);
        assert_eq!(reference.2, production.2);
        (reference.0, production.0, reference.2, production.2)
    };

    for warmup in 0..WARMUPS {
        let _ = measure_pair(warmup % 2 == 0);
    }

    let mut reference_samples = Vec::with_capacity(SAMPLES);
    let mut production_samples = Vec::with_capacity(SAMPLES);
    let mut baseline_checksum = 0usize;
    let mut checksum = 0usize;
    for sample in 0..SAMPLES {
        let (reference_ns, production_ns, reference_batch_checksum, production_batch_checksum) =
            measure_pair(sample % 2 == 0);
        reference_samples.push(reference_ns);
        production_samples.push(production_ns);
        baseline_checksum = baseline_checksum.saturating_add(reference_batch_checksum);
        checksum = checksum.saturating_add(production_batch_checksum);
    }

    fn median(samples: &[u128]) -> u128 {
        let mut sorted = samples.to_vec();
        sorted.sort_unstable();
        let middle = sorted.len() / 2;
        if sorted.len() % 2 == 0 {
            (sorted[middle - 1] + sorted[middle]) / 2
        } else {
            sorted[middle]
        }
    }

    let selected_single = vec!["src/problem-0.java".to_string()];
    let started = Instant::now();
    let mut single_checksum = 0usize;
    for _ in 0..(SAMPLES * CALLS_PER_SAMPLE) {
        let mut seen: HashSet<String> = selected_single.iter().cloned().collect();
        let mut command_paths = selected_single.clone();
        append_original_paths(&changes, &selected_single, &mut seen, &mut command_paths);
        single_checksum = single_checksum.saturating_add(command_paths.len());
    }
    let single_elapsed = started.elapsed();

    let expected_checksum = SAMPLES * CALLS_PER_SAMPLE * (selected_count * 2);
    assert_eq!(baseline_checksum, expected_checksum);
    assert_eq!(baseline_checksum, checksum);
    assert_eq!(single_checksum, SAMPLES * CALLS_PER_SAMPLE * 2);
    eprintln!(
        "rename-source lookup benchmark: {change_count} changes, {selected_count} selected, warmups={WARMUPS}, samples={SAMPLES}, calls_per_sample={CALLS_PER_SAMPLE}: baseline_samples_ns_per_call={reference_samples:?}, production_samples_ns_per_call={production_samples:?}, baseline_median_ns_per_call={}, production_median_ns_per_call={}, single_ns_per_call={}, checksum={baseline_checksum}/{checksum}/{single_checksum}",
        median(&reference_samples),
        median(&production_samples),
        single_elapsed.as_nanos() / (SAMPLES * CALLS_PER_SAMPLE) as u128,
    );
}

#[test]
#[ignore = "manual native Git status benchmark"]
fn benchmark_changed_path_selection_with_git_fixture() {
    let directory = fixture();
    let root = fs::canonicalize(directory.path()).expect("canonical fixture root");
    let source_root = root.join("src");
    fs::create_dir(&source_root).expect("source directory");
    let change_count = 2_000usize;
    let selected_count = 500usize;
    for index in 0..change_count {
        fs::write(
            source_root.join(format!("problem-{index}.java")),
            format!("class Problem{index} {{}}\n"),
        )
        .expect("problem fixture");
    }
    let selected: Vec<String> = (0..selected_count)
        .map(|index| {
            format!(
                "src/problem-{}.java",
                index * (change_count / selected_count)
            )
        })
        .collect();

    let started = Instant::now();
    let selection = changed_path_selection(&root, selected.clone()).expect("fixture selection");
    let elapsed = started.elapsed();

    let mut baseline_paths = selected.clone();
    let mut seen: HashSet<String> = selected.iter().cloned().collect();
    for selected_path in &selected {
        let Some(change) = selection
            .changes
            .iter()
            .find(|change| change.path == *selected_path)
        else {
            continue;
        };
        let Some(original_path) = change.original_path.as_deref() else {
            continue;
        };
        if seen.insert(original_path.to_string()) {
            baseline_paths.push(original_path.to_string());
        }
    }

    assert_eq!(selection.selected_paths, selected);
    assert_eq!(selection.command_paths, baseline_paths);
    eprintln!(
        "changed_path_selection fixture benchmark: {change_count} untracked files, {selected_count} selected: elapsed={elapsed:?}, command_paths={}"
        , selection.command_paths.len()
    );
}

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
fn parses_spaces_untracked_and_two_column_statuses() {
    let directory = fixture();
    fs::write(directory.path().join("tracked.txt"), "after\n").expect("modify tracked");
    fs::write(directory.path().join("new file.txt"), "new\n").expect("new file");

    let changes = list_changes(directory.path().to_str().unwrap()).unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].path, "new file.txt");
    assert_eq!(changes[0].status, "??");
    assert_eq!(changes[1].path, "tracked.txt");
    assert_eq!(changes[1].status, "M");
    assert_eq!(changes[1].index_status, ".");
    assert_eq!(changes[1].worktree_status, "M");
}

#[test]
fn discard_restores_unstaged_staged_and_mixed_tracked_changes() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    let tracked = directory.path().join("tracked.txt");

    fs::write(&tracked, "unstaged\n").expect("unstaged change");
    discard_changes(root, "tracked.txt").expect("discard unstaged change");
    assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
    assert!(list_changes(root).unwrap().is_empty());

    fs::write(&tracked, "staged\n").expect("staged change");
    run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
    discard_changes(root, "tracked.txt").expect("discard staged change");
    assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
    assert!(list_changes(root).unwrap().is_empty());

    fs::write(&tracked, "staged\n").expect("staged content");
    run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
    fs::write(&tracked, "staged and unstaged\n").expect("mixed content");
    discard_changes(root, "tracked.txt").expect("discard mixed change");
    assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
    assert!(list_changes(root).unwrap().is_empty());
}

#[test]
fn discard_removes_untracked_and_staged_added_files() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    let untracked = directory.path().join("untracked.txt");
    fs::write(&untracked, "untracked\n").expect("untracked file");
    discard_changes(root, "untracked.txt").expect("discard untracked file");
    assert!(!untracked.exists());
    assert!(list_changes(root).unwrap().is_empty());

    let added = directory.path().join("added.txt");
    fs::write(&added, "added\n").expect("staged added file");
    run_fixture_git(directory.path(), &["add", "--", "added.txt"]);
    discard_changes(root, "added.txt").expect("discard staged added file");
    assert!(!added.exists());
    assert!(list_changes(root).unwrap().is_empty());
}

#[test]
fn discard_restores_deleted_files_and_staged_renames() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    let tracked = directory.path().join("tracked.txt");
    fs::remove_file(&tracked).expect("delete tracked file");
    discard_changes(root, "tracked.txt").expect("discard deleted file");
    assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
    assert!(list_changes(root).unwrap().is_empty());

    let renamed = directory.path().join("renamed.txt");
    fs::rename(&tracked, &renamed).expect("rename tracked file");
    run_fixture_git(directory.path(), &["add", "--all"]);
    let changes = list_changes(root).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "renamed.txt");
    assert_eq!(changes[0].original_path.as_deref(), Some("tracked.txt"));
    // Either side of a freshly listed rename resolves to the same logical
    // status row; the UI normally passes the destination path.
    discard_changes(root, "tracked.txt").expect("discard staged rename");
    assert!(!renamed.exists());
    assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
    assert!(list_changes(root).unwrap().is_empty());
}

#[test]
fn discard_rechecks_status_before_mutating_the_worktree() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    let error = discard_changes(root, "tracked.txt").unwrap_err();
    assert!(error.contains("not currently changed"));
    assert_eq!(
        fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "before\n"
    );
}

#[test]
fn discard_handles_unborn_head_changes() {
    let directory = tempfile::tempdir().expect("tempdir");
    run_fixture_git(directory.path(), &["init", "--quiet"]);
    let root = directory.path().to_str().unwrap();

    let untracked = directory.path().join("untracked.txt");
    fs::write(&untracked, "untracked\n").expect("untracked file");
    discard_changes(root, "untracked.txt").expect("discard unborn untracked file");
    assert!(!untracked.exists());

    let added = directory.path().join("added.txt");
    fs::write(&added, "added\n").expect("unborn staged file");
    run_fixture_git(directory.path(), &["add", "--", "added.txt"]);
    discard_changes(root, "added.txt").expect("discard unborn staged file");
    assert!(!added.exists());
    assert!(list_changes(root).unwrap().is_empty());
}

#[test]
fn discard_and_file_manager_reject_unsafe_paths() {
    let directory = fixture();
    let root = directory.path().to_str().unwrap();
    assert!(discard_changes(root, "../outside.txt")
        .unwrap_err()
        .contains("may not contain '..'"));
    assert!(show_in_file_manager(root, "/outside.txt")
        .unwrap_err()
        .contains("must be relative"));

    let outside = tempfile::tempdir().expect("outside tempdir");
    let link = directory.path().join("linked.txt");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("outside.txt"), &link).expect("symlink");
    #[cfg(unix)]
    {
        fs::write(outside.path().join("outside.txt"), "outside\n").expect("outside file");
        assert!(show_in_file_manager(root, "linked.txt")
            .unwrap_err()
            .contains("Symlinked Git paths"));
    }
}

#[test]
fn file_manager_target_uses_existing_file_or_nearest_parent() {
    let directory = fixture();
    let root = std::fs::canonicalize(directory.path()).expect("canonical root");
    let existing = file_manager_target(&root, "tracked.txt").expect("existing target");
    assert_eq!(existing, root.join("tracked.txt"));

    let nested = directory.path().join("nested");
    fs::create_dir(&nested).expect("nested directory");
    let deleted = file_manager_target(&root, "nested/deleted.txt").expect("parent target");
    assert_eq!(deleted, std::fs::canonicalize(nested).unwrap());

    let missing_parent =
        file_manager_target(&root, "missing/deleted.txt").expect("repository root target");
    assert_eq!(missing_parent, root);
}

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
fn parses_renames_and_unicode_paths_without_shell_quoting() {
    let directory = fixture();
    fs::rename(
        directory.path().join("tracked.txt"),
        directory.path().join("renamed file-日本.txt"),
    )
    .expect("rename tracked file");
    run_fixture_git(directory.path(), &["add", "--all"]);

    let changes = list_changes(directory.path().to_str().unwrap()).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "renamed file-日本.txt");
    assert_eq!(changes[0].original_path.as_deref(), Some("tracked.txt"));
    assert_eq!(changes[0].status, "R");
}

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

#[test]
fn validates_deleted_paths_against_the_nearest_existing_ancestor() {
    let directory = fixture();
    fs::create_dir_all(directory.path().join("gone/nested")).expect("nested directory");
    fs::write(directory.path().join("gone/nested/file.txt"), "gone").expect("deleted file");
    fs::remove_dir_all(directory.path().join("gone")).expect("remove directory tree");

    let root = std::fs::canonicalize(directory.path()).expect("canonical root");
    validate_worktree_path(&root, "gone/nested/file.txt").unwrap();
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

use super::super::{
    path::{
        append_original_paths, changed_path_selection, file_manager_target, validate_worktree_path,
    },
    service::{discard_changes, list_changes, show_in_file_manager},
};
use super::common::{fixture, run_fixture_git};
use crate::models::GitFileChange;
use std::collections::HashSet;
use std::fs;
use std::time::Instant;

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
fn validates_deleted_paths_against_the_nearest_existing_ancestor() {
    let directory = fixture();
    fs::create_dir_all(directory.path().join("gone/nested")).expect("nested directory");
    fs::write(directory.path().join("gone/nested/file.txt"), "gone").expect("deleted file");
    fs::remove_dir_all(directory.path().join("gone")).expect("remove directory tree");

    let root = std::fs::canonicalize(directory.path()).expect("canonical root");
    validate_worktree_path(&root, "gone/nested/file.txt").unwrap();
}

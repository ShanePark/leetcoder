use std::fs;
use std::os::unix::fs as unix_fs;

use crate::models::{CreateProblemFileArgs, ProblemFileArgs};
use crate::security::SOURCE_ROOT;

use super::super::{
    create_problem_file, delete_problem_file, list_problem_files, save_problem_file,
    validate_project,
};
use super::fixture;

#[test]
fn list_skips_non_sources_and_symlink_entries_and_sorts_nested_files() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().into_owned();
    let easy = directory.path().join(SOURCE_ROOT).join("easy");
    let nested = easy.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(easy.join("Q2.java"), "class Q2 {}\n").unwrap();
    fs::write(easy.join("Q1.kt"), "class Q1\n").unwrap();
    fs::write(nested.join("Q3.JAVA"), "class Q3 {}\n").unwrap();
    fs::write(easy.join("ignored.txt"), "ignored\n").unwrap();
    fs::write(nested.join("ignored.class"), "ignored\n").unwrap();

    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("outside.java");
    fs::write(&outside_file, "outside\n").unwrap();
    unix_fs::symlink(&outside_file, easy.join("linked.java")).unwrap();
    unix_fs::symlink(outside.path(), easy.join("linked-directory")).unwrap();

    let files = list_problem_files(&root).unwrap().files;
    assert_eq!(
        files,
        vec![
            format!("{SOURCE_ROOT}/easy/Q1.kt"),
            format!("{SOURCE_ROOT}/easy/Q2.java"),
            format!("{SOURCE_ROOT}/easy/nested/Q3.JAVA"),
        ]
    );
}

#[test]
fn validation_reports_missing_repository_parts() {
    let directory = tempfile::tempdir().unwrap();
    let result = validate_project(directory.path().to_str().unwrap());
    assert!(!result.valid);
    assert!(result
        .missing_paths
        .iter()
        .any(|path| path == "build.gradle"));
    assert!(result
        .missing_paths
        .iter()
        .any(|path| path.ends_with("/easy")));
}

#[test]
fn create_is_new_only_and_save_requires_existing_file() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
    let created = create_problem_file(CreateProblemFileArgs {
        project_root: root.clone(),
        relative_path: relative_path.to_string(),
        content: "first".to_string(),
    })
    .unwrap();
    assert_eq!(created.content, "first");
    assert!(create_problem_file(CreateProblemFileArgs {
        project_root: root.clone(),
        relative_path: relative_path.to_string(),
        content: "second".to_string(),
    })
    .is_err());
    let saved = save_problem_file(CreateProblemFileArgs {
        project_root: root,
        relative_path: relative_path.to_string(),
        content: "second".to_string(),
    })
    .unwrap();
    assert_eq!(saved.content, "second");
    assert_eq!(
        fs::read_to_string(directory.path().join(relative_path)).unwrap(),
        "second"
    );
}

#[test]
fn atomic_save_leaves_no_temp_source_file() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
    let target = directory.path().join(relative_path);
    fs::write(&target, "before").unwrap();
    let parent = target.parent().unwrap();
    let before_entries = fs::read_dir(parent).unwrap().count();

    save_problem_file(CreateProblemFileArgs {
        project_root: root,
        relative_path: relative_path.to_string(),
        content: "after".to_string(),
    })
    .unwrap();

    assert_eq!(fs::read_to_string(&target).unwrap(), "after");
    assert_eq!(fs::read_dir(parent).unwrap().count(), before_entries);
}

#[test]
fn delete_removes_only_existing_problem_source_files() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
    fs::write(directory.path().join(relative_path), "class Q1 {}").unwrap();

    delete_problem_file(ProblemFileArgs {
        project_root: root.clone(),
        relative_path: relative_path.to_string(),
    })
    .unwrap();
    assert!(!directory.path().join(relative_path).exists());
    let error = delete_problem_file(ProblemFileArgs {
        project_root: root,
        relative_path: relative_path.to_string(),
    })
    .unwrap_err();
    assert!(error.contains("Unable to access") || error.contains("not a regular file"));
}

#[test]
fn delete_rejects_non_source_paths() {
    let directory = fixture();
    let error = delete_problem_file(ProblemFileArgs {
        project_root: directory.path().to_string_lossy().to_string(),
        relative_path: "build.gradle".to_string(),
    })
    .unwrap_err();
    assert!(error.contains("Only .java and .kt source files are allowed"));
}

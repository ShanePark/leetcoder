use std::fs;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use crate::models::ProblemFileList;
use crate::security::{all_package_directories, canonical_project_root, SOURCE_ROOT};

use super::super::{list_problem_files, read_problem_file};
use super::fixture;

#[test]
#[ignore = "manual performance benchmark"]
fn benchmark_repository_hot_paths() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().into_owned();
    let canonical_root = canonical_project_root(&root).unwrap();
    let package = directory.path().join(SOURCE_ROOT).join("easy");
    let target = package.join("Q500.java");
    fs::write(
        &target,
        "public class Q500 { int value() { return 500; } }\n",
    )
    .unwrap();
    for (segment, count) in [("easy", 600), ("medium", 1_361), ("xhard", 392)] {
        let package = directory.path().join(SOURCE_ROOT).join(segment);
        for index in 0..count {
            fs::write(
                package.join(format!("Q{index}.java")),
                format!("public class Q{index} {{}}\n"),
            )
            .unwrap();
        }
    }

    fn median_ns<F>(mut operation: F) -> u128
    where
        F: FnMut(),
    {
        for _ in 0..10 {
            operation();
        }
        let mut samples = Vec::with_capacity(30);
        for _ in 0..30 {
            let start = Instant::now();
            operation();
            samples.push(start.elapsed().as_nanos());
        }
        samples.sort_unstable();
        samples[samples.len() / 2]
    }

    fn baseline_collect_source_files(
        root: &Path,
        directory: &Path,
        files: &mut Vec<String>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("Unable to list '{}': {error}", directory.display()))?
        {
            let entry =
                entry.map_err(|error| format!("Unable to inspect directory entry: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Unable to inspect '{}': {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                baseline_collect_source_files(root, &path, files)?;
            } else if metadata.is_file() && crate::security::is_source_file(&path) {
                files.push(crate::security::relative_path(root, &path)?);
            }
        }
        Ok(())
    }

    fn baseline_list_problem_files(project_root: &str) -> ProblemFileList {
        let root = canonical_project_root(project_root).unwrap();
        let package_dirs = all_package_directories(&root).unwrap();
        let mut files = Vec::new();
        for package_dir in package_dirs {
            baseline_collect_source_files(&root, &package_dir, &mut files).unwrap();
        }
        files.sort();
        ProblemFileList { files }
    }

    let optimized_files = list_problem_files(&root).unwrap();
    let baseline_files = baseline_list_problem_files(&root);
    assert_eq!(optimized_files.files, baseline_files.files);

    let mut optimized_list_samples = Vec::with_capacity(30);
    let mut baseline_list_samples = Vec::with_capacity(30);
    for _ in 0..10 {
        black_box(list_problem_files(&root).unwrap());
        black_box(baseline_list_problem_files(&root));
    }
    for _ in 0..30 {
        let start = Instant::now();
        black_box(list_problem_files(black_box(&root)).unwrap());
        optimized_list_samples.push(start.elapsed().as_nanos());

        let start = Instant::now();
        black_box(baseline_list_problem_files(black_box(&root)));
        baseline_list_samples.push(start.elapsed().as_nanos());
    }
    optimized_list_samples.sort_unstable();
    baseline_list_samples.sort_unstable();
    let list_ns = optimized_list_samples[optimized_list_samples.len() / 2];
    let baseline_list_ns = baseline_list_samples[baseline_list_samples.len() / 2];
    let resolve_ns = median_ns(|| {
        black_box(
            crate::security::resolve_existing_source_file(
                black_box(&canonical_root),
                black_box("src/main/java/shane/leetcode/problems/easy/Q500.java"),
            )
            .unwrap(),
        );
    });
    let read_ns = median_ns(|| {
        black_box(
            read_problem_file(crate::models::ProblemFileArgs {
                project_root: root.clone(),
                relative_path: "src/main/java/shane/leetcode/problems/easy/Q500.java".to_string(),
            })
            .unwrap(),
        );
    });
    eprintln!(
            "repository benchmark median_ns list={list_ns} baseline_list={baseline_list_ns} resolve={resolve_ns} read={read_ns} files=2353"
        );
}

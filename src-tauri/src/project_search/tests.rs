use super::*;
use std::fs;

fn write(root: &Path, relative: &str, content: impl AsRef<[u8]>) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent directory")).expect("create parent");
    fs::write(path, content).expect("write fixture file");
}

#[test]
fn searches_text_files_across_source_config_and_documentation() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(directory.path(), "src/Main.java", "class Main { Needle }\n");
    write(directory.path(), "config/settings.toml", "needle = true\n");
    write(directory.path(), "README.md", "a needle in docs\n");
    write(directory.path(), ".git/config", "needle\n");
    write(
        directory.path(),
        "node_modules/package/index.js",
        "needle\n",
    );
    write(directory.path(), "target/generated.rs", "needle\n");
    write(directory.path(), "dist/app.js", "needle\n");
    write(directory.path(), "build/output.txt", "needle\n");
    write(directory.path(), "out/output.txt", "needle\n");
    write(directory.path(), ".gradle/cache.txt", "needle\n");
    write(directory.path(), ".next/server.js", "needle\n");
    write(directory.path(), ".turbo/cache.txt", "needle\n");
    write(directory.path(), "coverage/summary.txt", "needle\n");
    write(directory.path(), "assets/pixel.png", [0, 1, 2, 3]);
    write(directory.path(), "assets/unknown.data", [0, 1, 2, 3]);

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "needle",
        false,
        &[],
    )
    .expect("search succeeds");

    assert_eq!(
        result
            .matches
            .iter()
            .map(|found| found.path.as_str())
            .collect::<Vec<_>>(),
        ["README.md", "config/settings.toml", "src/Main.java"]
    );
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.skipped_files, 0);
}

#[test]
fn respects_case_sensitivity_and_returns_first_matching_line_per_file() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(
        directory.path(),
        "text.txt",
        "before\nNeedle NEEDLE needle\nneedle again\n",
    );
    write(directory.path(), "other.txt", "NEEDLE\n");
    let root = directory.path().to_str().expect("UTF-8 fixture path");

    let insensitive = search_project(root, "needle", false, &[]).expect("insensitive search");
    let sensitive = search_project(root, "needle", true, &[]).expect("sensitive search");

    assert_eq!(insensitive.matches.len(), 2);
    assert_eq!(insensitive.matches[0].path, "other.txt");
    assert_eq!(insensitive.matches[1].path, "text.txt");
    assert_eq!(insensitive.matches[1].line, 2);
    assert_eq!(sensitive.matches.len(), 1);
    assert_eq!(sensitive.matches[0].line, 2);
    assert_eq!(sensitive.matches[0].column, 15);
}

#[test]
fn reports_utf16_column_from_original_unicode_line() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(directory.path(), "text.txt", "😀İ Target\n");

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "target",
        false,
        &[],
    )
    .expect("search succeeds");

    assert_eq!(result.matches[0].column, 5);
    assert_eq!(result.matches[0].preview, "😀İ Target");
}

#[test]
fn bounds_previews_and_truncates_after_five_hundred_unique_files() {
    let directory = tempfile::tempdir().expect("temporary project");
    let line = format!("{}needle{}", "a".repeat(300), "b".repeat(300));
    for index in 0..MAX_MATCHES + 1 {
        write(
            directory.path(),
            &format!("files/match-{index:03}.txt"),
            format!("{line}\nneedle on a later line\n"),
        );
    }

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "needle",
        true,
        &[],
    )
    .expect("search succeeds");

    assert_eq!(result.matches.len(), MAX_MATCHES);
    assert!(result.truncated);
    assert!(result
        .matches
        .iter()
        .all(|found| found.preview.chars().count() <= 242));
    assert!(result.matches[0].preview.contains("needle"));
    assert!(result.matches.iter().all(|found| found.line == 1));
    assert_eq!(result.matches[0].path, "files/match-000.txt");
    assert_eq!(result.matches[MAX_MATCHES - 1].path, "files/match-499.txt");
    assert_eq!(
        result
            .matches
            .iter()
            .map(|found| found.path.as_str())
            .collect::<HashSet<_>>()
            .len(),
        MAX_MATCHES
    );
}

#[test]
fn excludes_supplied_paths_before_reading_and_before_the_file_cap() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(
        directory.path(),
        "files/000-oversized.txt",
        format!("needle{}", " ".repeat(MAX_FILE_BYTES)),
    );
    for index in 0..MAX_MATCHES + 3 {
        write(
            directory.path(),
            &format!("files/match-{index:03}.txt"),
            "needle\n",
        );
    }
    let excluded = vec![
        "files/000-oversized.txt".to_string(),
        "files/match-000.txt".to_string(),
        "files/match-001.txt".to_string(),
    ];

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "needle",
        true,
        &excluded,
    )
    .expect("search succeeds");

    assert_eq!(result.matches.len(), MAX_MATCHES);
    assert!(result.truncated);
    assert_eq!(result.matches[0].path, "files/match-002.txt");
    assert_eq!(result.skipped_files, 0);
}

#[test]
fn counts_oversize_text_but_not_binary_candidates() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(
        directory.path(),
        "large.txt",
        format!("needle{}", " ".repeat(MAX_FILE_BYTES)),
    );
    let mut binary = vec![b'x'; MAX_FILE_BYTES + 1];
    binary[0] = 0;
    write(directory.path(), "large.bin", binary);

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "needle",
        true,
        &[],
    )
    .expect("search succeeds");

    assert!(result.matches.is_empty());
    assert_eq!(result.skipped_files, 1);
}

#[cfg(unix)]
#[test]
fn skips_file_and_directory_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary project");
    let outside = tempfile::tempdir().expect("outside directory");
    write(outside.path(), "outside.txt", "needle\n");
    symlink(
        outside.path().join("outside.txt"),
        directory.path().join("linked.txt"),
    )
    .expect("file symlink");
    symlink(outside.path(), directory.path().join("linked-directory")).expect("directory symlink");
    write(directory.path(), "inside.txt", "needle\n");

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "needle",
        true,
        &[],
    )
    .expect("search succeeds");

    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].path, "inside.txt");
}

#[test]
fn empty_query_returns_no_matches() {
    let directory = tempfile::tempdir().expect("temporary project");
    write(directory.path(), "text.txt", "needle\n");

    let result = search_project(
        directory.path().to_str().expect("UTF-8 fixture path"),
        "",
        false,
        &[],
    )
    .expect("search succeeds");

    assert!(result.matches.is_empty());
    assert!(!result.truncated);
    assert_eq!(result.skipped_files, 0);
}

#[test]
fn rejects_invalid_project_paths() {
    assert!(search_project("/path/that/does/not/exist", "needle", false, &[]).is_err());
}

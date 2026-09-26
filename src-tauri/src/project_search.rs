use crate::models::{ProjectSearchMatch, ProjectSearchResult};
use crate::security::{canonical_project_root, is_within, relative_path};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const MAX_FILE_BYTES: usize = 1024 * 1024;
const PREFIX_SNIFF_BYTES: usize = 8192;
const MAX_MATCHES: usize = 500;
const MAX_PREVIEW_CHARS: usize = 240;

const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".gradle",
    ".next",
    ".turbo",
    "coverage",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "7z", "a", "avi", "bin", "bmp", "class", "dylib", "eot", "exe", "flac", "gif", "gz", "ico",
    "icns", "jar", "jpeg", "jpg", "keystore", "m4a", "mkv", "mov", "mp3", "mp4", "o", "otf", "pdf",
    "png", "so", "sqlite", "sqlite3", "tar", "ttf", "wasm", "webm", "webp", "woff", "woff2", "xcf",
    "xz", "zip",
];

/// Search saved repository text on demand without building a persistent index.
pub(crate) fn search_project(
    project_root: &str,
    query: &str,
    case_sensitive: bool,
    exclude_paths: &[String],
) -> Result<ProjectSearchResult, String> {
    let root = canonical_project_root(project_root)?;
    let mut result = ProjectSearchResult {
        matches: Vec::new(),
        truncated: false,
        skipped_files: 0,
    };
    if query.is_empty() {
        return Ok(result);
    }

    let folded_query = (!case_sensitive).then(|| query.to_lowercase());
    let excluded_paths = exclude_paths.iter().cloned().collect::<HashSet<_>>();
    let mut directories = vec![root.clone()];

    'walk: while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => {
                return Err(format!(
                    "Unable to search projectRoot '{}': {error}",
                    root.display()
                ))
            }
            Err(_) => continue,
        };
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());

        let mut child_directories = Vec::new();
        for entry in entries {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };

            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name();
                if name
                    .to_str()
                    .is_some_and(|name| EXCLUDED_DIRECTORIES.contains(&name))
                {
                    continue;
                }
                let Ok(canonical) = fs::canonicalize(&path) else {
                    continue;
                };
                if is_within(&root, &canonical) {
                    child_directories.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            scan_file(
                &root,
                &path,
                query,
                folded_query.as_deref(),
                case_sensitive,
                &excluded_paths,
                &mut result,
            );
            if result.truncated {
                break 'walk;
            }
        }

        // Stack traversal visits sibling directories in lexical order.
        child_directories.reverse();
        directories.extend(child_directories);
    }

    result.matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(result)
}

fn scan_file(
    root: &Path,
    path: &Path,
    query: &str,
    folded_query: Option<&str>,
    case_sensitive: bool,
    excluded_paths: &HashSet<String>,
    result: &mut ProjectSearchResult,
) {
    let Ok(relative) = relative_path(root, path) else {
        return;
    };
    if excluded_paths.contains(&relative) {
        return;
    }
    if is_known_binary(path) {
        return;
    }

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
        Ok(_) => return,
        Err(_) => {
            result.skipped_files += 1;
            return;
        }
    };
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) if is_within(root, &canonical) => canonical,
        _ => return,
    };

    if metadata.len() > MAX_FILE_BYTES as u64 {
        match read_prefix(&canonical) {
            Ok(prefix) if looks_like_text(&prefix) => result.skipped_files += 1,
            Err(_) => result.skipped_files += 1,
            _ => {}
        }
        return;
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    let read_result = File::open(&canonical)
        .and_then(|file| file.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes));
    if read_result.is_err() {
        result.skipped_files += 1;
        return;
    }
    if bytes.len() > MAX_FILE_BYTES {
        if looks_like_text(&bytes[..PREFIX_SNIFF_BYTES.min(bytes.len())]) {
            result.skipped_files += 1;
        }
        return;
    }
    if bytes.contains(&0) {
        return;
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return;
    };

    for (line_index, line) in content.lines().enumerate() {
        let Some(byte_offset) = find_match(line, query, folded_query, case_sensitive) else {
            continue;
        };
        if result.matches.len() == MAX_MATCHES {
            result.truncated = true;
            break;
        }
        let column = line[..byte_offset].encode_utf16().count() + 1;
        result.matches.push(ProjectSearchMatch {
            path: relative.clone(),
            line: line_index + 1,
            column,
            preview: preview_around(line, byte_offset),
        });
        return;
    }
}

fn find_match(
    line: &str,
    query: &str,
    folded_query: Option<&str>,
    case_sensitive: bool,
) -> Option<usize> {
    if case_sensitive {
        return line.find(query);
    }

    let folded_line = line.to_lowercase();
    let folded_query = folded_query?;
    let folded_offset = folded_line.find(folded_query)?;

    let mut folded_bytes = 0;
    for (original_offset, character) in line.char_indices() {
        let folded_character_bytes = character.to_lowercase().map(char::len_utf8).sum::<usize>();
        if folded_offset < folded_bytes + folded_character_bytes {
            return Some(original_offset);
        }
        folded_bytes += folded_character_bytes;
    }
    Some(line.len())
}

fn preview_around(line: &str, byte_offset: usize) -> String {
    let match_character = line[..byte_offset].chars().count();
    let line_characters = line.chars().count();
    if line_characters <= MAX_PREVIEW_CHARS {
        return line.to_string();
    }

    let max_start = line_characters - MAX_PREVIEW_CHARS;
    let start = match_character.saturating_sub(80).min(max_start);
    let end = (start + MAX_PREVIEW_CHARS).min(line_characters);
    let mut preview = String::new();
    if start > 0 {
        preview.push('…');
    }
    preview.extend(line.chars().skip(start).take(end - start));
    if end < line_characters {
        preview.push('…');
    }
    preview
}

fn read_prefix(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut prefix = Vec::with_capacity(PREFIX_SNIFF_BYTES);
    File::open(path)?
        .take(PREFIX_SNIFF_BYTES as u64)
        .read_to_end(&mut prefix)?;
    Ok(prefix)
}

fn looks_like_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).is_ok()
        }
        Err(_) => false,
    }
}

fn is_known_binary(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BINARY_EXTENSIONS
                .iter()
                .any(|binary| extension.eq_ignore_ascii_case(binary))
        })
}

#[cfg(test)]
mod tests {
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
        symlink(outside.path(), directory.path().join("linked-directory"))
            .expect("directory symlink");
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
}

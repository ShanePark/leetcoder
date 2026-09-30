use std::fs;
use std::io;
use std::path::Path;

use crate::models::{ProblemFileArgs, ProblemFileContent};
use crate::security::{canonical_project_root, relative_path, resolve_existing_source_file};

use super::atomic::{sync_directory, write_source_noclobber};
use super::duplicate;
use super::source_names::{replace_source_identifiers, source_name_parts};

/// Duplicate a source file next to the original using the first available
/// numeric suffix (`Name2.java`, `Name3.java`, ...). Java implementations are
/// cleared while test and helper signatures remain; Kotlin files are copied.
pub(crate) fn duplicate_problem_file(args: ProblemFileArgs) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (source_path, canonical_source) = resolve_existing_source_file(&root, &args.relative_path)?;
    let source_content = fs::read_to_string(&canonical_source)
        .map_err(|error| format!("Unable to read '{}': {error}", args.relative_path))?;
    let source_parent = source_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory: {}",
            args.relative_path
        )
    })?;
    let (source_stem, extension) = source_name_parts(&source_path)?;
    let existing_stems = source_stems_in_directory(source_parent).map_err(|error| {
        format!(
            "Unable to inspect directory for '{}': {error}",
            args.relative_path
        )
    })?;
    let family_stem = duplicate_family_stem(&source_stem, &existing_stems);
    let permissions = fs::metadata(&canonical_source)
        .map_err(|error| format!("Unable to inspect '{}': {error}", args.relative_path))?
        .permissions();
    let source_template = if extension.eq_ignore_ascii_case(".java") {
        duplicate::reset_java_implementation(&source_content)
    } else {
        source_content.clone()
    };

    let mut suffix = 2u64;
    loop {
        let candidate_stem = format!("{family_stem}{suffix}");
        let candidate_name = format!("{candidate_stem}{extension}");
        let candidate_path = source_parent.join(candidate_name);

        // Java and Kotlin sources in the same package share the class-name
        // namespace, even though their file extensions differ.
        if existing_stems
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&candidate_stem))
        {
            suffix = suffix.saturating_add(1);
            continue;
        }

        // The listing above handles known Java/Kotlin collisions, while
        // noclobber makes the operation safe if another editor creates the
        // same candidate after that listing.
        let duplicate_content =
            replace_source_identifiers(&source_template, &source_stem, &candidate_stem);
        match write_source_noclobber(
            &candidate_path,
            source_parent,
            &duplicate_content,
            &permissions,
        ) {
            Ok(()) => {
                sync_directory(source_parent).map_err(|error| {
                    format!(
                        "File '{}' was duplicated, but its directory could not be synchronized: {error}",
                        args.relative_path
                    )
                })?;
                return Ok(ProblemFileContent {
                    relative_path: relative_path(&root, &candidate_path)?,
                    content: duplicate_content,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                suffix = suffix.saturating_add(1);
            }
            Err(error) => {
                return Err(format!(
                    "Unable to duplicate '{}': {error}",
                    args.relative_path
                ));
            }
        }
    }
}

fn source_stems_in_directory(directory: &Path) -> io::Result<Vec<String>> {
    let mut stems = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if !file_type.is_file() || !crate::security::is_source_file(&path) {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            stems.push(stem.to_string());
        }
    }
    Ok(stems)
}

fn duplicate_family_stem(source_stem: &str, existing_stems: &[String]) -> String {
    let mut split_at = source_stem.len();
    for (index, character) in source_stem.char_indices().rev() {
        if character.is_ascii_digit() {
            split_at = index;
        } else {
            break;
        }
    }
    if split_at == source_stem.len() || split_at == 0 {
        return source_stem.to_string();
    }
    // The first numeric suffix is part of a problem name in many LeetCode
    // classes (for example Q3Sum), so only strip it when the unsuffixed family
    // already exists and the suffix follows the duplicate convention.
    let base = &source_stem[..split_at];
    let suffix = &source_stem[split_at..];
    let Ok(suffix_number) = suffix.parse::<u64>() else {
        return source_stem.to_string();
    };
    if suffix.starts_with('0') || suffix_number < 2 {
        return source_stem.to_string();
    }
    if existing_stems
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(base))
    {
        base.to_string()
    } else {
        source_stem.to_string()
    }
}

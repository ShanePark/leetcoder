use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;

use crate::models::{
    CreateProblemFileArgs, ProblemFileArgs, ProblemFileContent, ProblemFileList, ProjectValidation,
    RenameProblemFileArgs,
};
use crate::security::{
    all_package_directories, canonical_project_root, relative_path, resolve_existing_source_file,
    resolve_new_source_file, PACKAGE_SEGMENTS, SOURCE_ROOT,
};

const REQUIRED_FILES: [&str; 3] = ["build.gradle", "settings.gradle", "gradlew"];

pub(crate) fn validate_project(project_root: &str) -> ProjectValidation {
    let requested_root = project_root.trim().to_string();
    let mut missing_paths = Vec::new();
    let mut errors = Vec::new();

    let root = match canonical_project_root(project_root) {
        Ok(root) => root,
        Err(error) => {
            if !requested_root.is_empty() && !Path::new(&requested_root).exists() {
                missing_paths.push("projectRoot".to_string());
            }
            errors.push(error.clone());
            return ProjectValidation {
                valid: false,
                project_root: requested_root,
                missing_paths,
                errors,
                message: Some(error),
            };
        }
    };

    for required_file in REQUIRED_FILES {
        let path = root.join(required_file);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => errors.push(format!(
                "Required path is not a regular file: {required_file}"
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_paths.push(required_file.to_string())
            }
            Err(error) => errors.push(format!("Unable to inspect {required_file}: {error}")),
        }
    }

    let source_root = root.join(SOURCE_ROOT);
    match fs::symlink_metadata(&source_root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => errors.push(format!("Required path is not a directory: {SOURCE_ROOT}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            missing_paths.push(SOURCE_ROOT.to_string())
        }
        Err(error) => errors.push(format!("Unable to inspect {SOURCE_ROOT}: {error}")),
    }

    for segment in PACKAGE_SEGMENTS {
        let relative = format!("{SOURCE_ROOT}/{segment}");
        let path = root.join(&relative);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                if metadata.file_type().is_symlink() {
                    errors.push(format!(
                        "Symlinked package directory is not allowed: {relative}"
                    ));
                } else if let Ok(canonical) = fs::canonicalize(&path) {
                    if !crate::security::is_within(&root, &canonical) {
                        errors.push(format!("Package directory escapes projectRoot: {relative}"));
                    }
                }
            }
            Ok(_) => errors.push(format!("Required path is not a directory: {relative}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_paths.push(relative)
            }
            Err(error) => errors.push(format!("Unable to inspect {relative}: {error}")),
        }
    }

    let message = if missing_paths.is_empty() && errors.is_empty() {
        None
    } else {
        let mut details = missing_paths.clone();
        details.extend(errors.clone());
        Some(details.join("; "))
    };
    ProjectValidation {
        valid: missing_paths.is_empty() && errors.is_empty(),
        project_root: root.to_string_lossy().into_owned(),
        missing_paths,
        errors,
        message,
    }
}

pub(crate) fn list_problem_files(project_root: &str) -> Result<ProblemFileList, String> {
    let root = canonical_project_root(project_root)?;
    let package_dirs = all_package_directories(&root)?;
    let mut files = Vec::new();

    for package_dir in package_dirs {
        collect_source_files(&root, &package_dir, &mut files)?;
    }
    files.sort();
    Ok(ProblemFileList { files })
}

fn collect_source_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Unable to list '{}': {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect directory entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Unable to inspect '{}': {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_source_files(root, &path, files)?;
        } else if metadata.is_file() && crate::security::is_source_file(&path) {
            files.push(relative_path(root, &path)?);
        }
    }
    Ok(())
}

pub(crate) fn read_problem_file(args: ProblemFileArgs) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    let content = fs::read_to_string(&canonical)
        .map_err(|error| format!("Unable to read '{}': {error}", args.relative_path))?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &lexical)?,
        content,
    })
}

pub(crate) fn create_problem_file(
    args: CreateProblemFileArgs,
) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (path, canonical_parent) = resolve_new_source_file(&root, &args.relative_path)?;
    let mut temporary = NamedTempFile::new_in(&canonical_parent).map_err(|error| {
        format!(
            "Unable to create a temporary file for '{}': {error}",
            args.relative_path
        )
    })?;
    temporary
        .write_all(args.content.as_bytes())
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Unable to prepare '{}': {error}", args.relative_path))?;
    temporary
        .persist_noclobber(&path)
        .map_err(|error| format!("Unable to create '{}': {}", args.relative_path, error.error))?;
    sync_directory(&canonical_parent).map_err(|error| {
        format!(
            "File '{}' was created, but its directory could not be synchronized: {error}",
            args.relative_path
        )
    })?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &path)?,
        content: args.content,
    })
}

pub(crate) fn save_problem_file(args: CreateProblemFileArgs) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    let canonical_parent = canonical.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory: {}",
            args.relative_path
        )
    })?;
    let existing_permissions = fs::metadata(&canonical)
        .map_err(|error| format!("Unable to inspect '{}': {error}", args.relative_path))?
        .permissions();
    let mut temporary = NamedTempFile::new_in(canonical_parent).map_err(|error| {
        format!(
            "Unable to create a temporary file for '{}': {error}",
            args.relative_path
        )
    })?;
    temporary
        .as_file()
        .set_permissions(existing_permissions)
        .and_then(|_| temporary.write_all(args.content.as_bytes()))
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Unable to prepare '{}': {error}", args.relative_path))?;
    temporary
        .persist(&canonical)
        .map_err(|error| format!("Unable to save '{}': {}", args.relative_path, error.error))?;
    sync_directory(canonical_parent).map_err(|error| {
        format!(
            "File '{}' was saved, but its directory could not be synchronized: {error}",
            args.relative_path
        )
    })?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &lexical)?,
        content: args.content,
    })
}

pub(crate) fn delete_problem_file(args: ProblemFileArgs) -> Result<(), String> {
    let root = canonical_project_root(&args.project_root)?;
    let (_lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    fs::remove_file(&canonical)
        .map_err(|error| format!("Unable to delete '{}': {error}", args.relative_path))?;
    let canonical_parent = canonical.parent().ok_or_else(|| {
        format!(
            "File '{}' was deleted, but its parent directory could not be determined",
            args.relative_path
        )
    })?;
    // The directory sync improves durability on Unix, but the file has
    // already been removed successfully. Keep deletion successful if the
    // filesystem cannot sync the parent (for example, on a special volume).
    let _ = sync_directory(canonical_parent);
    Ok(())
}

/// Duplicate a source file next to the original using the first available
/// numeric suffix (`Name2.java`, `Name3.java`, ...).  The source's top-level
/// type name is updated in the copy so a public Java class remains compilable.
/// Kotlin files are handled in the same way because the repository browser
/// deliberately includes them when checking name collisions.
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
        match write_source_noclobber(
            &candidate_path,
            source_parent,
            &replace_source_identifiers(&source_content, &source_stem, &candidate_stem),
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
                    content: replace_source_identifiers(
                        &source_content,
                        &source_stem,
                        &candidate_stem,
                    ),
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

/// Rename a source file while keeping it in the same problem package
/// directory.  A bare name is accepted and inherits the source extension;
/// callers may also pass a repository-relative path, but moving files between
/// directories is intentionally rejected.  Java/Kotlin identifiers in the
/// source are updated outside comments and string/character literals.
pub(crate) fn rename_problem_file(
    args: RenameProblemFileArgs,
) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (source_path, canonical_source) = resolve_existing_source_file(&root, &args.relative_path)?;
    let source_parent = source_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory: {}",
            args.relative_path
        )
    })?;
    let canonical_source_parent = canonical_source.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory: {}",
            args.relative_path
        )
    })?;
    let (source_stem, source_extension) = source_name_parts(&source_path)?;
    let source_relative = relative_path(&root, &source_path)?;
    let destination_relative =
        rename_destination_path(&source_relative, &args.new_relative_path, &source_extension)?;
    let (destination_path, canonical_destination_parent) =
        resolve_new_source_file(&root, &destination_relative.to_string_lossy())?;
    let destination_parent = destination_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine destination directory: {}",
            destination_relative.display()
        )
    })?;
    if destination_parent != source_parent
        || canonical_destination_parent != canonical_source_parent
    {
        return Err("A file can only be renamed within its existing directory".to_string());
    }
    if destination_path == source_path {
        return Err("The new file name must be different from the current name".to_string());
    }
    let (destination_stem, destination_extension) = source_name_parts(&destination_path)?;
    if !source_extension.eq_ignore_ascii_case(&destination_extension) {
        return Err("A file's extension cannot be changed while renaming".to_string());
    }

    let source_content = fs::read_to_string(&canonical_source)
        .map_err(|error| format!("Unable to read '{}': {error}", args.relative_path))?;
    let renamed_content =
        replace_source_identifiers(&source_content, &source_stem, &destination_stem);
    let permissions = fs::metadata(&canonical_source)
        .map_err(|error| format!("Unable to inspect '{}': {error}", args.relative_path))?
        .permissions();

    write_source_noclobber(
        &destination_path,
        destination_parent,
        &renamed_content,
        &permissions,
    )
    .map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            format!("File already exists: {}", destination_relative.display())
        } else {
            format!(
                "Unable to rename '{}' to '{}': {error}",
                args.relative_path,
                destination_relative.display()
            )
        }
    })?;

    // Remove the lexical source path only after the destination has been
    // durably created.  If removal fails, roll back the destination created by
    // this operation so a failed rename does not leave an accidental duplicate.
    if let Err(error) = fs::remove_file(&source_path) {
        let _ = fs::remove_file(&destination_path);
        return Err(format!(
            "Unable to remove original file '{}' after preparing rename: {error}",
            args.relative_path
        ));
    }
    sync_directory(destination_parent).map_err(|error| {
        format!(
            "File '{}' was renamed, but its directory could not be synchronized: {error}",
            args.relative_path
        )
    })?;

    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &destination_path)?,
        content: renamed_content,
    })
}

fn source_name_parts(path: &Path) -> Result<(String, String), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Source file name is not valid UTF-8: {}", path.display()))?;
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("Source file name has no usable stem: {file_name}"))?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .ok_or_else(|| format!("Source file has no usable extension: {file_name}"))?;
    Ok((stem.to_string(), format!(".{extension}")))
}

fn source_stems_in_directory(directory: &Path) -> io::Result<Vec<String>> {
    let mut stems = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || !crate::security::is_source_file(&path) {
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

fn rename_destination_path(
    source_relative: &str,
    requested: &str,
    source_extension: &str,
) -> Result<PathBuf, String> {
    let input = requested.trim();
    if input.is_empty() {
        return Err("newPath must not be empty".to_string());
    }
    let requested_path = Path::new(input);
    let requested_name = requested_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or_else(|| "newPath must identify a file name".to_string())?;
    let requested_name = if requested_path.extension().is_none() {
        format!("{requested_name}{source_extension}")
    } else {
        requested_name.to_string()
    };

    let mut relative = PathBuf::from(source_relative);
    if requested_path.components().count() == 1 {
        relative.set_file_name(requested_name);
    } else {
        relative = requested_path.to_path_buf();
        relative.set_file_name(requested_name);
    }
    let relative = crate::security::validate_relative_path(&relative.to_string_lossy())?;
    Ok(relative)
}

fn write_source_noclobber(
    destination: &Path,
    parent: &Path,
    content: &str,
    permissions: &fs::Permissions,
) -> io::Result<()> {
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.as_file().set_permissions(permissions.clone())?;
    temporary.write_all(content.as_bytes())?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(destination)
        .map_err(|error| error.error)
        .map(|_| ())
}

fn replace_source_identifiers(source: &str, old: &str, new: &str) -> String {
    if old == new || !is_java_identifier(old) || !is_java_identifier(new) {
        return source.to_string();
    }

    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len() + new.len().saturating_sub(old.len()));
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            let end = source[index..]
                .find('\n')
                .map(|offset| index + offset)
                .unwrap_or(source.len());
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            let end = source[index + 2..]
                .find("*/")
                .map(|offset| index + 2 + offset + 2)
                .unwrap_or(source.len());
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'"' {
            let end = skip_quoted_literal(source, index, b'"');
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if bytes[index] == b'\'' {
            let end = skip_quoted_literal(source, index, b'\'');
            output.push_str(&source[index..end]);
            index = end;
            continue;
        }

        let Some(character) = source[index..].chars().next() else {
            break;
        };
        if is_java_identifier_start(character) {
            let start = index;
            index += character.len_utf8();
            while index < source.len() {
                let Some(next) = source[index..].chars().next() else {
                    break;
                };
                if !is_java_identifier_part(next) {
                    break;
                }
                index += next.len_utf8();
            }
            let token = &source[start..index];
            if token == old {
                output.push_str(new);
            } else {
                output.push_str(token);
            }
            continue;
        }

        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn skip_quoted_literal(source: &str, start: usize, delimiter: u8) -> usize {
    let bytes = source.as_bytes();
    let text_block = delimiter == b'"'
        && start + 2 < bytes.len()
        && bytes[start + 1] == b'"'
        && bytes[start + 2] == b'"';
    let mut index = if text_block { start + 3 } else { start + 1 };
    while index < bytes.len() {
        if text_block {
            if index + 2 < bytes.len()
                && bytes[index] == b'"'
                && bytes[index + 1] == b'"'
                && bytes[index + 2] == b'"'
            {
                return index + 3;
            }
            index += source[index..]
                .chars()
                .next()
                .map(|character| character.len_utf8())
                .unwrap_or(1);
            continue;
        }
        if bytes[index] == b'\\' {
            index += 1;
            if index < bytes.len() {
                index += source[index..]
                    .chars()
                    .next()
                    .map(|character| character.len_utf8())
                    .unwrap_or(1);
            }
            continue;
        }
        if bytes[index] == delimiter {
            return index + 1;
        }
        index += source[index..]
            .chars()
            .next()
            .map(|character| character.len_utf8())
            .unwrap_or(1);
    }
    source.len()
}

fn is_java_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    is_java_identifier_start(first) && characters.all(is_java_identifier_part)
}

fn is_java_identifier_start(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphabetic()
}

fn is_java_identifier_part(character: char) -> bool {
    is_java_identifier_start(character) || character.is_numeric()
}

fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::PACKAGE_SEGMENTS;

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("tempdir");
        for segment in PACKAGE_SEGMENTS {
            fs::create_dir_all(directory.path().join(SOURCE_ROOT).join(segment))
                .expect("package directory");
        }
        for file in REQUIRED_FILES {
            std::fs::File::create(directory.path().join(file)).expect("required file");
        }
        directory
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

    #[test]
    fn duplicate_uses_next_available_suffix_and_updates_java_type_name() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let package = directory.path().join(SOURCE_ROOT).join("easy");
        let stem = "Q2904ShortestAndLexicographicallySmallestBeautifulString";
        let source_path = package.join(format!("{stem}.java"));
        let source = format!(
            "package shane.leetcode.problems.easy;\n\n// {stem}\npublic class {stem} {{\n    private final String label = \"{stem}\";\n    {stem}() {{}}\n    {stem} copy() {{ return new {stem}(); }}\n}}\n"
        );
        fs::write(&source_path, &source).unwrap();
        fs::write(
            package.join(format!("{stem}2.java")),
            "class Existing2 {}\n",
        )
        .unwrap();
        fs::write(
            package.join(format!("{stem}3.java")),
            "class Existing3 {}\n",
        )
        .unwrap();
        // Kotlin names participate in collision detection too.
        fs::write(package.join(format!("{stem}5.kt")), "class Existing5\n").unwrap();

        let duplicate = duplicate_problem_file(ProblemFileArgs {
            project_root: root.clone(),
            relative_path: format!("{SOURCE_ROOT}/easy/{stem}.java"),
        })
        .unwrap();
        let expected_path = format!("{SOURCE_ROOT}/easy/{stem}4.java");
        let expected_stem = format!("{stem}4");
        assert_eq!(duplicate.relative_path, expected_path);
        assert_eq!(
            duplicate.content,
            fs::read_to_string(directory.path().join(&expected_path)).unwrap()
        );
        assert!(duplicate
            .content
            .contains(&format!("public class {expected_stem}")));
        assert!(duplicate.content.contains(&format!("{expected_stem}()")));
        assert!(duplicate
            .content
            .contains(&format!("new {expected_stem}()")));
        assert!(duplicate.content.contains(&format!("// {stem}")));
        assert!(duplicate.content.contains(&format!("= \"{stem}\"")));

        // Duplicating an already suffixed copy continues the same family,
        // rather than producing a surprising `...4...4.java` name.
        let second = duplicate_problem_file(ProblemFileArgs {
            project_root: root,
            relative_path: expected_path,
        })
        .unwrap();
        assert_eq!(
            second.relative_path,
            format!("{SOURCE_ROOT}/easy/{stem}6.java")
        );
        assert!(second.content.contains(&format!("public class {stem}6")));
    }

    #[test]
    fn rename_updates_type_references_and_preserves_literals_and_comments() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let package = directory.path().join(SOURCE_ROOT).join("easy");
        let source_path = package.join("Q1.java");
        fs::write(
            &source_path,
            "package shane.leetcode.problems.easy;\n// Q1 should remain in this comment\npublic class Q1 {\n    String label = \"Q1\";\n    Q1() {}\n    Q1 copy() { return new Q1(); }\n}\n",
        )
        .unwrap();

        let renamed = rename_problem_file(RenameProblemFileArgs {
            project_root: root,
            relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
            new_relative_path: "Q1Renamed".to_string(),
        })
        .unwrap();
        assert_eq!(
            renamed.relative_path,
            format!("{SOURCE_ROOT}/easy/Q1Renamed.java")
        );
        assert!(!source_path.exists());
        assert!(package.join("Q1Renamed.java").exists());
        assert!(renamed.content.contains("public class Q1Renamed"));
        assert!(renamed.content.contains("Q1Renamed()"));
        assert!(renamed.content.contains("new Q1Renamed()"));
        assert!(renamed
            .content
            .contains("// Q1 should remain in this comment"));
        assert!(renamed.content.contains("= \"Q1\""));
    }

    #[test]
    fn rename_rejects_collisions_and_cross_directory_moves_without_mutating_source() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let easy = directory.path().join(SOURCE_ROOT).join("easy");
        let medium = directory.path().join(SOURCE_ROOT).join("medium");
        fs::write(easy.join("Q1.java"), "public class Q1 {}\n").unwrap();
        fs::write(easy.join("Q2.java"), "public class Q2 {}\n").unwrap();

        let collision = rename_problem_file(RenameProblemFileArgs {
            project_root: root.clone(),
            relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
            new_relative_path: "Q2.java".to_string(),
        })
        .unwrap_err();
        assert!(collision.contains("already exists"));
        assert!(easy.join("Q1.java").exists());

        let outside_package = rename_problem_file(RenameProblemFileArgs {
            project_root: root,
            relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
            new_relative_path: format!("{SOURCE_ROOT}/medium/Q1.java"),
        })
        .unwrap_err();
        assert!(outside_package.contains("existing directory"));
        assert_eq!(
            fs::read_to_string(easy.join("Q1.java")).unwrap(),
            "public class Q1 {}\n"
        );
        assert!(!medium.join("Q1.java").exists());
    }

    #[test]
    fn identifier_replacement_ignores_comments_strings_and_character_literals() {
        let source =
            "class Old { String text = \"Old\"; char c = 'O'; /* Old */ Old value; }\n// Old\n";
        let replaced = replace_source_identifiers(source, "Old", "New");
        assert_eq!(
            replaced,
            "class New { String text = \"Old\"; char c = 'O'; /* Old */ New value; }\n// Old\n"
        );
    }
}

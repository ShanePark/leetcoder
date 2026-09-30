use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::models::{ProblemFileContent, RenameProblemFileArgs};
use crate::security::{
    canonical_project_root, relative_path, resolve_existing_source_file, resolve_new_source_file,
};

use super::atomic::{sync_directory, write_source_noclobber};
use super::source_names::{replace_source_identifiers, source_name_parts};

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

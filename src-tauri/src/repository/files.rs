use std::fs;
use std::io::Write;
use std::path::Path;

use tempfile::NamedTempFile;

use crate::models::{CreateProblemFileArgs, ProblemFileArgs, ProblemFileContent, ProblemFileList};
use crate::security::{
    all_package_directories, canonical_project_root, relative_path, resolve_existing_source_file,
    resolve_new_source_file,
};

use super::atomic::sync_directory;

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
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect '{}': {error}", path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_source_files(root, &path, files)?;
        } else if file_type.is_file() && crate::security::is_source_file(&path) {
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

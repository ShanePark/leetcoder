use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use super::process::{git_pathspec, require_success, run_git, utf8_stdout};
use super::status::{git_path_string, list_changes_at_root};
use crate::models::GitFileChange;
use crate::security::{canonical_project_root, is_within, validate_git_relative_path};

pub(crate) struct ChangedPathSelection {
    pub(crate) selected_paths: Vec<String>,
    pub(crate) command_paths: Vec<String>,
    pub(crate) changes: Vec<GitFileChange>,
}

/// Validate a Git path before any command or filesystem mutation.  In
/// addition to the existing canonical-boundary check, reject symlinked path
/// components so an operation cannot be redirected outside the repository by
/// a link created after the row was listed.
pub(crate) fn validate_git_operation_path(root: &Path, path: &str) -> Result<String, String> {
    let relative = validate_git_relative_path(path)?;
    let normalized = git_path_string(&relative);
    validate_git_path_components(root, &normalized)?;
    validate_worktree_path(root, &normalized)?;
    Ok(normalized)
}

pub(crate) fn validate_git_path_components(root: &Path, path: &str) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in Path::new(path).components() {
        let Component::Normal(value) = component else {
            continue;
        };
        current.push(value);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("Symlinked Git paths are not allowed: {path}"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(format!("Unable to inspect Git path '{path}': {error}"));
            }
        }
    }
    Ok(())
}

pub(crate) fn remove_from_index(root: &Path, path: &str) -> Result<(), String> {
    let args = [
        "rm".to_string(),
        "--cached".to_string(),
        "--ignore-unmatch".to_string(),
        "-f".to_string(),
        "--".to_string(),
        git_pathspec(path),
    ];
    let output = run_git(root, args.iter())?;
    require_success("Git index cleanup", output).map(|_| ())
}

pub(crate) fn remove_worktree_file(root: &Path, path: &str) -> Result<(), String> {
    validate_git_operation_path(root, path)?;
    let lexical = root.join(path);
    let metadata = match std::fs::symlink_metadata(&lexical) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Unable to inspect Git path '{path}': {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("Symlinked Git paths are not allowed: {path}"));
    }
    if !metadata.is_file() {
        return Err(format!("Git path is not a regular file: {path}"));
    }
    std::fs::remove_file(&lexical)
        .map_err(|error| format!("Unable to remove Git path '{path}': {error}"))
}

pub(crate) fn restore_from_head(root: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "restore".to_string(),
        "--source=HEAD".to_string(),
        "--staged".to_string(),
        "--worktree".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| git_pathspec(path)));
    require_success("Git restore", run_git(root, args.iter())?).map(|_| ())
}

pub(crate) fn file_manager_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    let lexical = root.join(path);
    match std::fs::symlink_metadata(&lexical) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!("Symlinked Git paths are not allowed: {path}"));
            }
            let canonical = std::fs::canonicalize(&lexical)
                .map_err(|error| format!("Unable to resolve Git path '{path}': {error}"))?;
            if !is_within(root, &canonical) {
                return Err(format!("Git path escapes projectRoot: {path}"));
            }
            Ok(canonical)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            existing_parent_for_file_manager(root, &lexical, path)
        }
        Err(error) => Err(format!("Unable to inspect Git path '{path}': {error}")),
    }
}

pub(crate) fn existing_parent_for_file_manager(
    root: &Path,
    lexical: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let mut candidate = lexical.parent();
    while let Some(path) = candidate {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Symlinked Git paths are not allowed: {requested_path}"
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Git path parent is not a directory: {requested_path}"
                    ));
                }
                let canonical = std::fs::canonicalize(path).map_err(|error| {
                    format!("Unable to resolve Git path parent '{requested_path}': {error}")
                })?;
                if !is_within(root, &canonical) {
                    return Err(format!("Git path escapes projectRoot: {requested_path}"));
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = path.parent();
            }
            Err(error) => {
                return Err(format!(
                    "Unable to inspect Git path parent '{requested_path}': {error}"
                ));
            }
        }
    }
    Err(format!(
        "Unable to resolve Git path parent '{requested_path}'"
    ))
}
pub(crate) fn validate_worktree_path(root: &Path, path: &str) -> Result<(), String> {
    let lexical = root.join(path);
    let metadata = match std::fs::symlink_metadata(&lexical) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut ancestor = lexical.parent();
            while let Some(candidate) = ancestor {
                match std::fs::canonicalize(candidate) {
                    Ok(canonical) => {
                        if !is_within(root, &canonical) {
                            return Err(format!("Git path escapes projectRoot: {path}"));
                        }
                        return Ok(());
                    }
                    Err(parent_error) if parent_error.kind() == std::io::ErrorKind::NotFound => {
                        ancestor = candidate.parent();
                    }
                    Err(parent_error) => {
                        return Err(format!(
                            "Unable to resolve Git path parent '{path}': {parent_error}"
                        ));
                    }
                }
            }
            return Err(format!("Unable to resolve Git path parent '{path}'"));
        }
        Err(error) => return Err(format!("Unable to inspect Git path '{path}': {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!("Symlinked Git paths are not allowed: {path}"));
    }
    let canonical = std::fs::canonicalize(&lexical)
        .map_err(|error| format!("Unable to resolve Git path '{path}': {error}"))?;
    if !is_within(root, &canonical) {
        return Err(format!("Git path escapes projectRoot: {path}"));
    }
    Ok(())
}

pub(crate) fn canonical_git_root(project_root: &str) -> Result<PathBuf, String> {
    let root = canonical_project_root(project_root)?;
    let output = run_git(&root, ["rev-parse", "--show-toplevel"])?;
    let output = require_success("Git repository lookup", output)?;
    let git_root_text = utf8_stdout(&output, "Git repository lookup")?
        .trim()
        .to_string();
    let git_root = std::fs::canonicalize(&git_root_text).map_err(|error| {
        format!(
            "Unable to resolve the Git repository root '{}': {error}",
            git_root_text
        )
    })?;
    if git_root != root {
        return Err(format!(
            "Selected projectRoot must be the Git repository root ({})",
            git_root.display()
        ));
    }
    Ok(root)
}

pub(crate) fn changed_path_selection(
    root: &Path,
    requested_paths: Vec<String>,
) -> Result<ChangedPathSelection, String> {
    let mut selected_paths = Vec::new();
    let mut seen = HashSet::new();
    for requested in requested_paths {
        let normalized = validate_git_relative_path(&requested)?;
        let normalized = git_path_string(&normalized);
        validate_worktree_path(root, &normalized)?;
        if seen.insert(normalized.clone()) {
            selected_paths.push(normalized);
        }
    }
    if selected_paths.is_empty() {
        return Err("Select at least one changed file".to_string());
    }

    let changes = list_changes_at_root(root)?;
    let changed: HashSet<&str> = changes.iter().map(|change| change.path.as_str()).collect();
    let missing: Vec<&str> = selected_paths
        .iter()
        .filter(|path| !changed.contains(path.as_str()))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "The selected path is not currently changed: {}",
            missing.join(", ")
        ));
    }

    let mut command_paths = selected_paths.clone();
    for selected in &selected_paths {
        let Some(change) = changes.iter().find(|change| change.path == *selected) else {
            continue;
        };
        let Some(original_path) = change.original_path.as_deref() else {
            continue;
        };
        validate_worktree_path(root, original_path)?;
        if seen.insert(original_path.to_string()) {
            command_paths.push(original_path.to_string());
        }
    }
    Ok(ChangedPathSelection {
        selected_paths,
        command_paths,
        changes,
    })
}

use super::path::{
    canonical_git_root, file_manager_target, remove_from_index, remove_worktree_file,
    restore_from_head, validate_git_operation_path,
};
use super::process::{has_head, require_success, run_git};
use super::status::{is_untracked_change, list_changes_at_root, parse_status};
use crate::models::GitFileChange;

/// List paths that currently differ from the repository index or HEAD.
pub(crate) fn list_changes(project_root: &str) -> Result<Vec<GitFileChange>, String> {
    let root = canonical_git_root(project_root)?;
    let output = run_git(
        &root,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let output = require_success("Git status", output)?;
    parse_status(&output.stdout)
}

/// Discard every local change represented by one current Git status row.
///
/// The status is intentionally re-read inside this operation.  A row in the
/// UI is only a hint: the worktree may have changed between rendering and the
/// user's confirmation.  Tracked paths are restored from HEAD (both index and
/// worktree), while untracked and staged-added paths are removed from the
/// index and worktree.  A staged rename is treated as one logical change and
/// restores its original path after removing the destination.
pub(crate) fn discard_changes(project_root: &str, requested_path: &str) -> Result<(), String> {
    let root = canonical_git_root(project_root)?;
    let requested = validate_git_operation_path(&root, requested_path)?;
    let changes = list_changes_at_root(&root)?;
    let change = changes
        .iter()
        .find(|change| {
            change.path == requested || change.original_path.as_deref() == Some(requested.as_str())
        })
        .cloned()
        .ok_or_else(|| format!("The selected path is not currently changed: {requested}"))?;

    let current_path = validate_git_operation_path(&root, &change.path)?;
    let original_path = change
        .original_path
        .as_deref()
        .map(|path| validate_git_operation_path(&root, path))
        .transpose()?;

    let mut related_paths = vec![current_path.clone()];
    if let Some(original_path) = original_path.as_deref() {
        if !related_paths.iter().any(|path| path == original_path) {
            related_paths.push(original_path.to_string());
        }
    }

    // An unborn repository has no tree to restore from.  Every indexed path
    // is an addition, so removing the index entries and worktree paths is the
    // only meaningful interpretation of discard.
    if !has_head(&root) {
        for path in &related_paths {
            remove_from_index(&root, path)?;
        }
        for path in &related_paths {
            remove_worktree_file(&root, path)?;
        }
        return Ok(());
    }

    if is_untracked_change(&change) {
        remove_worktree_file(&root, &current_path)?;
        return Ok(());
    }

    // A staged add has no path in HEAD.  Restore cannot match it against the
    // source tree, so remove it explicitly from both Git and the worktree.
    if change.index_status == "A" || change.index_status == "?" {
        remove_from_index(&root, &current_path)?;
        remove_worktree_file(&root, &current_path)?;
        return Ok(());
    }

    if change.index_status == "R" {
        // The destination is an added path in the index, so restore the
        // original first would leave the rename destination behind. Remove
        // the destination and then restore the original from HEAD.
        remove_from_index(&root, &current_path)?;
        remove_worktree_file(&root, &current_path)?;
        if let Some(original_path) = original_path.as_deref() {
            restore_from_head(&root, &[original_path.to_string()])?;
        }
        return Ok(());
    }

    // A copy has an untouched source path.  Discard only the copied target so
    // unrelated edits to the source are not lost.
    if change.index_status == "C" {
        remove_from_index(&root, &current_path)?;
        remove_worktree_file(&root, &current_path)?;
        return Ok(());
    }

    restore_from_head(&root, &related_paths)
}

/// Reveal a changed path in the system file manager.  The path is resolved
/// relative to the selected repository and never accepted as an arbitrary
/// absolute path.  If the file was deleted after the Git row was rendered,
/// the nearest existing repository directory is revealed instead.
pub(crate) fn show_in_file_manager(project_root: &str, requested_path: &str) -> Result<(), String> {
    let root = canonical_git_root(project_root)?;
    let path = validate_git_operation_path(&root, requested_path)?;
    let target = file_manager_target(&root, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&target)
        .map_err(|error| format!("Unable to show '{}' in the file manager: {error}", path))
}

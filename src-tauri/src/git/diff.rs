use super::path::{canonical_git_root, changed_path_selection, validate_worktree_path};
use super::process::{
    command_error, git_pathspec, has_head, null_device, require_success, run_git,
};
use std::collections::HashSet;

/// Return one unified patch for the selected paths.
///
/// When a repository has a HEAD, `git diff HEAD` naturally combines staged
/// and unstaged changes. New, untracked files are emitted through Git's
/// no-index mode because they do not exist in HEAD yet. An empty repository
/// has no HEAD, so its staged and unstaged diffs are emitted separately.
pub(crate) fn diff(project_root: &str, requested_paths: Vec<String>) -> Result<String, String> {
    let root = canonical_git_root(project_root)?;
    let selection = changed_path_selection(&root, requested_paths)?;
    let paths = selection.command_paths;
    let changes = selection.changes;
    let untracked: HashSet<&str> = changes
        .iter()
        .filter(|change| change.index_status == "?" && change.worktree_status == "?")
        .map(|change| change.path.as_str())
        .collect();
    let tracked_paths: Vec<String> = paths
        .iter()
        .filter(|path| !untracked.contains(path.as_str()))
        .cloned()
        .collect();

    let mut chunks = Vec::new();
    if !tracked_paths.is_empty() {
        if has_head(&root) {
            let mut args = vec![
                "diff".to_string(),
                "--no-ext-diff".to_string(),
                "--binary".to_string(),
                "--no-color".to_string(),
                "HEAD".to_string(),
                "--".to_string(),
            ];
            args.extend(tracked_paths.iter().map(|path| git_pathspec(path)));
            let output = require_success("Git diff", run_git(&root, args.iter())?)?;
            chunks.push(output.stdout);
        } else {
            for (label, cached) in [("Git staged diff", true), ("Git unstaged diff", false)] {
                let mut args = vec![
                    "diff".to_string(),
                    "--no-ext-diff".to_string(),
                    "--binary".to_string(),
                    "--no-color".to_string(),
                ];
                if cached {
                    args.push("--cached".to_string());
                }
                args.push("--".to_string());
                args.extend(tracked_paths.iter().map(|path| git_pathspec(path)));
                let output = require_success(label, run_git(&root, args.iter())?)?;
                chunks.push(output.stdout);
            }
        }
    }

    for path in paths
        .iter()
        .filter(|path| untracked.contains(path.as_str()))
    {
        validate_worktree_path(&root, path)?;
        let args = [
            "diff",
            "--no-ext-diff",
            "--binary",
            "--no-color",
            "--no-index",
            "--",
            null_device(),
            path.as_str(),
        ];
        let output = run_git(&root, args)?;
        // `git diff --no-index` uses exit code 1 to indicate that the files
        // differ. That is the expected result for an untracked file.
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(command_error("Git diff", &output));
        }
        chunks.push(output.stdout);
    }

    Ok(join_diff_chunks(chunks))
}
pub(crate) fn join_diff_chunks(chunks: Vec<Vec<u8>>) -> String {
    let mut result = String::new();
    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(&chunk);
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str(&text);
        if !result.ends_with('\n') {
            result.push('\n');
        }
    }
    result
}

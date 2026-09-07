use super::path::{canonical_git_root, changed_path_selection};
use super::process::{command_error, git_pathspec, require_success, run_git, utf8_stdout};
use crate::models::GitCommitResult;
use std::path::Path;

/// Commit exactly the selected changed paths while preserving unrelated
/// staged changes. `git add` makes new files eligible for commit; `--only`
/// then limits the commit itself to the explicit path list.
pub(crate) fn commit(
    project_root: &str,
    requested_paths: Vec<String>,
    message: String,
) -> Result<GitCommitResult, String> {
    let root = canonical_git_root(project_root)?;
    let (selected_paths, paths) = changed_path_selection(&root, requested_paths)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Commit message must not be empty".to_string());
    }
    if message.as_bytes().contains(&0) {
        return Err("Commit message must not contain a NUL byte".to_string());
    }

    stage_paths(&root, &paths)?;

    let mut commit_args = vec![
        "commit".to_string(),
        "--only".to_string(),
        "-m".to_string(),
        message.clone(),
        "--".to_string(),
    ];
    commit_args.extend(paths.iter().map(|path| git_pathspec(path)));
    require_success("Git commit", run_git(&root, commit_args.iter())?)?;

    let hash_output = require_success(
        "Git commit hash lookup",
        run_git(&root, ["rev-parse", "HEAD"])?,
    )?;
    let commit_hash = utf8_stdout(&hash_output, "Git commit hash lookup")?
        .trim()
        .to_string();
    if commit_hash.is_empty() {
        return Err("Git created a commit but did not return its commit hash".to_string());
    }

    Ok(GitCommitResult {
        commit_hash,
        message,
        paths: selected_paths,
    })
}
pub(crate) fn stage_paths(root: &Path, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let missing = matches!(
            std::fs::symlink_metadata(root.join(path)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        );
        let mut args = vec!["add".to_string()];
        if missing {
            // A deleted source path is still present in the index, but Git's
            // regular add pathspec cannot match it after it disappears from
            // the worktree. `-u` stages that tracked deletion explicitly.
            args.push("-u".to_string());
        }
        args.push("--".to_string());
        args.push(git_pathspec(path));
        let output = run_git(root, args.iter())?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            // A source path from an already-indexed rename is intentionally
            // absent from the index, so `git add -u` has nothing to match.
            // The rename's deletion is already staged and remains covered by
            // the explicit commit pathspec below.
            if !(missing && detail.contains("pathspec") && detail.contains("did not match")) {
                return Err(command_error("Git stage", &output));
            }
        }
    }
    Ok(())
}

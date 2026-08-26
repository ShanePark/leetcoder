use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;

use crate::models::{GitCommitResult, GitFileChange, GitPushResult};
use crate::security::{canonical_project_root, is_within, validate_git_relative_path};

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

fn is_untracked_change(change: &GitFileChange) -> bool {
    change.index_status == "?" && change.worktree_status == "?"
}

/// Validate a Git path before any command or filesystem mutation.  In
/// addition to the existing canonical-boundary check, reject symlinked path
/// components so an operation cannot be redirected outside the repository by
/// a link created after the row was listed.
fn validate_git_operation_path(root: &Path, path: &str) -> Result<String, String> {
    let relative = validate_git_relative_path(path)?;
    let normalized = git_path_string(&relative);
    validate_git_path_components(root, &normalized)?;
    validate_worktree_path(root, &normalized)?;
    Ok(normalized)
}

fn validate_git_path_components(root: &Path, path: &str) -> Result<(), String> {
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

fn remove_from_index(root: &Path, path: &str) -> Result<(), String> {
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

fn remove_worktree_file(root: &Path, path: &str) -> Result<(), String> {
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

fn restore_from_head(root: &Path, paths: &[String]) -> Result<(), String> {
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

fn file_manager_target(root: &Path, path: &str) -> Result<PathBuf, String> {
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

fn existing_parent_for_file_manager(
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

/// Return one unified patch for the selected paths.
///
/// When a repository has a HEAD, `git diff HEAD` naturally combines staged
/// and unstaged changes. New, untracked files are emitted through Git's
/// no-index mode because they do not exist in HEAD yet. An empty repository
/// has no HEAD, so its staged and unstaged diffs are emitted separately.
pub(crate) fn diff(project_root: &str, requested_paths: Vec<String>) -> Result<String, String> {
    let root = canonical_git_root(project_root)?;
    let (_selected_paths, paths) = changed_path_selection(&root, requested_paths)?;
    let changes = list_changes_at_root(&root)?;
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

/// Push the current branch to its configured upstream without opening an
/// interactive credentials prompt.
pub(crate) fn push(project_root: &str) -> Result<GitPushResult, String> {
    let root = canonical_git_root(project_root)?;
    let branch = configured_branch(&root)?;
    let remote = git_config_value(&root, &format!("branch.{branch}.remote"))?.ok_or_else(|| {
        "No upstream remote is configured for the current branch. Configure one before pushing."
            .to_string()
    })?;
    let upstream_ref =
        git_config_value(&root, &format!("branch.{branch}.merge"))?.ok_or_else(|| {
            "No upstream branch is configured for the current branch. Configure one before pushing."
                .to_string()
        })?;
    if !upstream_ref.starts_with("refs/heads/") {
        return Err(format!(
            "The configured upstream is not a branch ref: {upstream_ref}"
        ));
    }

    let refspec = format!("HEAD:{upstream_ref}");
    let push_args = [
        "push".to_string(),
        "--porcelain".to_string(),
        "--no-follow-tags".to_string(),
        remote,
        refspec,
    ];
    let output = require_success("Git push", run_git(&root, push_args.iter())?)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let output = match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    };
    Ok(GitPushResult {
        output,
        branch: Some(branch),
    })
}

fn configured_branch(root: &Path) -> Result<String, String> {
    let output = run_git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !output.status.success() {
        return Err(
            "Git push requires a checked-out branch; the current repository is in detached HEAD state."
                .to_string(),
        );
    }
    let branch = utf8_stdout(&output, "Git branch lookup")?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("Git did not report the current branch".to_string());
    }
    Ok(branch)
}

fn git_config_value(root: &Path, key: &str) -> Result<Option<String>, String> {
    let output = run_git(root, ["config", "--get", key])?;
    if !output.status.success() {
        // `git config --get` exits with 1 when the key is absent. Other
        // failures indicate an unreadable or invalid repository config.
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(command_error("Git configuration lookup", &output));
    }
    let value = utf8_stdout(&output, "Git configuration lookup")?
        .trim()
        .to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn canonical_git_root(project_root: &str) -> Result<PathBuf, String> {
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

fn changed_path_selection(
    root: &Path,
    requested_paths: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), String> {
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
    Ok((selected_paths, command_paths))
}

fn stage_paths(root: &Path, paths: &[String]) -> Result<(), String> {
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

fn list_changes_at_root(root: &Path) -> Result<Vec<GitFileChange>, String> {
    let output = require_success(
        "Git status",
        run_git(
            root,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?,
    )?;
    parse_status(&output.stdout)
}

fn parse_status(bytes: &[u8]) -> Result<Vec<GitFileChange>, String> {
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 3 || record[2] != b' ' {
            return Err("Git returned an unrecognized status record".to_string());
        }
        let index_status = status_char(record[0])?;
        let worktree_status = status_char(record[1])?;
        let path = status_path(&record[3..])?;
        let original_path = if matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C')
        {
            let original = records
                .next()
                .ok_or_else(|| "Git returned an incomplete rename status record".to_string())?;
            Some(status_path(original)?)
        } else {
            None
        };
        let status = compact_status(index_status, worktree_status);
        changes.push(GitFileChange {
            path,
            status,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            original_path,
        });
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

fn status_char(byte: u8) -> Result<char, String> {
    let character = byte as char;
    if matches!(
        character,
        ' ' | '.' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!'
    ) {
        Ok(if character == ' ' { '.' } else { character })
    } else {
        Err("Git returned an unrecognized status code".to_string())
    }
}

fn compact_status(index_status: char, worktree_status: char) -> String {
    if index_status == '?' && worktree_status == '?' {
        return "??".to_string();
    }
    let mut status = String::new();
    if index_status != '.' {
        status.push(index_status);
    }
    if worktree_status != '.' {
        status.push(worktree_status);
    }
    if status.is_empty() {
        ".".to_string()
    } else {
        status
    }
}

fn status_path(bytes: &[u8]) -> Result<String, String> {
    let path = String::from_utf8(bytes.to_vec())
        .map_err(|_| "Git returned a path that is not valid UTF-8".to_string())?;
    let normalized = validate_git_relative_path(&path)?;
    Ok(git_path_string(&normalized))
}

fn git_path_string(path: &Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

/// Git treats path arguments as pathspecs, so a filename containing glob or
/// pathspec-magic characters could otherwise select additional files. The
/// literal prefix keeps a selected row mapped to exactly one repository path.
fn git_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn validate_worktree_path(root: &Path, path: &str) -> Result<(), String> {
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

fn has_head(root: &Path) -> bool {
    run_git(root, ["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn join_diff_chunks(chunks: Vec<Vec<u8>>) -> String {
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

fn run_git<I, S>(root: &Path, args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    const MAX_STREAM_BYTES: usize = 1024 * 1024;
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", noninteractive_askpass())
        .env("SSH_ASKPASS", noninteractive_askpass())
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Unable to run Git. Install Git and try again.".to_string()
        } else {
            format!("Unable to run Git: {error}")
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture Git standard output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to capture Git standard error".to_string())?;
    let stdout_thread = thread::spawn(move || read_bounded_stream(stdout, MAX_STREAM_BYTES));
    let stderr_thread = thread::spawn(move || read_bounded_stream(stderr, MAX_STREAM_BYTES));
    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for Git: {error}"))?;
    let stdout = stdout_thread
        .join()
        .map_err(|_| "Git standard output reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Unable to read Git standard output: {error}"))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "Git standard error reader stopped unexpectedly".to_string())?
        .map_err(|error| format!("Unable to read Git standard error: {error}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn read_bounded_stream<R: Read>(mut stream: R, max_bytes: usize) -> io::Result<Vec<u8>> {
    const TRUNCATION_MARKER: &[u8] = b"\n...[output truncated by leetcoder]...\n";
    let payload_limit = max_bytes.saturating_sub(TRUNCATION_MARKER.len());
    let mut captured = Vec::with_capacity(max_bytes.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if captured.len() < payload_limit {
            let take = (payload_limit - captured.len()).min(read);
            captured.extend_from_slice(&buffer[..take]);
            truncated |= take < read;
        } else {
            truncated = true;
        }
    }
    if truncated {
        captured.extend_from_slice(&TRUNCATION_MARKER[..max_bytes - captured.len()]);
    }
    Ok(captured)
}

fn noninteractive_askpass() -> &'static str {
    #[cfg(unix)]
    {
        return "/usr/bin/false";
    }
    #[cfg(windows)]
    {
        "cmd.exe"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "false"
    }
}

fn require_success(operation: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(operation, &output))
    }
}

fn command_error(operation: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!("{operation} failed (exit code {:?})", output.status.code())
    } else {
        format!("{operation} failed: {detail}")
    }
}

fn utf8_stdout(output: &Output, operation: &str) -> Result<String, String> {
    String::from_utf8(output.stdout.clone())
        .map_err(|_| format!("{operation} returned invalid UTF-8 output"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::process::Stdio;

    fn run_fixture_git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git is installed for Rust tests");
        assert!(status.success(), "git {:?} failed", args);
    }

    fn run_fixture_git_capture(root: &Path, args: &[String]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git is installed for Rust tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("fixture git output is UTF-8")
            .trim()
            .to_string()
    }

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("tempdir");
        run_fixture_git(directory.path(), &["init", "--quiet"]);
        run_fixture_git(directory.path(), &["config", "user.name", "Test User"]);
        run_fixture_git(
            directory.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(directory.path().join("tracked.txt"), "before\n").expect("tracked file");
        run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
        run_fixture_git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
        directory
    }

    #[test]
    fn bounded_stream_capture_keeps_marker_and_does_not_retain_unbounded_output() {
        let input = vec![b'x'; 4096];
        let captured = read_bounded_stream(Cursor::new(input), 128).unwrap();
        assert!(captured.len() <= 128);
        assert!(String::from_utf8_lossy(&captured).contains("output truncated"));

        let short = read_bounded_stream(Cursor::new(b"short".to_vec()), 128).unwrap();
        assert_eq!(short, b"short");
    }

    #[test]
    fn parses_spaces_untracked_and_two_column_statuses() {
        let directory = fixture();
        fs::write(directory.path().join("tracked.txt"), "after\n").expect("modify tracked");
        fs::write(directory.path().join("new file.txt"), "new\n").expect("new file");

        let changes = list_changes(directory.path().to_str().unwrap()).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "new file.txt");
        assert_eq!(changes[0].status, "??");
        assert_eq!(changes[1].path, "tracked.txt");
        assert_eq!(changes[1].status, "M");
        assert_eq!(changes[1].index_status, ".");
        assert_eq!(changes[1].worktree_status, "M");
    }

    #[test]
    fn discard_restores_unstaged_staged_and_mixed_tracked_changes() {
        let directory = fixture();
        let root = directory.path().to_str().unwrap();
        let tracked = directory.path().join("tracked.txt");

        fs::write(&tracked, "unstaged\n").expect("unstaged change");
        discard_changes(root, "tracked.txt").expect("discard unstaged change");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        assert!(list_changes(root).unwrap().is_empty());

        fs::write(&tracked, "staged\n").expect("staged change");
        run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
        discard_changes(root, "tracked.txt").expect("discard staged change");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        assert!(list_changes(root).unwrap().is_empty());

        fs::write(&tracked, "staged\n").expect("staged content");
        run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
        fs::write(&tracked, "staged and unstaged\n").expect("mixed content");
        discard_changes(root, "tracked.txt").expect("discard mixed change");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        assert!(list_changes(root).unwrap().is_empty());
    }

    #[test]
    fn discard_removes_untracked_and_staged_added_files() {
        let directory = fixture();
        let root = directory.path().to_str().unwrap();
        let untracked = directory.path().join("untracked.txt");
        fs::write(&untracked, "untracked\n").expect("untracked file");
        discard_changes(root, "untracked.txt").expect("discard untracked file");
        assert!(!untracked.exists());
        assert!(list_changes(root).unwrap().is_empty());

        let added = directory.path().join("added.txt");
        fs::write(&added, "added\n").expect("staged added file");
        run_fixture_git(directory.path(), &["add", "--", "added.txt"]);
        discard_changes(root, "added.txt").expect("discard staged added file");
        assert!(!added.exists());
        assert!(list_changes(root).unwrap().is_empty());
    }

    #[test]
    fn discard_restores_deleted_files_and_staged_renames() {
        let directory = fixture();
        let root = directory.path().to_str().unwrap();
        let tracked = directory.path().join("tracked.txt");
        fs::remove_file(&tracked).expect("delete tracked file");
        discard_changes(root, "tracked.txt").expect("discard deleted file");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        assert!(list_changes(root).unwrap().is_empty());

        let renamed = directory.path().join("renamed.txt");
        fs::rename(&tracked, &renamed).expect("rename tracked file");
        run_fixture_git(directory.path(), &["add", "--all"]);
        let changes = list_changes(root).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "renamed.txt");
        assert_eq!(changes[0].original_path.as_deref(), Some("tracked.txt"));
        // Either side of a freshly listed rename resolves to the same logical
        // status row; the UI normally passes the destination path.
        discard_changes(root, "tracked.txt").expect("discard staged rename");
        assert!(!renamed.exists());
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        assert!(list_changes(root).unwrap().is_empty());
    }

    #[test]
    fn discard_rechecks_status_before_mutating_the_worktree() {
        let directory = fixture();
        let root = directory.path().to_str().unwrap();
        let error = discard_changes(root, "tracked.txt").unwrap_err();
        assert!(error.contains("not currently changed"));
        assert_eq!(
            fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn discard_handles_unborn_head_changes() {
        let directory = tempfile::tempdir().expect("tempdir");
        run_fixture_git(directory.path(), &["init", "--quiet"]);
        let root = directory.path().to_str().unwrap();

        let untracked = directory.path().join("untracked.txt");
        fs::write(&untracked, "untracked\n").expect("untracked file");
        discard_changes(root, "untracked.txt").expect("discard unborn untracked file");
        assert!(!untracked.exists());

        let added = directory.path().join("added.txt");
        fs::write(&added, "added\n").expect("unborn staged file");
        run_fixture_git(directory.path(), &["add", "--", "added.txt"]);
        discard_changes(root, "added.txt").expect("discard unborn staged file");
        assert!(!added.exists());
        assert!(list_changes(root).unwrap().is_empty());
    }

    #[test]
    fn discard_and_file_manager_reject_unsafe_paths() {
        let directory = fixture();
        let root = directory.path().to_str().unwrap();
        assert!(discard_changes(root, "../outside.txt")
            .unwrap_err()
            .contains("may not contain '..'"));
        assert!(show_in_file_manager(root, "/outside.txt")
            .unwrap_err()
            .contains("must be relative"));

        let outside = tempfile::tempdir().expect("outside tempdir");
        let link = directory.path().join("linked.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("outside.txt"), &link).expect("symlink");
        #[cfg(unix)]
        {
            fs::write(outside.path().join("outside.txt"), "outside\n").expect("outside file");
            assert!(show_in_file_manager(root, "linked.txt")
                .unwrap_err()
                .contains("Symlinked Git paths"));
        }
    }

    #[test]
    fn file_manager_target_uses_existing_file_or_nearest_parent() {
        let directory = fixture();
        let root = std::fs::canonicalize(directory.path()).expect("canonical root");
        let existing = file_manager_target(&root, "tracked.txt").expect("existing target");
        assert_eq!(existing, root.join("tracked.txt"));

        let nested = directory.path().join("nested");
        fs::create_dir(&nested).expect("nested directory");
        let deleted = file_manager_target(&root, "nested/deleted.txt").expect("parent target");
        assert_eq!(deleted, std::fs::canonicalize(nested).unwrap());

        let missing_parent =
            file_manager_target(&root, "missing/deleted.txt").expect("repository root target");
        assert_eq!(missing_parent, root);
    }

    #[test]
    fn diff_combines_tracked_and_untracked_selected_files() {
        let directory = fixture();
        fs::write(directory.path().join("tracked.txt"), "after\n").expect("modify tracked");
        fs::write(directory.path().join("new.txt"), "new\n").expect("new file");

        let patch = diff(
            directory.path().to_str().unwrap(),
            vec!["tracked.txt".to_string(), "new.txt".to_string()],
        )
        .unwrap();
        assert!(patch.contains("diff --git a/tracked.txt b/tracked.txt"));
        assert!(patch.contains("diff --git a/new.txt b/new.txt"));
        assert!(patch.contains("+after"));
        assert!(patch.contains("+new"));
    }

    #[test]
    fn parses_renames_and_unicode_paths_without_shell_quoting() {
        let directory = fixture();
        fs::rename(
            directory.path().join("tracked.txt"),
            directory.path().join("renamed file-日本.txt"),
        )
        .expect("rename tracked file");
        run_fixture_git(directory.path(), &["add", "--all"]);

        let changes = list_changes(directory.path().to_str().unwrap()).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "renamed file-日本.txt");
        assert_eq!(changes[0].original_path.as_deref(), Some("tracked.txt"));
        assert_eq!(changes[0].status, "R");
    }

    #[test]
    fn selecting_rename_destination_also_commits_original_source_deletion() {
        let directory = fixture();
        fs::rename(
            directory.path().join("tracked.txt"),
            directory.path().join("renamed.txt"),
        )
        .expect("rename tracked file");
        run_fixture_git(directory.path(), &["add", "--all"]);

        let patch = diff(
            directory.path().to_str().unwrap(),
            vec!["renamed.txt".to_string()],
        )
        .unwrap();
        assert!(patch.contains("rename from tracked.txt"));
        assert!(patch.contains("rename to renamed.txt"));

        let result = commit(
            directory.path().to_str().unwrap(),
            vec!["renamed.txt".to_string()],
            "Rename tracked.txt".to_string(),
        )
        .unwrap();
        assert_eq!(result.paths, vec!["renamed.txt"]);
        assert!(!directory.path().join("tracked.txt").exists());
        assert!(directory.path().join("renamed.txt").exists());
        assert!(list_changes(directory.path().to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn diff_uses_final_worktree_content_for_staged_and_unstaged_changes() {
        let directory = fixture();
        fs::write(directory.path().join("tracked.txt"), "staged\n").expect("stage content");
        run_fixture_git(directory.path(), &["add", "--", "tracked.txt"]);
        fs::write(
            directory.path().join("tracked.txt"),
            "staged and unstaged\n",
        )
        .expect("worktree content");

        let patch = diff(
            directory.path().to_str().unwrap(),
            vec!["tracked.txt".to_string()],
        )
        .unwrap();
        assert!(patch.contains("+staged and unstaged"));
        assert!(!patch.contains("+staged\n"));
    }

    #[test]
    fn commit_only_preserves_unrelated_staged_changes() {
        let directory = fixture();
        fs::write(directory.path().join("other.txt"), "other before\n").expect("other file");
        run_fixture_git(directory.path(), &["add", "--", "other.txt"]);
        fs::write(directory.path().join("tracked.txt"), "selected after\n")
            .expect("selected change");

        let result = commit(
            directory.path().to_str().unwrap(),
            vec!["tracked.txt".to_string()],
            "Create tracked.txt".to_string(),
        )
        .unwrap();
        assert_eq!(result.message, "Create tracked.txt");
        assert!(!result.commit_hash.is_empty());

        let status = list_changes(directory.path().to_str().unwrap()).unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].path, "other.txt");
        assert_eq!(status[0].status, "A");
    }

    #[test]
    fn rejects_parent_path_before_running_mutating_commands() {
        let directory = fixture();
        let error = commit(
            directory.path().to_str().unwrap(),
            vec!["../outside.txt".to_string()],
            "unsafe".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("may not contain '..'"));
    }

    #[test]
    fn validates_deleted_paths_against_the_nearest_existing_ancestor() {
        let directory = fixture();
        fs::create_dir_all(directory.path().join("gone/nested")).expect("nested directory");
        fs::write(directory.path().join("gone/nested/file.txt"), "gone").expect("deleted file");
        fs::remove_dir_all(directory.path().join("gone")).expect("remove directory tree");

        let root = std::fs::canonicalize(directory.path()).expect("canonical root");
        validate_worktree_path(&root, "gone/nested/file.txt").unwrap();
    }

    #[test]
    fn pushes_to_the_configured_upstream_ref_explicitly() {
        let directory = fixture();
        let remote = tempfile::tempdir().expect("bare remote");
        run_fixture_git(remote.path(), &["init", "--bare", "--quiet"]);
        run_fixture_git(directory.path(), &["branch", "-M", "main"]);
        run_fixture_git_capture(
            directory.path(),
            &[
                "remote".to_string(),
                "add".to_string(),
                "origin".to_string(),
                remote.path().to_string_lossy().into_owned(),
            ],
        );
        run_fixture_git_capture(
            directory.path(),
            &[
                "push".to_string(),
                "-u".to_string(),
                "origin".to_string(),
                "HEAD:refs/heads/main".to_string(),
            ],
        );

        let result = push(directory.path().to_str().unwrap()).unwrap();
        assert_eq!(result.branch.as_deref(), Some("main"));
        let local_head = run_fixture_git_capture(
            directory.path(),
            &["rev-parse".to_string(), "HEAD".to_string()],
        );
        let remote_head = run_fixture_git_capture(
            remote.path(),
            &["rev-parse".to_string(), "refs/heads/main".to_string()],
        );
        assert_eq!(local_head, remote_head);
    }
}

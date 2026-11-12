use super::path::canonical_git_root;
use super::process::{combined_output, command_error, has_head, run_git, utf8_stdout};
use super::upstream::configured_upstream;
use crate::models::GitPullResult;
use std::path::Path;

/// Fetch the current branch's upstream and fast-forward the branch to it.
///
/// Commit & Push runs this before committing so a new commit is never built
/// on a stale branch. It never merges or rebases: a diverged branch, or
/// incoming changes that would overwrite local edits, stop with an error and
/// leave HEAD, the index, and the worktree as they were.
pub(crate) fn pull(project_root: &str) -> Result<GitPullResult, String> {
    let root = canonical_git_root(project_root)?;
    let upstream = configured_upstream(&root)?;
    let display = upstream.display_name();
    let branch = &upstream.branch;

    // Fetching the explicit upstream ref also updates its remote-tracking ref
    // when the remote has a matching fetch refspec.
    let fetch_args = [
        "fetch".to_string(),
        "--no-tags".to_string(),
        upstream.remote.clone(),
        upstream.merge_ref.clone(),
    ];
    let fetch = run_git(&root, fetch_args.iter())?;
    if !fetch.status.success() {
        // A remote branch deleted after a merge leaves nothing to pull, and the
        // push recreates it. The extra lookup runs only on failure so the
        // normal path stays one network call.
        if remote_ref_is_missing(&root, &upstream.remote, &upstream.merge_ref)? {
            return Ok(GitPullResult {
                updated: false,
                output: format!("{display} no longer exists on the remote; nothing to pull."),
            });
        }
        return Err(command_error(&format!("Fetching {display}"), &fetch));
    }
    let fetched = resolve_commit(&root, "FETCH_HEAD^{commit}")?
        .ok_or_else(|| format!("Fetching {display} did not return a commit"))?;

    if has_head(&root) {
        let head = resolve_commit(&root, "HEAD")?
            .ok_or_else(|| "Git could not resolve HEAD".to_string())?;
        if head == fetched || is_ancestor(&root, &fetched, &head)? {
            return Ok(GitPullResult {
                updated: false,
                output: format!("Already up to date with {display}."),
            });
        }
        if !is_ancestor(&root, &head, &fetched)? {
            let (local, remote) = divergence(&root, &head, &fetched)?;
            return Err(format!(
                "{branch} has diverged from {display} ({local} local and {remote} remote \
                 commits). Nothing was committed; pull or rebase the branch before pushing."
            ));
        }
    }

    let merge = run_git(&root, ["merge", "--ff-only", fetched.as_str()])?;
    if !merge.status.success() {
        let detail = combined_output(&merge);
        return Err(format!(
            "Could not fast-forward {branch} to {display}; nothing was committed.\n{detail}"
        ));
    }
    Ok(GitPullResult {
        updated: true,
        output: combined_output(&merge),
    })
}

/// `ls-remote --exit-code` exits with 2 only when the remote answered and the
/// ref is absent, which avoids parsing localized fetch messages. Any other
/// failure (network, auth, missing remote) is not treated as a missing ref.
fn remote_ref_is_missing(root: &Path, remote: &str, merge_ref: &str) -> Result<bool, String> {
    let output = run_git(root, ["ls-remote", "--exit-code", remote, merge_ref])?;
    Ok(output.status.code() == Some(2))
}

fn resolve_commit(root: &Path, revision: &str) -> Result<Option<String>, String> {
    let output = run_git(root, ["rev-parse", "--verify", "--quiet", revision])?;
    if !output.status.success() {
        return Ok(None);
    }
    let hash = utf8_stdout(&output, "Git revision lookup")?
        .trim()
        .to_string();
    Ok((!hash.is_empty()).then_some(hash))
}

fn is_ancestor(root: &Path, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let output = run_git(root, ["merge-base", "--is-ancestor", ancestor, descendant])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(command_error("Git ancestry check", &output)),
    }
}

/// Count commits only HEAD has and commits only the upstream has.
fn divergence(root: &Path, head: &str, upstream: &str) -> Result<(u32, u32), String> {
    let range = format!("{head}...{upstream}");
    let output = run_git(
        root,
        ["rev-list", "--left-right", "--count", range.as_str()],
    )?;
    if !output.status.success() {
        return Err(command_error("Git divergence count", &output));
    }
    let counts = utf8_stdout(&output, "Git divergence count")?;
    let mut parts = counts.split_whitespace().map(str::parse::<u32>);
    match (parts.next(), parts.next()) {
        (Some(Ok(local)), Some(Ok(remote))) => Ok((local, remote)),
        _ => Err("Git returned an invalid divergence count".to_string()),
    }
}

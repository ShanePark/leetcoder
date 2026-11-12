use super::path::canonical_git_root;
use super::process::{combined_output, require_success, run_git, utf8_stdout};
use super::upstream::{configured_upstream, Upstream};
use crate::models::GitPushResult;

/// Push the current branch to its configured upstream without opening an
/// interactive credentials prompt.
pub(crate) fn push(project_root: &str) -> Result<GitPushResult, String> {
    let root = canonical_git_root(project_root)?;
    let Upstream {
        branch,
        remote,
        merge_ref,
    } = configured_upstream(&root)?;

    let refspec = format!("HEAD:{merge_ref}");
    let push_args = [
        "push".to_string(),
        "--porcelain".to_string(),
        "--no-follow-tags".to_string(),
        remote,
        refspec,
    ];
    let output = require_success("Git push", run_git(&root, push_args.iter())?)?;
    Ok(GitPushResult {
        output: combined_output(&output),
        branch: Some(branch),
    })
}

/// Count commits on the current branch that its upstream does not have yet.
///
/// A detached HEAD, an unborn branch, or a branch without a resolvable
/// upstream has nothing a push would publish, so each reports zero rather
/// than an error.
pub(crate) fn unpushed_commit_count(project_root: &str) -> Result<u32, String> {
    let root = canonical_git_root(project_root)?;
    let output = run_git(&root, ["rev-list", "--count", "@{upstream}..HEAD"])?;
    if !output.status.success() {
        return Ok(0);
    }
    utf8_stdout(&output, "Git unpushed commit count")?
        .trim()
        .parse()
        .map_err(|_| "Git returned an invalid unpushed commit count".to_string())
}

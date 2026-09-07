use super::path::canonical_git_root;
use super::process::{command_error, require_success, run_git, utf8_stdout};
use crate::models::GitPushResult;
use std::path::Path;

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

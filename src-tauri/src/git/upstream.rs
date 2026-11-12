use super::process::{command_error, run_git, utf8_stdout};
use std::path::Path;

/// The current branch and the remote branch it is configured to track.
pub(crate) struct Upstream {
    pub branch: String,
    pub remote: String,
    /// The full upstream branch ref, such as `refs/heads/main`.
    pub merge_ref: String,
}

impl Upstream {
    /// The upstream as Git displays it, such as `origin/main`.
    pub fn display_name(&self) -> String {
        let name = self
            .merge_ref
            .strip_prefix("refs/heads/")
            .unwrap_or(&self.merge_ref);
        format!("{}/{name}", self.remote)
    }
}

/// Read the current branch's `branch.<name>.remote` and `branch.<name>.merge`
/// configuration.
pub(crate) fn configured_upstream(root: &Path) -> Result<Upstream, String> {
    let branch = configured_branch(root)?;
    let remote = git_config_value(root, &format!("branch.{branch}.remote"))?.ok_or_else(|| {
        "No upstream remote is configured for the current branch. Configure one before pushing."
            .to_string()
    })?;
    let merge_ref =
        git_config_value(root, &format!("branch.{branch}.merge"))?.ok_or_else(|| {
            "No upstream branch is configured for the current branch. Configure one before pushing."
                .to_string()
        })?;
    if !merge_ref.starts_with("refs/heads/") {
        return Err(format!(
            "The configured upstream is not a branch ref: {merge_ref}"
        ));
    }
    Ok(Upstream {
        branch,
        remote,
        merge_ref,
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

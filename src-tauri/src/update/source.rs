use std::{
    path::{Path, PathBuf},
    process::Command,
};

use super::{UpdateStatus, EMBEDDED_BUILD_COMMIT, EMBEDDED_SOURCE_ROOT};

/// Whether this binary has the checkout metadata needed for a local update.
pub(crate) fn is_supported() -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        !EMBEDDED_SOURCE_ROOT.is_empty()
            && !EMBEDDED_BUILD_COMMIT.is_empty()
            && Path::new(EMBEDDED_SOURCE_ROOT).is_dir()
            && Path::new(EMBEDDED_SOURCE_ROOT).join(".git").exists()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

/// Read the checkout HEAD on every call. The frontend polls this value instead
/// of caching it so a local commit becomes visible without restarting first.
pub(crate) fn current_status() -> UpdateStatus {
    let current_commit = EMBEDDED_BUILD_COMMIT.to_string();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let supported = is_supported();
        let latest_commit = if supported {
            git_head(Path::new(EMBEDDED_SOURCE_ROOT)).unwrap_or_default()
        } else {
            String::new()
        };
        UpdateStatus {
            supported,
            available: commits_differ(&current_commit, &latest_commit),
            current_commit,
            latest_commit,
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        UpdateStatus {
            supported: false,
            available: false,
            current_commit,
            latest_commit: String::new(),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn validate_update_source() -> Result<(PathBuf, String), String> {
    if !is_supported() {
        return Err(
            "Self-updating is unavailable because the source checkout could not be found.".into(),
        );
    }
    let source_root = Path::new(EMBEDDED_SOURCE_ROOT).to_path_buf();
    let expected_commit = git_head(&source_root)?;
    if expected_commit == EMBEDDED_BUILD_COMMIT {
        return Err("No committed source update is available.".into());
    }
    ensure_worktree_clean(&source_root)?;
    Ok((source_root, expected_commit))
}

fn git_head(source_root: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--verify")
        .arg("HEAD")
        .current_dir(source_root)
        .output()
        .map_err(|error| format!("Could not run git in {}: {error}", source_root.display()))?;
    if !output.status.success() {
        return Err(format!(
            "Could not read the source HEAD in {}.",
            source_root.display()
        ));
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if commit.is_empty() {
        Err(format!(
            "The source repository in {} has no commit.",
            source_root.display()
        ))
    } else {
        Ok(commit)
    }
}

fn ensure_worktree_clean(source_root: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .arg("status")
        .arg("--porcelain=v1")
        .arg("--untracked-files=all")
        .current_dir(source_root)
        .output()
        .map_err(|error| format!("Could not inspect the source worktree: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not inspect the source worktree in {}.",
            source_root.display()
        ));
    }
    let status = String::from_utf8_lossy(&output.stdout);
    if !worktree_status_is_clean(&status) {
        return Err(
            "The source worktree has uncommitted or untracked files. Commit or remove them before updating."
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn worktree_status_is_clean(status: &str) -> bool {
    status.lines().all(|line| line.trim().is_empty())
}

pub(crate) fn commits_differ(current_commit: &str, latest_commit: &str) -> bool {
    !current_commit.is_empty() && !latest_commit.is_empty() && current_commit != latest_commit
}

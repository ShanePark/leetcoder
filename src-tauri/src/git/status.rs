use super::process::{require_success, run_git};
use crate::models::GitFileChange;
use crate::security::validate_git_relative_path;
use std::path::Path;

pub(crate) fn is_untracked_change(change: &GitFileChange) -> bool {
    change.index_status == "?" && change.worktree_status == "?"
}
pub(crate) fn list_changes_at_root(root: &Path) -> Result<Vec<GitFileChange>, String> {
    let output = require_success(
        "Git status",
        run_git(
            root,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?,
    )?;
    parse_status(&output.stdout)
}

pub(crate) fn parse_status(bytes: &[u8]) -> Result<Vec<GitFileChange>, String> {
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

pub(crate) fn status_char(byte: u8) -> Result<char, String> {
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

pub(crate) fn compact_status(index_status: char, worktree_status: char) -> String {
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

pub(crate) fn status_path(bytes: &[u8]) -> Result<String, String> {
    let path = String::from_utf8(bytes.to_vec())
        .map_err(|_| "Git returned a path that is not valid UTF-8".to_string())?;
    let normalized = validate_git_relative_path(&path)?;
    Ok(git_path_string(&normalized))
}

pub(crate) fn git_path_string(path: &Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

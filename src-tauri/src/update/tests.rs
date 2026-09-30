use super::progress::UPDATE_PROGRESS_TOTAL;
use super::{commits_differ, worktree_status_is_clean, UpdateProgress};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{
    progress::{truncate_detail, ProgressEmissionState, UPDATE_DETAIL_EMIT_INTERVAL},
    rebuild::{release_build_command, shell_path_or_fallback, UPDATE_BUILD_COMMAND},
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

#[test]
fn detects_only_non_empty_git_status_as_dirty() {
    assert!(worktree_status_is_clean(""));
    assert!(worktree_status_is_clean("\n  \n"));
    assert!(!worktree_status_is_clean(" M src/main.ts\n"));
    assert!(!worktree_status_is_clean("?? scratch.txt\n"));
}

#[test]
fn compares_non_empty_commits() {
    assert!(!commits_differ("abc", "abc"));
    assert!(commits_differ("abc", "def"));
    assert!(!commits_differ("", "def"));
    assert!(!commits_differ("abc", ""));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn release_build_uses_the_configured_login_interactive_shell() {
    let source_root = Path::new("/checkout/with spaces");
    let command = release_build_command(source_root, "expected-commit", "4201");
    let args = command
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(args, ["-l", "-i", "-c", UPDATE_BUILD_COMMAND]);
    assert_eq!(command.get_current_dir(), Some(source_root));
    assert!(command.get_envs().any(|(key, value)| {
        key == "LEETCODER_EXPECTED_COMMIT" && value.is_some_and(|value| value == "expected-commit")
    }));
    assert!(command.get_envs().any(|(key, value)| {
        key == "LEETCODER_UPDATE_OLD_PID" && value.is_some_and(|value| value == "4201")
    }));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn invalid_configured_shell_uses_safe_fallback() {
    assert_eq!(
        shell_path_or_fallback(Some(PathBuf::from("/definitely/missing/shell"))),
        PathBuf::from("/bin/sh")
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn truncates_live_build_detail_without_splitting_utf8() {
    let detail = truncate_detail(&"가".repeat(300));
    assert_eq!(detail.chars().count(), 241);
    assert!(detail.ends_with('…'));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn throttles_build_output_while_retaining_the_latest_detail() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::new();

    assert_eq!(
        state.record_detail("first", false, start),
        Some("first".to_string())
    );
    assert_eq!(state.record_detail("second", false, start), None);
    assert_eq!(state.record_detail("failed: details", true, start), None);
    assert_eq!(
        state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL),
        Some("failed: details".to_string())
    );
    assert_eq!(state.latest_diagnostic.as_deref(), Some("failed: details"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stage_transition_discards_stale_build_detail() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::new();
    assert_eq!(
        state.record_detail("still compiling", false, start),
        Some("still compiling".to_string())
    );
    assert_eq!(state.record_detail("latest line", false, start), None);

    state.finish_building();

    assert_eq!(state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL), None);
    assert_eq!(
        state.record_detail("installing", true, start + UPDATE_DETAIL_EMIT_INTERVAL),
        None
    );
    assert_eq!(state.latest_diagnostic.as_deref(), Some("installing"));
}

#[test]
fn progress_stages_are_ordered_and_complete() {
    let progress = [
        UpdateProgress::validating(),
        UpdateProgress::building(),
        UpdateProgress::preparing(),
        UpdateProgress::restarting(),
    ];
    assert_eq!(
        progress
            .iter()
            .map(|item| item.stage.as_str())
            .collect::<Vec<_>>(),
        ["validating", "building", "preparing", "restarting"]
    );
    assert_eq!(
        progress.iter().map(|item| item.step).collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert!(progress
        .iter()
        .all(|item| item.total == UPDATE_PROGRESS_TOTAL));
    assert!(progress.iter().all(|item| !item.message.is_empty()));
}

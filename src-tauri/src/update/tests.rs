use super::progress::{APPLY_PROGRESS_TOTAL, BUILD_PROGRESS_TOTAL};
use super::{commits_differ, worktree_status_is_clean, UpdateBuild, UpdateProgress};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{
    progress::{
        stage_progress, truncate_detail, ProgressEmissionState, UpdatePhase,
        UPDATE_DETAIL_EMIT_INTERVAL,
    },
    rebuild::{
        apply_staged_command, shell_path_or_fallback, stage_build_command, UPDATE_APPLY_COMMAND,
        UPDATE_BUILD_COMMAND,
    },
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{
    path::{Path, PathBuf},
    process::Command,
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
fn command_args(command: &Command) -> Vec<String> {
    command
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn command_env(command: &Command, name: &str) -> Option<Option<String>> {
    command
        .get_envs()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stage_build_runs_at_low_priority_in_the_login_interactive_shell() {
    let source_root = Path::new("/checkout/with spaces");
    let command = stage_build_command(source_root, "expected-commit");

    assert_eq!(
        UPDATE_BUILD_COMMAND,
        "exec nice -n 10 npm run rebuild -- --stage-only"
    );
    assert_eq!(
        command_args(&command),
        ["-l", "-i", "-c", UPDATE_BUILD_COMMAND]
    );
    assert_eq!(command.get_current_dir(), Some(source_root));
    assert_eq!(
        command_env(&command, "LEETCODER_EXPECTED_COMMIT"),
        Some(Some("expected-commit".to_string()))
    );
    // Removed rather than unset so an inherited value never reaches the script.
    assert_eq!(
        command_env(&command, "LEETCODER_UPDATE_OLD_PID"),
        Some(None)
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn apply_installs_the_ready_commit_and_stops_this_process() {
    let source_root = Path::new("/checkout/with spaces");
    let command = apply_staged_command(source_root, "ready-commit", "4201");

    assert_eq!(
        UPDATE_APPLY_COMMAND,
        "exec npm run rebuild -- --apply-staged"
    );
    assert_eq!(
        command_args(&command),
        ["-l", "-i", "-c", UPDATE_APPLY_COMMAND]
    );
    assert_eq!(command.get_current_dir(), Some(source_root));
    assert_eq!(
        command_env(&command, "LEETCODER_EXPECTED_COMMIT"),
        Some(Some("ready-commit".to_string()))
    );
    assert_eq!(
        command_env(&command, "LEETCODER_UPDATE_OLD_PID"),
        Some(Some("4201".to_string()))
    );
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
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Build);

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
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Build);
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn apply_phase_records_output_only_as_a_diagnostic() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Apply);

    assert_eq!(state.record_detail("stopping old app", false, start), None);
    assert_eq!(state.record_detail("install failed", true, start), None);
    assert_eq!(state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL), None);
    assert_eq!(state.latest_diagnostic.as_deref(), Some("install failed"));
}

#[test]
fn build_progress_stages_are_ordered_and_complete() {
    let progress = [
        UpdateProgress::validating(),
        UpdateProgress::building(),
        UpdateProgress::staging(),
    ];
    assert_eq!(
        progress
            .iter()
            .map(|item| item.stage.as_str())
            .collect::<Vec<_>>(),
        ["validating", "building", "staging"]
    );
    assert_eq!(
        progress.iter().map(|item| item.step).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert!(progress
        .iter()
        .all(|item| item.total == BUILD_PROGRESS_TOTAL));
    assert_eq!(BUILD_PROGRESS_TOTAL, 3);
    assert!(progress.iter().all(|item| !item.message.is_empty()));
}

#[test]
fn apply_progress_stages_are_ordered_and_complete() {
    let progress = [UpdateProgress::preparing(), UpdateProgress::restarting()];
    assert_eq!(
        progress
            .iter()
            .map(|item| item.stage.as_str())
            .collect::<Vec<_>>(),
        ["preparing", "restarting"]
    );
    assert_eq!(
        progress.iter().map(|item| item.step).collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(progress
        .iter()
        .all(|item| item.total == APPLY_PROGRESS_TOTAL));
    assert_eq!(APPLY_PROGRESS_TOTAL, 2);
    assert!(progress.iter().all(|item| !item.message.is_empty()));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn script_markers_map_to_stages_of_their_own_phase_only() {
    let stage = |phase, marker| stage_progress(phase, marker).map(|item| (item.stage, item.step));

    assert_eq!(
        stage(UpdatePhase::Build, "building"),
        Some(("building".to_string(), 2))
    );
    assert_eq!(
        stage(UpdatePhase::Build, "staging"),
        Some(("staging".to_string(), 3))
    );
    assert_eq!(stage(UpdatePhase::Build, "preparing"), None);
    assert_eq!(stage(UpdatePhase::Build, "restarting"), None);
    assert_eq!(
        stage(UpdatePhase::Apply, "preparing"),
        Some(("preparing".to_string(), 1))
    );
    assert_eq!(
        stage(UpdatePhase::Apply, "restarting"),
        Some(("restarting".to_string(), 2))
    );
    assert_eq!(stage(UpdatePhase::Apply, "building"), None);
    assert_eq!(stage(UpdatePhase::Apply, "staging"), None);
    assert_eq!(stage(UpdatePhase::Build, "unknown"), None);
}

#[test]
fn update_build_serializes_the_commit() {
    let build = UpdateBuild {
        commit: "abc123".into(),
    };
    assert_eq!(
        serde_json::to_value(build).unwrap(),
        serde_json::json!({ "commit": "abc123" })
    );
}

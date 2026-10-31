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

/// The (stage, step, message, detail) an emitted detail event carries.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn detail_event(progress: Option<UpdateProgress>) -> Option<(String, u8, String, String)> {
    progress.map(|item| {
        (
            item.stage,
            item.step,
            item.message,
            item.detail.expect("detail events carry detail"),
        )
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn expected_detail(stage: UpdateProgress, detail: &str) -> Option<(String, u8, String, String)> {
    Some((stage.stage, stage.step, stage.message, detail.to_string()))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn throttles_build_output_while_retaining_the_latest_detail() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Build);

    assert_eq!(
        detail_event(state.record_detail("first", false, start)),
        expected_detail(UpdateProgress::frontend(), "first")
    );
    assert!(state.record_detail("second", false, start).is_none());
    assert!(state
        .record_detail("failed: details", true, start)
        .is_none());
    assert_eq!(
        detail_event(state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL)),
        expected_detail(UpdateProgress::frontend(), "failed: details")
    );
    assert_eq!(state.latest_diagnostic.as_deref(), Some("failed: details"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn build_output_detail_follows_the_current_build_stage() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Build);
    assert_eq!(
        detail_event(state.record_detail("vite build", false, start)),
        expected_detail(UpdateProgress::frontend(), "vite build")
    );
    assert!(state
        .record_detail("pending frontend line", false, start)
        .is_none());

    state.enter_stage(&UpdateProgress::compiling());
    // The frontend line is stale once compiling starts, and the new stage
    // reports its first line without waiting for the throttle interval.
    assert!(state.flush(start).is_none());
    assert_eq!(
        detail_event(state.record_detail("Compiling serde", false, start)),
        expected_detail(UpdateProgress::compiling(), "Compiling serde")
    );

    state.enter_stage(&UpdateProgress::bundling());
    assert_eq!(
        detail_event(state.record_detail("Bundling app", false, start)),
        expected_detail(UpdateProgress::bundling(), "Bundling app")
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stage_transition_discards_stale_build_detail() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Build);
    assert_eq!(
        detail_event(state.record_detail("still compiling", false, start)),
        expected_detail(UpdateProgress::frontend(), "still compiling")
    );
    assert!(state.record_detail("latest line", false, start).is_none());

    state.enter_stage(&UpdateProgress::staging());

    assert!(state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL).is_none());
    assert!(state
        .record_detail("staging", true, start + UPDATE_DETAIL_EMIT_INTERVAL * 2)
        .is_none());
    assert_eq!(state.latest_diagnostic.as_deref(), Some("staging"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn apply_phase_records_output_only_as_a_diagnostic() {
    let start = Instant::now();
    let mut state = ProgressEmissionState::for_phase(UpdatePhase::Apply);

    assert!(state
        .record_detail("stopping old app", false, start)
        .is_none());
    assert!(state.record_detail("install failed", true, start).is_none());
    assert!(state.flush(start + UPDATE_DETAIL_EMIT_INTERVAL).is_none());

    // An apply-phase marker never turns build detail reporting on.
    state.enter_stage(&UpdateProgress::preparing());
    assert!(state.record_detail("copying", false, start).is_none());
    assert_eq!(state.latest_diagnostic.as_deref(), Some("install failed"));
}

#[test]
fn build_progress_stages_are_ordered_and_complete() {
    let progress = [
        UpdateProgress::validating(),
        UpdateProgress::frontend(),
        UpdateProgress::compiling(),
        UpdateProgress::bundling(),
        UpdateProgress::staging(),
    ];
    assert_eq!(
        progress
            .iter()
            .map(|item| item.stage.as_str())
            .collect::<Vec<_>>(),
        ["validating", "frontend", "compiling", "bundling", "staging"]
    );
    assert_eq!(
        progress.iter().map(|item| item.step).collect::<Vec<_>>(),
        [1, 1, 2, 3, 4]
    );
    assert_eq!(
        progress
            .iter()
            .map(|item| item.message.as_str())
            .collect::<Vec<_>>(),
        [
            "Checking the latest local commit",
            "Building the frontend",
            "Compiling the app",
            "Bundling the app",
            "Preparing the update",
        ]
    );
    assert!(progress
        .iter()
        .all(|item| item.total == BUILD_PROGRESS_TOTAL));
    assert_eq!(BUILD_PROGRESS_TOTAL, 4);
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

    // `building` is the marker older scripts emit before the frontend build.
    assert_eq!(
        stage(UpdatePhase::Build, "building"),
        Some(("frontend".to_string(), 1))
    );
    assert_eq!(
        stage(UpdatePhase::Build, "compiling"),
        Some(("compiling".to_string(), 2))
    );
    assert_eq!(
        stage(UpdatePhase::Build, "bundling"),
        Some(("bundling".to_string(), 3))
    );
    assert_eq!(
        stage(UpdatePhase::Build, "staging"),
        Some(("staging".to_string(), 4))
    );
    assert_eq!(stage(UpdatePhase::Build, "frontend"), None);
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
    assert_eq!(stage(UpdatePhase::Apply, "compiling"), None);
    assert_eq!(stage(UpdatePhase::Apply, "bundling"), None);
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

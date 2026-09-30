use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

mod progress;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod rebuild;
mod source;

#[cfg(test)]
mod tests;

pub(crate) use progress::UpdateProgress;
pub(crate) use source::current_status;
// Preserve existing update helper paths.
#[allow(unused_imports)]
pub(crate) use source::{commits_differ, is_supported, worktree_status_is_clean};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use progress::emit_update_progress;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use rebuild::run_rebuild;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use source::validate_update_source;

const EMBEDDED_SOURCE_ROOT: &str = env!("LEETCODER_SOURCE_ROOT");
const EMBEDDED_BUILD_COMMIT: &str = env!("LEETCODER_BUILD_COMMIT");
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub supported: bool,
    pub available: bool,
    pub current_commit: String,
    pub latest_commit: String,
}

struct UpdateGuard;

impl UpdateGuard {
    fn acquire() -> Result<Self, String> {
        UPDATE_IN_PROGRESS
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Self)
            .map_err(|_| "An update is already in progress.".to_string())
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub(crate) async fn check_for_update() -> UpdateStatus {
    tauri::async_runtime::spawn_blocking(current_status)
        .await
        .unwrap_or_else(|_| UpdateStatus {
            supported: false,
            available: false,
            current_commit: EMBEDDED_BUILD_COMMIT.to_string(),
            latest_commit: String::new(),
        })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub(crate) async fn check_for_update() -> UpdateStatus {
    current_status()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub(crate) async fn update_and_restart() -> Result<(), String> {
    Err("Self-updating is unavailable on this platform.".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub(crate) async fn update_and_restart(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = UpdateGuard::acquire()?;
    emit_update_progress(&app, UpdateProgress::validating());

    let (source_root, expected_commit) = validate_update_source()?;
    emit_update_progress(&app, UpdateProgress::building());

    let progress_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_rebuild(&progress_app, &source_root, &expected_commit)
    })
    .await
    .map_err(|error| format!("Update task failed: {error}"))??;

    // The existing installer stops the old process before atomically replacing
    // the bundle and then launches the fresh app. If it could not find the old
    // process, exiting here still guarantees that no stale instance remains.
    emit_update_progress(&app, UpdateProgress::preparing());
    emit_update_progress(&app, UpdateProgress::restarting());
    app.exit(0);
    Ok(())
}

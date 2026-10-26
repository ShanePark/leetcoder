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
use rebuild::{apply_staged_update, stage_update_build};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use source::{update_source_root, validate_update_source};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::sync::Mutex;

const EMBEDDED_SOURCE_ROOT: &str = env!("LEETCODER_SOURCE_ROOT");
const EMBEDDED_BUILD_COMMIT: &str = env!("LEETCODER_BUILD_COMMIT");
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
/// Commit of the staged build that `apply_update` installs. It is kept even
/// when newer commits appear so the restart installs exactly what was built.
#[cfg(any(target_os = "macos", target_os = "linux"))]
static READY_COMMIT: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub supported: bool,
    pub available: bool,
    pub current_commit: String,
    pub latest_commit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBuild {
    pub commit: String,
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
pub(crate) async fn build_update() -> Result<UpdateBuild, String> {
    Err("Self-updating is unavailable on this platform.".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub(crate) async fn apply_update() -> Result<(), String> {
    Err("Self-updating is unavailable on this platform.".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub(crate) async fn build_update(app: tauri::AppHandle) -> Result<UpdateBuild, String> {
    let _guard = UpdateGuard::acquire()?;
    // Staging replaces any previously staged build, so it is no longer ready.
    set_ready_commit(None);
    emit_update_progress(&app, UpdateProgress::validating());

    let (source_root, expected_commit) = validate_update_source()?;
    emit_update_progress(&app, UpdateProgress::building());

    let progress_app = app.clone();
    let commit = expected_commit.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stage_update_build(&progress_app, &source_root, &commit)
    })
    .await
    .map_err(|error| format!("Update task failed: {error}"))??;

    set_ready_commit(Some(expected_commit.clone()));
    Ok(UpdateBuild {
        commit: expected_commit,
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub(crate) async fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = UpdateGuard::acquire()?;
    let ready_commit = ready_commit().ok_or_else(|| "No update build is ready.".to_string())?;
    let source_root = update_source_root()?;
    emit_update_progress(&app, UpdateProgress::preparing());

    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        apply_staged_update(&progress_app, &source_root, &ready_commit)
    })
    .await
    .map_err(|error| format!("Update task failed: {error}"))
    .and_then(|result| result);
    if let Err(error) = result {
        set_ready_commit(None);
        return Err(error);
    }

    // The installer stops the old process before atomically replacing the
    // bundle and then launches the fresh app. If it could not find the old
    // process, exiting here still guarantees that no stale instance remains.
    emit_update_progress(&app, UpdateProgress::restarting());
    app.exit(0);
    Ok(())
}

/// Cancels a running background build. Called when the app exits so an
/// abandoned build does not keep compiling.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn cancel_running_build() {
    rebuild::terminate_running_build();
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn cancel_running_build() {}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn ready_commit() -> Option<String> {
    READY_COMMIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn set_ready_commit(commit: Option<String>) {
    *READY_COMMIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = commit;
}

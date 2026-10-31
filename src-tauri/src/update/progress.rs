use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::Emitter;

const UPDATE_PROGRESS_EVENT: &str = "update-progress";
pub(super) const BUILD_PROGRESS_TOTAL: u8 = 4;
pub(super) const APPLY_PROGRESS_TOTAL: u8 = 2;
const UPDATE_STAGE_PREFIX: &str = "LEETCODER_UPDATE_STAGE:";
pub(super) const UPDATE_DETAIL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const UPDATE_DETAIL_MAX_CHARS: usize = 240;

/// The two independently reported halves of an update: building and staging
/// the release in the background, then installing it and restarting.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UpdatePhase {
    Build,
    Apply,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateProgress {
    pub stage: String,
    pub step: u8,
    pub total: u8,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl UpdateProgress {
    pub(super) fn validating() -> Self {
        Self::new(
            "validating",
            1,
            BUILD_PROGRESS_TOTAL,
            "Checking the latest local commit",
        )
    }

    /// Validation and the frontend build share step 1: validation is quick,
    /// and the frontend build starts right after it.
    pub(super) fn frontend() -> Self {
        Self::new("frontend", 1, BUILD_PROGRESS_TOTAL, "Building the frontend")
    }

    pub(super) fn compiling() -> Self {
        Self::new("compiling", 2, BUILD_PROGRESS_TOTAL, "Compiling the app")
    }

    pub(super) fn bundling() -> Self {
        Self::new("bundling", 3, BUILD_PROGRESS_TOTAL, "Bundling the app")
    }

    pub(super) fn staging() -> Self {
        Self::new("staging", 4, BUILD_PROGRESS_TOTAL, "Preparing the update")
    }

    pub(super) fn preparing() -> Self {
        Self::new(
            "preparing",
            1,
            APPLY_PROGRESS_TOTAL,
            "Installing the update",
        )
    }

    pub(super) fn restarting() -> Self {
        Self::new(
            "restarting",
            2,
            APPLY_PROGRESS_TOTAL,
            "Restarting leetcoder",
        )
    }

    /// Live build output is only reported while the release build runs.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn reports_build_output(&self) -> bool {
        matches!(self.stage.as_str(), "frontend" | "compiling" | "bundling")
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn with_detail(&self, detail: String) -> Self {
        Self {
            detail: Some(detail),
            ..self.clone()
        }
    }

    fn new(stage: &str, step: u8, total: u8, message: &str) -> Self {
        Self {
            stage: stage.into(),
            step,
            total,
            message: message.into(),
            detail: None,
        }
    }
}

/// Maps a script stage marker to the progress it reports in `phase`. Markers
/// that belong to the other phase, or are unknown, are ignored. The script
/// still emits `building` before the frontend build because older installed
/// apps only understand `building` and `staging`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn stage_progress(phase: UpdatePhase, stage: &str) -> Option<UpdateProgress> {
    match (phase, stage) {
        (UpdatePhase::Build, "building") => Some(UpdateProgress::frontend()),
        (UpdatePhase::Build, "compiling") => Some(UpdateProgress::compiling()),
        (UpdatePhase::Build, "bundling") => Some(UpdateProgress::bundling()),
        (UpdatePhase::Build, "staging") => Some(UpdateProgress::staging()),
        (UpdatePhase::Apply, "preparing") => Some(UpdateProgress::preparing()),
        (UpdatePhase::Apply, "restarting") => Some(UpdateProgress::restarting()),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn emit_update_progress(app: &tauri::AppHandle, progress: UpdateProgress) {
    if let Err(error) = app.emit(UPDATE_PROGRESS_EVENT, progress) {
        // A disappearing webview must not prevent the detached installer from
        // finishing its atomic replacement and relaunch.
        eprintln!("Could not report update progress: {error}");
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct UpdateProgressReporter {
    app: tauri::AppHandle,
    phase: UpdatePhase,
    state: Mutex<ProgressEmissionState>,
    emission_lock: Mutex<()>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl UpdateProgressReporter {
    pub(super) fn new(app: tauri::AppHandle, phase: UpdatePhase) -> Self {
        Self {
            app,
            phase,
            state: Mutex::new(ProgressEmissionState::for_phase(phase)),
            emission_lock: Mutex::new(()),
        }
    }

    fn report_detail(&self, value: &str, diagnostic: bool) {
        let _emission_lock = self
            .emission_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let progress = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.record_detail(value, diagnostic, Instant::now())
        };
        if let Some(progress) = progress {
            emit_update_progress(&self.app, progress);
        }
    }

    fn report_stage(&self, stage: &str) {
        let _emission_lock = self
            .emission_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let progress = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let progress = stage_progress(self.phase, stage);
            if let Some(progress) = progress.as_ref() {
                state.enter_stage(progress);
            }
            progress
        };
        if let Some(progress) = progress {
            emit_update_progress(&self.app, progress);
        }
    }

    pub(super) fn finish(&self) {
        let _emission_lock = self
            .emission_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let progress = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.flush(Instant::now())
        };
        if let Some(progress) = progress {
            emit_update_progress(&self.app, progress);
        }
    }

    pub(super) fn latest_diagnostic(&self) -> Option<String> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .latest_diagnostic
            .clone()
            .or_else(|| state.latest_detail.clone())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Default)]
pub(super) struct ProgressEmissionState {
    last_emitted_at: Option<Instant>,
    pending_detail: Option<String>,
    latest_detail: Option<String>,
    pub(super) latest_diagnostic: Option<String>,
    /// The build stage that live output detail is reported under, if any.
    detail_stage: Option<UpdateProgress>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ProgressEmissionState {
    /// Build output detail is only reported during the release build; the
    /// build phase starts in the frontend stage because it is announced
    /// before the script runs.
    pub(super) fn for_phase(phase: UpdatePhase) -> Self {
        Self {
            detail_stage: (phase == UpdatePhase::Build).then(UpdateProgress::frontend),
            ..Self::default()
        }
    }

    pub(super) fn record_detail(
        &mut self,
        value: &str,
        diagnostic: bool,
        now: Instant,
    ) -> Option<UpdateProgress> {
        let detail = truncate_detail(value);
        if detail.is_empty() {
            return None;
        }
        let duplicate = self.latest_detail.as_deref() == Some(detail.as_str());
        self.latest_detail = Some(detail.clone());
        if diagnostic {
            self.latest_diagnostic = Some(detail.clone());
        }
        if duplicate {
            return None;
        }
        let stage = self.detail_stage.as_ref()?;

        self.pending_detail = Some(detail);
        let should_emit = self
            .last_emitted_at
            .map(|last| now.saturating_duration_since(last) >= UPDATE_DETAIL_EMIT_INTERVAL)
            .unwrap_or(true);
        if should_emit {
            self.last_emitted_at = Some(now);
            self.pending_detail
                .take()
                .map(|detail| stage.with_detail(detail))
        } else {
            None
        }
    }

    /// Switches detail reporting to `progress`. Pending detail from the
    /// previous stage is discarded so it is never shown under the new one.
    pub(super) fn enter_stage(&mut self, progress: &UpdateProgress) {
        self.pending_detail = None;
        if progress.reports_build_output() {
            self.detail_stage = Some(progress.clone());
            self.last_emitted_at = None;
        } else {
            self.detail_stage = None;
        }
    }

    pub(super) fn flush(&mut self, now: Instant) -> Option<UpdateProgress> {
        let Some(stage) = self.detail_stage.as_ref() else {
            self.pending_detail = None;
            return None;
        };
        let detail = self.pending_detail.take()?;
        self.last_emitted_at = Some(now);
        Some(stage.with_detail(detail))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn spawn_output_reader<R>(
    reporter: Arc<UpdateProgressReporter>,
    reader: R,
    diagnostic: bool,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(stage) = trimmed.strip_prefix(UPDATE_STAGE_PREFIX) {
                reporter.report_stage(stage.trim());
            } else {
                reporter.report_detail(trimmed, diagnostic);
            }
        }
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn truncate_detail(value: &str) -> String {
    let mut chars = value.chars();
    let mut detail = chars
        .by_ref()
        .take(UPDATE_DETAIL_MAX_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        detail.push('…');
    }
    detail
}

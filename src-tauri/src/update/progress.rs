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
pub(super) const UPDATE_PROGRESS_TOTAL: u8 = 4;
const UPDATE_STAGE_PREFIX: &str = "LEETCODER_UPDATE_STAGE:";
pub(super) const UPDATE_DETAIL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const UPDATE_DETAIL_MAX_CHARS: usize = 240;

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
        Self::new("validating", 1, "Checking the latest local commit")
    }

    pub(super) fn building() -> Self {
        Self::new("building", 2, "Building a fresh release")
    }

    pub(super) fn preparing() -> Self {
        Self::new("preparing", 3, "Installing the updated application")
    }

    pub(super) fn restarting() -> Self {
        Self::new("restarting", 4, "Restarting leetcoder")
    }

    fn building_with_detail(detail: String) -> Self {
        Self {
            detail: Some(detail),
            ..Self::building()
        }
    }

    fn new(stage: &str, step: u8, message: &str) -> Self {
        Self {
            stage: stage.into(),
            step,
            total: UPDATE_PROGRESS_TOTAL,
            message: message.into(),
            detail: None,
        }
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
    state: Mutex<ProgressEmissionState>,
    emission_lock: Mutex<()>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl UpdateProgressReporter {
    pub(super) fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            state: Mutex::new(ProgressEmissionState::new()),
            emission_lock: Mutex::new(()),
        }
    }

    fn report_detail(&self, value: &str, diagnostic: bool) {
        let _emission_lock = self
            .emission_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let detail = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.record_detail(value, diagnostic, Instant::now())
        };
        if let Some(detail) = detail {
            emit_update_progress(&self.app, UpdateProgress::building_with_detail(detail));
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
            match stage {
                "building" => {
                    state.start_building();
                    Some(UpdateProgress::building())
                }
                "preparing" => {
                    state.finish_building();
                    Some(UpdateProgress::preparing())
                }
                "restarting" => {
                    state.finish_building();
                    Some(UpdateProgress::restarting())
                }
                _ => None,
            }
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
        let detail = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.flush(Instant::now())
        };
        if let Some(detail) = detail {
            emit_update_progress(&self.app, UpdateProgress::building_with_detail(detail));
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
    building: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ProgressEmissionState {
    pub(super) fn new() -> Self {
        Self {
            building: true,
            ..Self::default()
        }
    }

    pub(super) fn record_detail(
        &mut self,
        value: &str,
        diagnostic: bool,
        now: Instant,
    ) -> Option<String> {
        let detail = truncate_detail(value);
        if detail.is_empty() {
            return None;
        }
        let duplicate = self.latest_detail.as_deref() == Some(detail.as_str());
        self.latest_detail = Some(detail.clone());
        if diagnostic {
            self.latest_diagnostic = Some(detail.clone());
        }
        if duplicate || !self.building {
            return None;
        }

        self.pending_detail = Some(detail);
        let should_emit = self
            .last_emitted_at
            .map(|last| now.saturating_duration_since(last) >= UPDATE_DETAIL_EMIT_INTERVAL)
            .unwrap_or(true);
        if should_emit {
            self.last_emitted_at = Some(now);
            self.pending_detail.take()
        } else {
            None
        }
    }

    fn start_building(&mut self) {
        self.building = true;
        self.last_emitted_at = None;
        self.pending_detail = None;
    }

    pub(super) fn finish_building(&mut self) {
        self.building = false;
        self.pending_detail = None;
    }

    pub(super) fn flush(&mut self, now: Instant) -> Option<String> {
        if !self.building {
            self.pending_detail = None;
            return None;
        }
        let detail = self.pending_detail.take();
        if detail.is_some() {
            self.last_emitted_at = Some(now);
        }
        detail
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

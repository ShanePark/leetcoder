use serde::Serialize;
use std::{
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::ffi::CStr;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::Emitter;

const EMBEDDED_SOURCE_ROOT: &str = env!("LEETCODER_SOURCE_ROOT");
const EMBEDDED_BUILD_COMMIT: &str = env!("LEETCODER_BUILD_COMMIT");
const UPDATE_PROGRESS_EVENT: &str = "update-progress";
const UPDATE_PROGRESS_TOTAL: u8 = 4;
const UPDATE_STAGE_PREFIX: &str = "LEETCODER_UPDATE_STAGE:";
const UPDATE_DETAIL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const UPDATE_DETAIL_MAX_CHARS: usize = 240;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const UPDATE_BUILD_COMMAND: &str = "exec npm run rebuild";

static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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
pub(crate) struct UpdateProgress {
    pub stage: String,
    pub step: u8,
    pub total: u8,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl UpdateProgress {
    fn validating() -> Self {
        Self::new("validating", 1, "Checking the latest local commit")
    }

    fn building() -> Self {
        Self::new("building", 2, "Building a fresh release")
    }

    fn preparing() -> Self {
        Self::new("preparing", 3, "Installing the updated application")
    }

    fn restarting() -> Self {
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
fn emit_update_progress(app: &tauri::AppHandle, progress: UpdateProgress) {
    if let Err(error) = app.emit(UPDATE_PROGRESS_EVENT, progress) {
        // A disappearing webview must not prevent the detached installer from
        // finishing its atomic replacement and relaunch.
        eprintln!("Could not report update progress: {error}");
    }
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
        let latest_commit = if is_supported() {
            git_head(Path::new(EMBEDDED_SOURCE_ROOT)).unwrap_or_default()
        } else {
            String::new()
        };
        UpdateStatus {
            supported: is_supported(),
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn validate_update_source() -> Result<(PathBuf, String), String> {
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_rebuild(
    app: &tauri::AppHandle,
    source_root: &Path,
    expected_commit: &str,
) -> Result<(), String> {
    // The installer is detached before this process exits. Passing our PID
    // explicitly lets the rebuild script stop exactly this stale instance
    // instead of relying on a broad process-name match.
    let old_pid = std::process::id().to_string();
    let mut command = release_build_command(source_root, expected_commit, &old_pid);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // The rebuild must survive the app process exiting after install, and
        // must not share the app's terminal/process group.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start npm run rebuild: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reporter = Arc::new(UpdateProgressReporter::new(app.clone()));
    let stdout_reader = stdout.map(|reader| spawn_output_reader(reporter.clone(), reader, false));
    let stderr_reader = stderr.map(|reader| spawn_output_reader(reporter.clone(), reader, true));
    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for npm run rebuild: {error}"))?;
    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    reporter.finish();
    if !status.success() {
        let status = format!("npm run rebuild failed (status {status}).");
        return match reporter.latest_diagnostic() {
            Some(detail) => Err(format!("{status} Last output: {detail}")),
            None => Err(status),
        };
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn release_build_command(source_root: &Path, expected_commit: &str, old_pid: &str) -> Command {
    let mut command = shell_command(UPDATE_BUILD_COMMAND);
    command
        .env("LEETCODER_EXPECTED_COMMIT", expected_commit)
        .env("LEETCODER_UPDATE_OLD_PID", old_pid)
        .current_dir(source_root);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_command(value: &str) -> Command {
    let mut command = Command::new(configured_shell());
    // Desktop launchers provide a minimal PATH. Login-interactive mode loads
    // the user's shell setup, including fnm/nvm-managed Node and npm paths.
    command.args(["-l", "-i", "-c", value]);
    command
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn configured_shell() -> PathBuf {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| is_usable_shell(path))
        .or_else(login_shell_from_passwd);
    shell_path_or_fallback(shell)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn login_shell_from_passwd() -> Option<PathBuf> {
    let passwd = unsafe { libc::getpwuid(libc::getuid()) };
    if passwd.is_null() || unsafe { (*passwd).pw_shell.is_null() } {
        return None;
    }
    let shell = unsafe { CStr::from_ptr((*passwd).pw_shell) }
        .to_string_lossy()
        .into_owned();
    (!shell.is_empty()).then(|| PathBuf::from(shell))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_path_or_fallback(candidate: Option<PathBuf>) -> PathBuf {
    candidate
        .filter(|path| is_usable_shell(path))
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn is_usable_shell(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct UpdateProgressReporter {
    app: tauri::AppHandle,
    state: Mutex<ProgressEmissionState>,
    emission_lock: Mutex<()>,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl UpdateProgressReporter {
    fn new(app: tauri::AppHandle) -> Self {
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

    fn finish(&self) {
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

    fn latest_diagnostic(&self) -> Option<String> {
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
struct ProgressEmissionState {
    last_emitted_at: Option<Instant>,
    pending_detail: Option<String>,
    latest_detail: Option<String>,
    latest_diagnostic: Option<String>,
    building: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl ProgressEmissionState {
    fn new() -> Self {
        Self {
            building: true,
            ..Self::default()
        }
    }

    fn record_detail(&mut self, value: &str, diagnostic: bool, now: Instant) -> Option<String> {
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

    fn finish_building(&mut self) {
        self.building = false;
        self.pending_detail = None;
    }

    fn flush(&mut self, now: Instant) -> Option<String> {
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
fn spawn_output_reader<R>(
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
fn truncate_detail(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            key == "LEETCODER_EXPECTED_COMMIT"
                && value.is_some_and(|value| value == "expected-commit")
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
}

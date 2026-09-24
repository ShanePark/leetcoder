use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::models::{
    ProblemTestEvent, ProblemTestOutputStream, ProblemTestProgressCase, ProblemTestProgressPhase,
    ProblemTestProgressStatus,
};

use super::{ProblemTestEventSink, TEST_EVENT_MARKER};

pub(crate) const TEST_EXECUTION_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(200);

const PENDING_STOP_TTL: Duration = Duration::from_secs(30);
const MAX_PENDING_STOPS: usize = 64;
const MAX_FINISHED_RUNS: usize = 128;

#[derive(Default)]
struct TestRunRegistry {
    active: HashMap<u64, Arc<TestRunControl>>,
    pending_stops: HashMap<u64, Instant>,
    finished: HashMap<u64, Instant>,
}

static ACTIVE_TEST_RUNS: OnceLock<Mutex<TestRunRegistry>> = OnceLock::new();

fn active_test_runs() -> &'static Mutex<TestRunRegistry> {
    ACTIVE_TEST_RUNS.get_or_init(|| Mutex::new(TestRunRegistry::default()))
}

fn expire_pending_stops(registry: &mut TestRunRegistry) {
    registry
        .pending_stops
        .retain(|_, created_at| created_at.elapsed() < PENDING_STOP_TTL);
    registry
        .finished
        .retain(|_, finished_at| finished_at.elapsed() < PENDING_STOP_TTL);
}

fn prune_finished_runs(registry: &mut TestRunRegistry) {
    while registry.finished.len() > MAX_FINISHED_RUNS {
        let Some(oldest_run_id) = registry
            .finished
            .iter()
            .min_by_key(|(_, finished_at)| **finished_at)
            .map(|(id, _)| *id)
        else {
            break;
        };
        registry.finished.remove(&oldest_run_id);
    }
}

#[derive(Debug)]
pub(crate) struct TestRunControl {
    cancel_requested: AtomicBool,
    timed_out: AtomicBool,
    process_interrupted: AtomicBool,
    process_finished: AtomicBool,
    tests_started_at: Mutex<Option<Instant>>,
}

impl TestRunControl {
    pub(crate) fn new() -> Self {
        Self {
            cancel_requested: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
            process_interrupted: AtomicBool::new(false),
            process_finished: AtomicBool::new(false),
            tests_started_at: Mutex::new(None),
        }
    }

    fn mark_tests_started(&self) {
        let mut started_at = self
            .tests_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        started_at.get_or_insert_with(Instant::now);
    }

    fn tests_elapsed(&self) -> Option<Duration> {
        self.tests_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(Instant::elapsed)
    }

    fn request_cancel(&self) -> bool {
        if self.process_finished.load(Ordering::Acquire) {
            return false;
        }
        self.cancel_requested.store(true, Ordering::Release);
        !self.process_finished.load(Ordering::Acquire)
    }

    fn request_timeout(&self) {
        self.timed_out.store(true, Ordering::Release);
        self.cancel_requested.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub(crate) fn is_timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Acquire)
    }

    fn mark_process_interrupted(&self) {
        self.process_interrupted.store(true, Ordering::Release);
    }

    fn was_process_interrupted(&self) -> bool {
        self.process_interrupted.load(Ordering::Acquire)
    }

    pub(crate) fn mark_process_finished(&self) {
        self.process_finished.store(true, Ordering::Release);
    }
}

pub(crate) struct TestRunRegistration {
    run_id: u64,
    control: Arc<TestRunControl>,
}

impl TestRunRegistration {
    pub(crate) fn control(&self) -> Arc<TestRunControl> {
        self.control.clone()
    }
}

impl Drop for TestRunRegistration {
    fn drop(&mut self) {
        let mut runs = active_test_runs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runs
            .active
            .get(&self.run_id)
            .is_some_and(|control| Arc::ptr_eq(control, &self.control))
        {
            runs.active.remove(&self.run_id);
            runs.finished.insert(self.run_id, Instant::now());
            prune_finished_runs(&mut runs);
        }
    }
}

pub(crate) fn register_test_run(run_id: u64) -> Result<TestRunRegistration, String> {
    let mut runs = active_test_runs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    expire_pending_stops(&mut runs);
    if runs.active.contains_key(&run_id) {
        return Err(format!("Test run id {run_id} is already active."));
    }
    runs.finished.remove(&run_id);
    let control = Arc::new(TestRunControl::new());
    if runs.pending_stops.remove(&run_id).is_some() {
        control.request_cancel();
    }
    runs.active.insert(run_id, control.clone());
    Ok(TestRunRegistration { run_id, control })
}

pub(crate) fn stop_test_run(run_id: u64) -> bool {
    let mut runs = active_test_runs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    expire_pending_stops(&mut runs);
    if let Some(control) = runs.active.get(&run_id) {
        return control.request_cancel();
    }
    if runs.finished.contains_key(&run_id) {
        return false;
    }
    if runs.pending_stops.len() >= MAX_PENDING_STOPS {
        if let Some(oldest_run_id) = runs
            .pending_stops
            .iter()
            .min_by_key(|(_, created_at)| **created_at)
            .map(|(id, _)| *id)
        {
            runs.pending_stops.remove(&oldest_run_id);
        }
    }
    runs.pending_stops.insert(run_id, Instant::now());
    true
}

pub(crate) fn isolate_test_process_session(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // Gradle and its test workers must share an isolated process group so
        // a Stop request can terminate every process belonging to this run.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub(crate) fn emit_event(sink: &Option<ProblemTestEventSink>, event: ProblemTestEvent) {
    if let Some(sink) = sink {
        sink(event);
    }
}

#[derive(Debug, Default)]
pub(crate) struct ChildOutputCapture {
    pub(crate) exit_code: Option<i32>,
    pub(crate) process_success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) cancelled: bool,
    pub(crate) timed_out: bool,
}

pub(crate) fn capture_child_output(
    child: Child,
    sink: Option<ProblemTestEventSink>,
) -> ChildOutputCapture {
    capture_child_output_inner(child, sink, None, None)
}

pub(crate) fn capture_cancellable_child_output(
    child: Child,
    sink: Option<ProblemTestEventSink>,
    control: Arc<TestRunControl>,
) -> ChildOutputCapture {
    capture_child_output_inner(child, sink, Some(control), Some(TEST_EXECUTION_TIMEOUT))
}

#[cfg(test)]
pub(crate) fn capture_test_child_output_with_timeout(
    child: Child,
    sink: Option<ProblemTestEventSink>,
    timeout: Duration,
) -> ChildOutputCapture {
    capture_test_child_output_with_control(child, sink, Arc::new(TestRunControl::new()), timeout)
}

#[cfg(test)]
pub(crate) fn capture_test_child_output_with_control(
    child: Child,
    sink: Option<ProblemTestEventSink>,
    control: Arc<TestRunControl>,
    timeout: Duration,
) -> ChildOutputCapture {
    capture_child_output_inner(child, sink, Some(control), Some(timeout))
}

fn capture_child_output_inner(
    mut child: Child,
    sink: Option<ProblemTestEventSink>,
    control: Option<Arc<TestRunControl>>,
    timeout: Option<Duration>,
) -> ChildOutputCapture {
    let running_phase_emitted = Arc::new(AtomicBool::new(false));
    let stdout_handle = child.stdout.take().map(|stdout| {
        spawn_stream_reader(
            stdout,
            ProblemTestOutputStream::Stdout,
            sink.clone(),
            running_phase_emitted.clone(),
            control.clone(),
        )
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        spawn_stream_reader(
            stderr,
            ProblemTestOutputStream::Stderr,
            sink.clone(),
            running_phase_emitted,
            control.clone(),
        )
    });

    let wait_result = match (&control, timeout) {
        (Some(control), Some(timeout)) => wait_for_cancellable_child(&mut child, control, timeout),
        _ => child.wait(),
    };
    if let Some(control) = &control {
        control.mark_process_finished();
    }
    let mut capture = ChildOutputCapture {
        exit_code: wait_result.as_ref().ok().and_then(|status| status.code()),
        process_success: wait_result
            .as_ref()
            .map(std::process::ExitStatus::success)
            .unwrap_or(false),
        stdout: join_stream_reader(stdout_handle),
        stderr: join_stream_reader(stderr_handle),
        cancelled: control
            .as_ref()
            .is_some_and(|control| control.was_process_interrupted() && !control.is_timed_out()),
        timed_out: control
            .as_ref()
            .is_some_and(|control| control.is_timed_out()),
    };
    if let Err(error) = wait_result {
        let message = format!("Unable to wait for Gradle wrapper: {error}");
        if !capture.stderr.is_empty() && !capture.stderr.ends_with('\n') {
            capture.stderr.push('\n');
        }
        capture.stderr.push_str(&message);
        emit_event(
            &sink,
            ProblemTestEvent::Log {
                stream: ProblemTestOutputStream::Stderr,
                text: message,
            },
        );
    }
    capture
}

fn wait_for_cancellable_child(
    child: &mut Child,
    control: &TestRunControl,
    timeout: Duration,
) -> io::Result<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                control.mark_process_finished();
                return Ok(status);
            }
            Ok(None) => {}
            Err(error) => return Err(error),
        }

        if control.is_cancel_requested() {
            control.mark_process_interrupted();
            return terminate_process_tree(child);
        }
        if control
            .tests_elapsed()
            .is_some_and(|elapsed| elapsed >= timeout)
        {
            control.request_timeout();
            control.mark_process_interrupted();
            return terminate_process_tree(child);
        }

        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn terminate_process_tree(child: &mut Child) -> io::Result<ExitStatus> {
    #[cfg(unix)]
    {
        let process_group = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
        match child.wait() {
            Ok(status) => Ok(status),
            Err(error) => {
                let _ = child.kill();
                Err(error)
            }
        }
    }
    #[cfg(not(unix))]
    {
        child.kill()?;
        child.wait()
    }
}

pub(crate) fn spawn_stream_reader<R: Read + Send + 'static>(
    reader: R,
    stream: ProblemTestOutputStream,
    sink: Option<ProblemTestEventSink>,
    running_phase_emitted: Arc<AtomicBool>,
    control: Option<Arc<TestRunControl>>,
) -> JoinHandle<String> {
    thread::spawn(move || {
        read_stream_with_control(reader, stream, sink, running_phase_emitted, control)
    })
}

pub(crate) fn join_stream_reader(handle: Option<JoinHandle<String>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn read_stream<R: Read>(
    reader: R,
    stream: ProblemTestOutputStream,
    sink: Option<ProblemTestEventSink>,
    running_phase_emitted: Arc<AtomicBool>,
) -> String {
    read_stream_with_control(reader, stream, sink, running_phase_emitted, None)
}

fn read_stream_with_control<R: Read>(
    reader: R,
    stream: ProblemTestOutputStream,
    sink: Option<ProblemTestEventSink>,
    running_phase_emitted: Arc<AtomicBool>,
    control: Option<Arc<TestRunControl>>,
) -> String {
    let mut reader = BufReader::new(reader);
    let mut output = String::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let bytes_read = match reader.read_until(b'\n', &mut line) {
            Ok(bytes_read) => bytes_read,
            Err(_) => break,
        };
        if bytes_read == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&line).into_owned();
        if stream == ProblemTestOutputStream::Stdout {
            if let Some(marker) = parse_test_progress_marker(&text) {
                match marker.kind.as_str() {
                    "started" => {
                        if let Some(control) = &control {
                            control.mark_tests_started();
                        }
                        if !running_phase_emitted.swap(true, Ordering::AcqRel) {
                            emit_event(
                                &sink,
                                ProblemTestEvent::Phase {
                                    phase: ProblemTestProgressPhase::RunningTests,
                                },
                            );
                        }
                        emit_event(
                            &sink,
                            ProblemTestEvent::TestStarted {
                                test: progress_case_from_marker(
                                    &marker,
                                    ProblemTestProgressStatus::Running,
                                ),
                            },
                        );
                    }
                    "finished" => emit_event(
                        &sink,
                        ProblemTestEvent::TestFinished {
                            test: progress_case_from_marker(&marker, marker_status(&marker)),
                        },
                    ),
                    _ => emit_log(&sink, stream, &text),
                }
                continue;
            }
        }
        output.push_str(&text);
        emit_log(&sink, stream, &text);
    }
    output
}

pub(crate) fn emit_log(
    sink: &Option<ProblemTestEventSink>,
    stream: ProblemTestOutputStream,
    text: &str,
) {
    if !text.is_empty() {
        // Keep the line ending so consumers can append chunks directly to
        // their live console without having to reconstruct line boundaries.
        emit_event(
            sink,
            ProblemTestEvent::Log {
                stream,
                text: text.to_string(),
            },
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestProgressMarker {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) class_name: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) duration_ms: Option<u64>,
    #[serde(default)]
    pub(crate) message: Option<String>,
    #[serde(default)]
    pub(crate) details: Option<String>,
}

pub(crate) fn parse_test_progress_marker(line: &str) -> Option<TestProgressMarker> {
    let line = line.trim_end_matches(&['\r', '\n'][..]);
    let payload = line.strip_prefix(TEST_EVENT_MARKER)?;
    serde_json::from_str(payload).ok()
}

pub(crate) fn marker_status(marker: &TestProgressMarker) -> ProblemTestProgressStatus {
    match marker
        .status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "passed" | "success" | "successful" => ProblemTestProgressStatus::Passed,
        "failed" | "failure" => ProblemTestProgressStatus::Failed,
        "skipped" | "skip" => ProblemTestProgressStatus::Skipped,
        "running" | "started" => ProblemTestProgressStatus::Running,
        _ => ProblemTestProgressStatus::Error,
    }
}

pub(crate) fn progress_case_from_marker(
    marker: &TestProgressMarker,
    default_status: ProblemTestProgressStatus,
) -> ProblemTestProgressCase {
    ProblemTestProgressCase {
        class_name: marker.class_name.clone(),
        name: marker.name.clone(),
        display_name: marker.display_name.clone(),
        status: if marker.status.is_some() {
            marker_status(marker)
        } else {
            default_status
        },
        duration_ms: marker.duration_ms,
        message: marker.message.clone(),
        details: marker.details.clone(),
    }
}

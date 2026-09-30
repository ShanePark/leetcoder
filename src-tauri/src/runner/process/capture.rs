use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::{atomic::AtomicBool, Arc};
use std::thread;
use std::time::{Duration, Instant};

use crate::models::{ProblemTestEvent, ProblemTestOutputStream};

use super::{emit_event, join_stream_reader, spawn_stream_reader, TestRunControl};
use crate::runner::ProblemTestEventSink;

pub(crate) const TEST_EXECUTION_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(200);

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

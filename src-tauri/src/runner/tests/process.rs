use crate::models::ProblemTestEvent;
use crate::runner::{
    capture_test_child_output_with_control, capture_test_child_output_with_timeout,
    isolate_test_process_session, register_active_test_run, stop_test_run, ProblemTestEventSink,
    TEST_EVENT_MARKER,
};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(unix)]
#[test]
fn test_execution_timeout_starts_at_first_test_marker_and_kills_descendants() {
    let marker = format!(
        "{TEST_EVENT_MARKER}{{\"kind\":\"started\",\"className\":\"sample.Q1\",\"name\":\"hangs\",\"status\":\"running\"}}"
    );
    let script = "sleep 0.4; sleep 15 & printf '%s\\n' \"$1\"; wait";
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(script)
        .arg("leetcoder-test")
        .arg(&marker)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_test_process_session(&mut command);
    let child = command.spawn().expect("test process");
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_sink: ProblemTestEventSink = {
        let events = events.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    };

    let started = Instant::now();
    let capture =
        capture_test_child_output_with_timeout(child, Some(event_sink), Duration::from_millis(100));
    let elapsed = started.elapsed();

    assert!(capture.timed_out);
    assert!(!capture.cancelled);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, ProblemTestEvent::TestStarted { .. })));
    assert!(elapsed >= Duration::from_millis(450));
    assert!(elapsed < Duration::from_secs(3));
}

#[cfg(unix)]
#[test]
fn stop_request_terminates_test_process_descendants() {
    static NEXT_RUN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(8_000_000);
    let run_id = NEXT_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let registration = register_active_test_run(run_id).expect("register test run");
    let control = registration.control();
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg("sleep 15 & wait")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_test_process_session(&mut command);
    let child = command.spawn().expect("test process");
    let stop_thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(75));
        assert!(stop_test_run(run_id));
    });

    let started = Instant::now();
    let capture =
        capture_test_child_output_with_control(child, None, control, Duration::from_secs(60));
    stop_thread.join().expect("stop request thread");

    assert!(capture.cancelled);
    assert!(!capture.timed_out);
    assert!(started.elapsed() < Duration::from_secs(3));
    drop(registration);
    assert!(!stop_test_run(run_id));
}

#[test]
fn stop_requested_before_native_registration_is_consumed_by_that_run() {
    static NEXT_RUN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(7_000_000);
    let run_id = NEXT_RUN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    assert!(stop_test_run(run_id));
    let registration = register_active_test_run(run_id).expect("register test run");
    assert!(registration.control().is_cancel_requested());
}

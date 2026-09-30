use crate::models::{
    ProblemTestEvent, ProblemTestOutputStream, ProblemTestProgressPhase, ProblemTestProgressStatus,
};
use crate::runner::{
    marker_status, parse_test_progress_marker, progress_case_from_marker, read_stream,
    ProblemTestEventSink, TEST_EVENT_MARKER,
};
use serde_json::Value;
use std::io::Cursor;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

#[test]
fn progress_marker_is_parsed_into_a_live_test_case() {
    let marker = format!(
            "{TEST_EVENT_MARKER}{{\"kind\":\"finished\",\"className\":\"sample.Q1\",\"name\":\"fails\",\"displayName\":\"fails()\",\"status\":\"failed\",\"durationMs\":12,\"message\":\"boom\",\"details\":\"stack\"}}\n"
        );
    let parsed = parse_test_progress_marker(&marker).expect("progress marker");
    let test = progress_case_from_marker(&parsed, marker_status(&parsed));
    assert_eq!(test.class_name, "sample.Q1");
    assert_eq!(test.display_name.as_deref(), Some("fails()"));
    assert_eq!(test.status, ProblemTestProgressStatus::Failed);
    assert_eq!(test.duration_ms, Some(12));
    assert_eq!(test.details.as_deref(), Some("stack"));
}

#[test]
fn stream_reader_filters_markers_but_emits_logs_and_test_events() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let event_sink: ProblemTestEventSink = {
        let events = events.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    };
    let output = format!(
            "before\n{TEST_EVENT_MARKER}{{\"kind\":\"started\",\"className\":\"sample.Q1\",\"name\":\"passes\",\"status\":\"running\"}}\n{TEST_EVENT_MARKER}{{\"kind\":\"finished\",\"className\":\"sample.Q1\",\"name\":\"passes\",\"status\":\"passed\",\"durationMs\":3}}\nafter\n"
        );
    let captured = read_stream(
        Cursor::new(output),
        ProblemTestOutputStream::Stdout,
        Some(event_sink),
        Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(captured, "before\nafter\n");
    let events = events.lock().unwrap();
    assert!(matches!(events[0], ProblemTestEvent::Log { .. }));
    if let ProblemTestEvent::Log { text, .. } = &events[0] {
        assert_eq!(text, "before\n");
    }
    assert!(matches!(
        events[1],
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::RunningTests
        }
    ));
    assert!(matches!(events[2], ProblemTestEvent::TestStarted { .. }));
    assert!(matches!(events[3], ProblemTestEvent::TestFinished { .. }));
    assert!(matches!(events[4], ProblemTestEvent::Log { .. }));
}

#[test]
fn progress_events_serialize_as_camel_case_tagged_messages() {
    let event = ProblemTestEvent::Log {
        stream: ProblemTestOutputStream::Stderr,
        text: "warning".to_string(),
    };
    let value = serde_json::to_value(event).expect("event serializes");
    assert_eq!(value["kind"], Value::String("log".to_string()));
    assert_eq!(value["stream"], Value::String("stderr".to_string()));
    assert_eq!(value["text"], Value::String("warning".to_string()));
}

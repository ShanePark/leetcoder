use std::io::{BufRead, BufReader, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};

use serde::Deserialize;

use crate::models::{
    ProblemTestEvent, ProblemTestOutputStream, ProblemTestProgressCase, ProblemTestProgressPhase,
    ProblemTestProgressStatus,
};
use crate::runner::{ProblemTestEventSink, TEST_EVENT_MARKER};

use super::TestRunControl;

pub(crate) fn emit_event(sink: &Option<ProblemTestEventSink>, event: ProblemTestEvent) {
    if let Some(sink) = sink {
        sink(event);
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

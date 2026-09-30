mod capture;
mod control;
mod progress;

pub(crate) use capture::{
    capture_cancellable_child_output, capture_child_output, isolate_test_process_session,
};
pub(crate) use control::{register_test_run, stop_test_run, TestRunControl, TestRunRegistration};
pub(crate) use progress::{emit_event, join_stream_reader, spawn_stream_reader};

// Preserve the process facade's existing type and helper paths.
#[allow(unused_imports)]
pub(crate) use capture::{ChildOutputCapture, TEST_EXECUTION_TIMEOUT};
#[allow(unused_imports)]
pub(crate) use progress::{
    emit_log, marker_status, parse_test_progress_marker, progress_case_from_marker,
    TestProgressMarker,
};

#[cfg(test)]
pub(crate) use capture::{
    capture_test_child_output_with_control, capture_test_child_output_with_timeout,
};
#[cfg(test)]
pub(crate) use progress::read_stream;

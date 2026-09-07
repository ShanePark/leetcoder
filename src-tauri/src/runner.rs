use std::sync::Arc;

pub(crate) const TEST_EVENT_MARKER: &str = "LEETCODER_TEST_EVENT_V1:";
pub(crate) type ProblemTestEventSink =
    Arc<dyn Fn(crate::models::ProblemTestEvent) + Send + Sync + 'static>;

mod diagnostics;
mod gradle;
mod java;
mod junit;
mod process;
mod service;
mod validation;

#[cfg(test)]
mod tests;

pub(crate) use service::{check_problem_diagnostics, run_problem_test_with_sink};

#[cfg(test)]
pub(crate) use service::{run_problem_test, summarize_tests};

#[cfg(test)]
pub(crate) use diagnostics::parse_compilation_diagnostics;
#[cfg(test)]
pub(crate) use gradle::{
    build_gradle_init_script, create_compile_cache, create_init_script, remap_snapshot_diagnostics,
    validate_gradle_wrapper,
};
#[cfg(test)]
pub(crate) use java::{parse_java_major_version, select_compatible_java, JavaInstallation};
#[cfg(test)]
pub(crate) use junit::extract_expected_actual;
#[cfg(test)]
pub(crate) use junit::parse_junit_xml;
#[cfg(test)]
pub(crate) use process::{
    marker_status, parse_test_progress_marker, progress_case_from_marker, read_stream,
};
#[cfg(test)]
pub(crate) use service::build_problem_test_result;
#[cfg(test)]
pub(crate) use validation::{
    java_source_relative_path, validate_fully_qualified_class_name, validate_test_method,
};

use crate::models::{
    ProblemDiagnostic, ProblemDiagnosticSeverity, ProblemDiagnosticsResult, ProblemTestPhase,
};
use crate::runner::{
    build_problem_test_result, parse_compilation_diagnostics, remap_snapshot_diagnostics,
};
use serde_json::Value;
use std::fs;
use std::path::Path;

#[test]
fn parses_compilation_diagnostics_with_source_and_caret() {
    let output = "/tmp/Q1.java:12: error: cannot find symbol\n    value++\n         ^\n/tmp/Q1.java:21: warning: unused variable\n    int unused = 1;\n                  ^\n";
    let diagnostics = parse_compilation_diagnostics(output);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].severity, ProblemDiagnosticSeverity::Error);
    assert_eq!(diagnostics[0].file.as_deref(), Some("/tmp/Q1.java"));
    assert_eq!(diagnostics[0].line, Some(12));
    assert_eq!(diagnostics[0].column, Some(10));
    assert_eq!(diagnostics[0].source.as_deref(), Some("    value++"));
    assert_eq!(diagnostics[0].caret.as_deref(), Some("         ^"));
    assert_eq!(diagnostics[1].severity, ProblemDiagnosticSeverity::Warning);
    assert_eq!(diagnostics[1].line, Some(21));
}

#[test]
fn distinguishes_compilation_no_tests_and_runner_phases() {
    let compilation = build_problem_test_result(
        Path::new("/path/that/does/not/exist"),
        Some(1),
        false,
        "".to_string(),
        "/tmp/Q1.java:12: error: ';' expected\n    foo\n       ^\n".to_string(),
        42,
    );
    assert_eq!(compilation.phase, ProblemTestPhase::Compilation);
    assert_eq!(compilation.diagnostics.len(), 1);
    assert!(!compilation.success);

    let no_tests = build_problem_test_result(
        Path::new("/path/that/does/not/exist"),
        Some(0),
        true,
        "BUILD SUCCESSFUL\n".to_string(),
        String::new(),
        9,
    );
    assert_eq!(no_tests.phase, ProblemTestPhase::NoTests);
    assert!(!no_tests.success);
    assert_eq!(no_tests.summary.total, 0);

    let runner = build_problem_test_result(
        Path::new("/path/that/does/not/exist"),
        Some(1),
        false,
        String::new(),
        "Gradle daemon disappeared unexpectedly".to_string(),
        9,
    );
    assert_eq!(runner.phase, ProblemTestPhase::Runner);
    assert!(!runner.success);
}

#[test]
fn runner_output_keeps_a_useful_diagnostic_when_no_report_exists() {
    let result = build_problem_test_result(
        Path::new("/path/that/does/not/exist"),
        Some(1),
        false,
        String::new(),
        "Unsupported class file major version 69\nmore details\n".to_string(),
        9,
    );
    assert_eq!(result.phase, ProblemTestPhase::Runner);
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(
        result.diagnostics[0].message,
        "Unsupported class file major version 69"
    );
    assert_eq!(result.diagnostics[0].source.as_deref(), Some("runner"));
}

#[test]
fn serializes_the_stable_result_shape() {
    let result = build_problem_test_result(
        Path::new("/path/that/does/not/exist"),
        Some(0),
        true,
        "out".to_string(),
        "err".to_string(),
        9,
    );
    let value: Value = serde_json::to_value(result).expect("result serializes");
    assert_eq!(value["phase"], Value::String("noTests".to_string()));
    assert!(value["summary"]["durationMs"].is_number());
    assert!(value["tests"].is_array());
    assert!(value["diagnostics"].is_array());
    assert!(value.get("stdout").is_some());
    assert!(value.get("stderr").is_some());
}

#[test]
fn serializes_diagnostics_result_with_only_diagnostics() {
    let result = ProblemDiagnosticsResult {
        diagnostics: vec![ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: Some("src/main/java/Q1.java".to_string()),
            line: Some(4),
            column: Some(9),
            message: "bad arguments".to_string(),
            source: Some("call(1, 2)".to_string()),
            caret: Some("        ^".to_string()),
        }],
    };
    let value: Value = serde_json::to_value(result).expect("diagnostics result serializes");
    assert!(value["diagnostics"].is_array());
    assert_eq!(value["diagnostics"][0]["line"], Value::from(4));
    assert_eq!(value["diagnostics"][0]["column"], Value::from(9));
    assert!(value.get("tests").is_none());
    assert!(value.get("stdout").is_none());
}

#[test]
fn remaps_only_the_temporary_snapshot_file() {
    let workspace = tempfile::tempdir().expect("workspace");
    let snapshot = workspace.path().join("Q1.java");
    fs::write(&snapshot, "class Q1 {}").expect("snapshot");
    let mut diagnostics = vec![
        ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: Some(snapshot.to_string_lossy().into_owned()),
            line: Some(1),
            column: Some(1),
            message: "bad".to_string(),
            source: None,
            caret: None,
        },
        ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: Some("src/main/java/Other.java".to_string()),
            line: Some(2),
            column: Some(1),
            message: "other".to_string(),
            source: None,
            caret: None,
        },
    ];

    remap_snapshot_diagnostics(
        &mut diagnostics,
        &snapshot,
        "src/main/java/shane/leetcode/problems/easy/Q1.java",
    );

    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some("src/main/java/shane/leetcode/problems/easy/Q1.java")
    );
    assert_eq!(
        diagnostics[1].file.as_deref(),
        Some("src/main/java/Other.java")
    );
}

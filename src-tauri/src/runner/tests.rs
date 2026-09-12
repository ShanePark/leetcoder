use super::*;

use crate::models::{
    ProblemDiagnostic, ProblemDiagnosticSeverity, ProblemDiagnosticsResult, ProblemTestEvent,
    ProblemTestOutputStream, ProblemTestPhase, ProblemTestProgressPhase, ProblemTestProgressStatus,
    ProblemTestStatus, RunProblemTestArgs,
};
use crate::runner::{
    build_gradle_init_script, build_problem_test_result, create_compile_cache, create_init_script,
    discover_compatible_java, discover_compatible_java_baseline, discover_macos_java_homes_with,
    java_source_relative_path, marker_status, parse_compilation_diagnostics,
    parse_java_major_version, parse_junit_xml, parse_test_progress_marker,
    progress_case_from_marker, read_stream, remap_snapshot_diagnostics, run_problem_test,
    select_compatible_java, validate_fully_qualified_class_name, validate_gradle_wrapper,
    validate_test_method, JavaInstallation, ProblemTestEventSink, TEST_EVENT_MARKER,
};
use serde_json::Value;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicBool, Arc, Mutex};

const JUNIT_FIXTURE: &str = r#"
<testsuites>
  <testsuite name="Q1" tests="4" time="0.125">
    <testcase classname="sample.Q1" name="passes" time="0.001"/>
    <testcase classname="sample.Q1" name="fails" time="0.002">
      <failure message="expected: &lt;5&gt; but was: &lt;4&gt;"><![CDATA[
expected: <5>
 but was: <4>
 at sample.Q1.test(Q1.java:19)
]]></failure>
    </testcase>
    <testcase classname="sample.Q1" name="skips" time="0.003"><skipped message="not today"/></testcase>
    <testcase classname="sample.Q1" name="errors" time="0.004">
      <error message="boom"><![CDATA[at sample.Q1.test(Q1.java:27)]]></error>
    </testcase>
  </testsuite>
</testsuites>
"#;

#[test]
fn init_script_writes_junit_reports_to_each_run_directory() {
    let script = build_gradle_init_script();
    assert!(script.contains("leetcoderProblemTest"));
    assert!(script.contains("leetcoderProblemCompile"));
    assert!(script.contains("sourceSets.main.java.srcDirs"));
    assert!(script.contains("exclude 'shane/leetcode/problems/easy/**'"));
    assert!(script.contains("exclude 'shane/leetcode/problems/medium/**'"));
    assert!(script.contains("exclude 'shane/leetcode/problems/xhard/**'"));
    assert!(script.contains("selectedSourcePath"));
    assert!(script.contains("leetcoderClassesDir"));
    assert!(script.contains("leetcoderSharedClassesDir"));
    assert!(script.contains("leetcoderSharedCompile"));
    assert!(script.contains("leetcoderSourceFile"));
    assert!(script.contains("project.file(sourceOverride)"));
    assert!(script.contains("dependsOn sharedCompileTask"));
    assert!(!script.contains("options.sourcepath"));
    assert!(script.contains("sourceSets.main.resources.srcDirs"));
    assert!(script.contains("file.isFile() && file.name.toLowerCase().endsWith('.jar')"));
    assert!(script.contains("useJUnitPlatform()"));
    assert!(script.contains("testLogging.showStandardStreams = true"));
    assert!(script.contains("junitXml.outputLocation"));
    assert!(script.contains("junitXml.outputPerTestCase = true"));
    assert!(script.contains("outputs.upToDateWhen { false }"));
    let compile_section = script
        .split("def compileTask")
        .nth(1)
        .expect("problem compile task");
    assert!(!compile_section
        .split("tasks.register('leetcoderProblemTest'")
        .next()
        .expect("compile task body")
        .contains("outputs.upToDateWhen { false }"));
    assert!(script.contains("leetcoderResultDir"));
    assert!(script.contains(TEST_EVENT_MARKER));
    assert!(script.contains("beforeTest"));
    assert!(script.contains("afterTest"));
    assert!(script.contains("descriptor.composite"));
    assert!(script.contains("JsonOutput.toJson"));
}

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

#[test]
fn java_version_parser_supports_modern_and_legacy_output() {
    assert_eq!(
        parse_java_major_version("openjdk version \"17.0.18\" 2026-01-20\n"),
        Some(17)
    );
    assert_eq!(
        parse_java_major_version("java version \"1.8.0_382\"\n"),
        Some(8)
    );
    assert_eq!(
        parse_java_major_version("openjdk version \"25\" 2026-01-20\n"),
        Some(25)
    );
    assert_eq!(parse_java_major_version("not a java version"), None);
}

#[test]
fn java_selection_prefers_java_17_and_rejects_newer_jdks() {
    let candidates = vec![
        JavaInstallation {
            home: PathBuf::from("/jdk-25"),
            major_version: 25,
        },
        JavaInstallation {
            home: PathBuf::from("/jdk-11"),
            major_version: 11,
        },
        JavaInstallation {
            home: PathBuf::from("/jdk-17"),
            major_version: 17,
        },
        JavaInstallation {
            home: PathBuf::from("/jdk-8"),
            major_version: 8,
        },
    ];
    assert_eq!(
        select_compatible_java(&candidates),
        Some(JavaInstallation {
            home: PathBuf::from("/jdk-17"),
            major_version: 17,
        })
    );
    assert!(select_compatible_java(&candidates[..1]).is_none());
}

#[test]
fn java_selection_falls_back_to_java_11() {
    let candidates = vec![
        JavaInstallation {
            home: PathBuf::from("/jdk-25"),
            major_version: 25,
        },
        JavaInstallation {
            home: PathBuf::from("/jdk-11"),
            major_version: 11,
        },
    ];

    assert_eq!(
        select_compatible_java(&candidates),
        Some(JavaInstallation {
            home: PathBuf::from("/jdk-11"),
            major_version: 11,
        })
    );
}

#[cfg(unix)]
fn fake_macos_java_home_helper(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let helper = root.join("java-home-helper");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  11) sleep 0.07; printf '%s\\n' \"{}/java-11\" ;;\n  12) sleep 0.06; exit 1 ;;\n  13) sleep 0.05; printf '%s\\n' \"{}/java-13\" ;;\n  14) sleep 0.04; printf '%s\\n' \"{}/java-14\" ;;\n  15) sleep 0.03; printf '%s\\n' \"{}/java-15\" ;;\n  16) sleep 0.02; printf '%s\\n' \"{}/java-16\" ;;\n  17) sleep 0.01; printf '%s\\n' \"{}/java-17\" ;;\nesac\n",
            root.display(),
            root.display(),
            root.display(),
            root.display(),
            root.display(),
            root.display(),
        ),
    )
    .expect("fake java_home helper");
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).expect("helper executable");
    helper
}

#[cfg(unix)]
#[test]
fn macos_java_home_queries_preserve_version_order_and_skip_failures() {
    let root = tempfile::tempdir().expect("fake java_home root");
    let helper = fake_macos_java_home_helper(root.path());
    let expected = [11, 13, 14, 15, 16, 17]
        .into_iter()
        .map(|version| root.path().join(format!("java-{version}")))
        .collect::<Vec<_>>();

    let parallel = discover_macos_java_homes_with(&helper, true);
    let sequential = discover_macos_java_homes_with(&helper, false);

    assert_eq!(parallel, expected);
    assert_eq!(parallel, sequential);
}

#[test]
#[ignore = "manual native Java discovery benchmark"]
fn benchmark_java_discovery() {
    let mut selected = None;
    for _ in 0..4 {
        let baseline = discover_compatible_java_baseline().expect("baseline JDK");
        let optimized = discover_compatible_java().expect("optimized JDK");
        assert_eq!(baseline, optimized);
        selected = Some(optimized);
    }
    let selected = selected.expect("warmup JDK");

    let mut baseline_durations = Vec::with_capacity(20);
    let mut optimized_durations = Vec::with_capacity(20);
    for iteration in 0..20 {
        if iteration % 2 == 0 {
            let started = std::time::Instant::now();
            let baseline = discover_compatible_java_baseline().expect("baseline JDK");
            baseline_durations.push(started.elapsed());
            let started = std::time::Instant::now();
            let optimized = discover_compatible_java().expect("optimized JDK");
            optimized_durations.push(started.elapsed());
            assert_eq!(baseline, optimized);
        } else {
            let started = std::time::Instant::now();
            let optimized = discover_compatible_java().expect("optimized JDK");
            optimized_durations.push(started.elapsed());
            let started = std::time::Instant::now();
            let baseline = discover_compatible_java_baseline().expect("baseline JDK");
            baseline_durations.push(started.elapsed());
            assert_eq!(baseline, optimized);
        }
    }
    eprintln!(
        "Java discovery benchmark: warmup_pairs=4, measured_pairs=20, selected={selected:?}, baseline={baseline_durations:?}, optimized={optimized_durations:?}"
    );
}

#[test]
fn class_name_validation_rejects_command_like_input() {
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q1").is_ok());
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q$1").is_ok());
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q1 --info").is_err());
    assert!(validate_fully_qualified_class_name("../Q1").is_err());
    assert!(validate_fully_qualified_class_name("").is_err());
}

#[test]
fn test_method_validation_rejects_command_like_input() {
    assert!(validate_test_method(None).is_ok());
    assert!(validate_test_method(Some("test2")).is_ok());
    assert!(validate_test_method(Some("test2()")).is_err());
    assert!(validate_test_method(Some("test two")).is_err());
    assert!(validate_test_method(Some("test.*")).is_err());
    assert!(validate_test_method(Some("test.two")).is_err());
    assert!(validate_test_method(Some(" test2")).is_err());
    assert!(validate_test_method(Some("")).is_err());
}

#[test]
fn temporary_script_and_results_are_private_unique_and_removed_on_drop() {
    let root = tempfile::tempdir().expect("cache root");
    let java = JavaInstallation {
        home: PathBuf::from("/jdk-17"),
        major_version: 17,
    };
    let canonical_root = fs::canonicalize(root.path()).expect("canonical cache root");
    let cache = create_compile_cache(&canonical_root, &java, "sample.Q1").expect("compile cache");
    let first = create_init_script(&cache).expect("first init script");
    let second = create_init_script(&cache).expect("second init script");
    assert_ne!(first.path, second.path);
    assert_ne!(first.result_dir, second.result_dir);
    assert_eq!(first.classes_dir, second.classes_dir);
    assert_eq!(first.shared_classes_dir, second.shared_classes_dir);
    assert!(first.path.is_file());
    assert!(first.result_dir.is_dir());
    assert!(first.classes_dir.is_dir());
    assert!(first.shared_classes_dir.is_dir());
    assert!(second.path.is_file());
    assert!(second.result_dir.is_dir());
    assert!(second.classes_dir.is_dir());
    assert!(second.shared_classes_dir.is_dir());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(first.path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&first.result_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&first.classes_dir)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    let first_path = first.path.clone();
    let first_results = first.result_dir.clone();
    let first_classes = first.classes_dir.clone();
    drop(first);
    assert!(!first_path.exists());
    assert!(!first_results.exists());
    assert!(first_classes.exists());
    assert!(second.path.exists());
    drop(second);
}

#[test]
fn parses_pass_fail_skip_and_error_with_comparison_and_source_location() {
    let parsed = parse_junit_xml(JUNIT_FIXTURE).expect("fixture parses");
    assert_eq!(parsed.duration_ms, Some(125));
    assert_eq!(parsed.tests.len(), 4);
    assert_eq!(parsed.tests[0].status, ProblemTestStatus::Passed);
    assert_eq!(parsed.tests[1].status, ProblemTestStatus::Failed);
    assert_eq!(parsed.tests[1].expected.as_deref(), Some("5"));
    assert_eq!(parsed.tests[1].actual.as_deref(), Some("4"));
    assert_eq!(parsed.tests[1].source_file.as_deref(), Some("Q1.java"));
    assert_eq!(parsed.tests[1].source_line, Some(19));
    assert_eq!(parsed.tests[2].status, ProblemTestStatus::Skipped);
    assert_eq!(parsed.tests[2].message.as_deref(), Some("not today"));
    assert_eq!(parsed.tests[3].status, ProblemTestStatus::Error);
    assert_eq!(parsed.tests[3].source_line, Some(27));

    let summary = summarize_tests(&parsed.tests, parsed.duration_ms, 1000);
    assert_eq!(summary.total, 4);
    assert_eq!(summary.passed, 1);
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.skipped, 1);
    assert_eq!(summary.errors, 1);
    assert_eq!(summary.duration_ms, 125);
}

#[test]
fn parses_assertj_boolean_comparisons_without_matching_arbitrary_prose() {
    assert_eq!(
        extract_expected_actual("Expecting value to be true but was false"),
        (Some("true".to_string()), Some("false".to_string()))
    );
    assert_eq!(
        extract_expected_actual("Expecting value to be false but was true"),
        (Some("false".to_string()), Some("true".to_string()))
    );
    assert_eq!(
        extract_expected_actual("Expecting value to be ready but was false"),
        (None, None)
    );
    // An exact AssertJ comparison wins over unrelated labels elsewhere in
    // the combined failure description.
    assert_eq!(
        extract_expected_actual(
            "expected: <5> but was: <4>\nExpecting value to be true but was false"
        ),
        (Some("true".to_string()), Some("false".to_string()))
    );
    assert_eq!(
        extract_expected_actual(concat!(
            "Description: expected: <5> and actual: <4>\n",
            "Expecting value to be false but was true\n",
            "Additional prose: expected: <8> and actual: <9>"
        )),
        (Some("false".to_string()), Some("true".to_string()))
    );
}

#[test]
fn parses_per_testcase_output_without_attributing_suite_output() {
    let xml = r#"
<testsuites>
  <testsuite name="Q1" time="0.010">
    <testcase classname="sample.Q1" name="prints">
      <system-out>hello &amp; goodbye
</system-out>
      <system-err><![CDATA[warning <detail>]]></system-err>
      <failure message="expected: &lt;1&gt; but was: &lt;2&gt;"><![CDATA[at sample.Q1.prints(Q1.java:11)]]></failure>
    </testcase>
    <system-out><![CDATA[suite output must stay global]]></system-out>
    <system-err>suite error must stay global</system-err>
  </testsuite>
</testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    assert_eq!(parsed.tests.len(), 1);
    let test = &parsed.tests[0];
    assert_eq!(test.stdout.as_deref(), Some("hello & goodbye\n"));
    assert_eq!(test.stderr.as_deref(), Some("warning <detail>"));
    assert_eq!(test.message.as_deref(), Some("expected: <1> but was: <2>"));
    assert!(test
        .details
        .as_deref()
        .is_some_and(|details| details.contains("Q1.java:11")));
}

#[test]
fn prefers_the_active_test_frame_over_junit_and_jdk_frames() {
    let xml = r#"
<testsuites>
  <testsuite name="Q1" tests="1">
    <testcase classname="sample.Q1" name="fails">
      <failure message="boom"><![CDATA[
at sample.Q1.test(Q1.java:19)
at org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:12)
at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
]]></failure>
    </testcase>
  </testsuite>
</testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    assert_eq!(parsed.tests.len(), 1);
    assert_eq!(parsed.tests[0].source_file.as_deref(), Some("Q1.java"));
    assert_eq!(parsed.tests[0].source_line, Some(19));
}

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

#[test]
fn derives_the_java_source_path_from_a_fully_qualified_class_name() {
    assert_eq!(
        java_source_relative_path("shane.leetcode.problems.medium.Q3904SmallestStableIndexII"),
        PathBuf::from(
            "src/main/java/shane/leetcode/problems/medium/Q3904SmallestStableIndexII.java"
        )
    );
}

#[test]
fn serializes_per_testcase_output_as_optional_camel_case_fields() {
    let xml = r#"
<testsuites><testsuite><testcase classname="sample.Q1" name="prints">
  <system-out><![CDATA[hello]]></system-out>
  <system-err><![CDATA[warning]]></system-err>
</testcase></testsuite></testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    let value: Value = serde_json::to_value(&parsed.tests[0]).expect("test serializes");
    assert_eq!(value["stdout"], Value::String("hello".to_string()));
    assert_eq!(value["stderr"], Value::String("warning".to_string()));
}

#[cfg(unix)]
#[test]
fn gradle_wrapper_must_be_executable_and_not_a_symlink() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let directory = tempfile::tempdir().expect("tempdir");
    let wrapper = directory.path().join("gradlew");
    fs::write(&wrapper, "#!/bin/sh\nexit 0\n").expect("wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(validate_gradle_wrapper(&wrapper)
        .unwrap_err()
        .contains("not executable"));

    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(validate_gradle_wrapper(&wrapper).is_ok());

    let link = directory.path().join("gradlew-link");
    symlink(&wrapper, &link).unwrap();
    assert!(validate_gradle_wrapper(&link)
        .unwrap_err()
        .contains("symlink"));
}

#[cfg(unix)]
#[test]
fn test_run_requires_the_expected_ps_repository_structure() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("tempdir");
    let wrapper = directory.path().join("gradlew");
    fs::write(&wrapper, "#!/bin/sh\nexit 0\n").expect("wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let result = run_problem_test(RunProblemTestArgs {
        project_root: directory.path().to_string_lossy().into_owned(),
        fully_qualified_class_name: "shane.leetcode.problems.easy.Q1".to_string(),
        test_method: None,
    });
    assert!(result.unwrap_err().contains("valid ps repository"));
}

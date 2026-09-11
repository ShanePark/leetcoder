use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::models::{
    CheckProblemDiagnosticsArgs, ProblemDiagnostic, ProblemDiagnosticSeverity,
    ProblemDiagnosticsResult, ProblemTestCase, ProblemTestEvent, ProblemTestOutputStream,
    ProblemTestPhase, ProblemTestProgressPhase, ProblemTestResult, ProblemTestStatus,
    ProblemTestSummary, RunProblemTestArgs,
};
use crate::repository;
use crate::security::{canonical_project_root, resolve_existing_source_file};

use super::diagnostics::{
    deduplicate_diagnostics, looks_like_compilation_failure, looks_like_no_tests,
    parse_compilation_diagnostics,
};
use super::gradle::{
    create_compile_cache, create_diagnostics_workspace, create_init_script, gradle_wrapper,
    remap_snapshot_diagnostics, secure_temp_path, validate_gradle_wrapper,
    write_diagnostics_snapshot, CompileCache,
};
use super::java::{discover_compatible_java, elapsed_millis, path_with_java_home};
use super::junit::{parse_junit_reports, ParsedReports};
use super::process::{capture_child_output, emit_event};
use super::validation::{
    java_source_relative_path, validate_fully_qualified_class_name, validate_test_method,
};
use super::ProblemTestEventSink;

#[allow(dead_code)]
pub(crate) fn run_problem_test(args: RunProblemTestArgs) -> Result<ProblemTestResult, String> {
    run_problem_test_with_sink(args, None)
}

/// Compile the current editor snapshot and return javac diagnostics without
/// running any tests. The selected repository source file is used only to
/// establish the package/class identity; the source text itself is compiled
/// from a private temporary file so unsaved edits never touch the worktree.
pub(crate) fn check_problem_diagnostics(
    args: CheckProblemDiagnosticsArgs,
) -> Result<ProblemDiagnosticsResult, String> {
    validate_fully_qualified_class_name(&args.fully_qualified_class_name)?;
    validate_test_method(args.test_method.as_deref())?;

    let root = canonical_project_root(&args.project_root)?;
    let wrapper = gradle_wrapper(&root);
    validate_gradle_wrapper(&wrapper)?;
    let validation = repository::validate_project(&args.project_root);
    if !validation.valid {
        return Err(format!(
            "Selected directory is not a valid ps repository: {}",
            validation
                .message
                .unwrap_or_else(|| "required repository files are missing".to_string())
        ));
    }

    let java = discover_compatible_java()?;
    let source_relative = java_source_relative_path(&args.fully_qualified_class_name);
    let source_relative_text = source_relative.to_string_lossy().into_owned();
    let (source_path, _) = resolve_existing_source_file(&root, &source_relative_text)?;
    let source_name = source_path
        .file_name()
        .ok_or_else(|| format!("Unable to determine source file name: {source_relative_text}"))?;

    let workspace = create_diagnostics_workspace()?;
    let snapshot_path = workspace.path().join(source_name);
    write_diagnostics_snapshot(&snapshot_path, &args.source)?;
    let classes_dir = workspace.path().join("classes");
    fs::create_dir(&classes_dir).map_err(|error| {
        format!(
            "Unable to create temporary diagnostics classes directory '{}': {error}",
            classes_dir.display()
        )
    })?;
    secure_temp_path(&classes_dir, "diagnostics classes directory")?;

    let compile_cache = create_compile_cache(&root, &java, &args.fully_qualified_class_name)?;
    let diagnostic_cache = CompileCache {
        classes_dir,
        shared_classes_dir: compile_cache.shared_classes_dir,
    };
    let run_temp = create_init_script(&diagnostic_cache)?;
    let mut command = Command::new(&wrapper);
    command
        .current_dir(&root)
        .env("JAVA_HOME", &java.home)
        .env("PATH", path_with_java_home(&java.home))
        .arg("--console=plain")
        .arg("--init-script")
        .arg(&run_temp.path)
        .arg(format!(
            "-DleetcoderResultDir={}",
            run_temp.result_dir.display()
        ))
        .arg(format!(
            "-DleetcoderClassesDir={}",
            run_temp.classes_dir.display()
        ))
        .arg(format!(
            "-DleetcoderSharedClassesDir={}",
            run_temp.shared_classes_dir.display()
        ))
        .arg(format!(
            "-DleetcoderProblemClass={}",
            args.fully_qualified_class_name
        ))
        .arg(format!("-DleetcoderSourceFile={}", snapshot_path.display()))
        .arg("leetcoderProblemCompile")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = command.spawn().map_err(|error| {
        format!(
            "Unable to run Gradle diagnostics compile '{}': {error}",
            wrapper.display()
        )
    })?;
    let capture = capture_child_output(child, None);
    let mut diagnostics = parse_compilation_diagnostics(&capture.stdout);
    diagnostics.extend(parse_compilation_diagnostics(&capture.stderr));
    deduplicate_diagnostics(&mut diagnostics);
    remap_snapshot_diagnostics(&mut diagnostics, &snapshot_path, &source_relative_text);

    let has_error_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ProblemDiagnosticSeverity::Error);
    if !capture.process_success && !has_error_diagnostic {
        let message = first_output_line(&capture.stderr)
            .or_else(|| first_output_line(&capture.stdout))
            .unwrap_or_else(|| "Gradle diagnostics compile failed.".to_string());
        return Err(message);
    }

    Ok(ProblemDiagnosticsResult { diagnostics })
}
pub(crate) fn run_problem_test_with_sink(
    args: RunProblemTestArgs,
    sink: Option<ProblemTestEventSink>,
) -> Result<ProblemTestResult, String> {
    emit_event(&sink, ProblemTestEvent::Started);
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Starting,
        },
    );
    let root = canonical_project_root(&args.project_root)?;
    validate_fully_qualified_class_name(&args.fully_qualified_class_name)?;
    validate_test_method(args.test_method.as_deref())?;

    let wrapper = gradle_wrapper(&root);
    validate_gradle_wrapper(&wrapper)?;

    let validation = repository::validate_project(&args.project_root);
    if !validation.valid {
        return Err(format!(
            "Selected directory is not a valid ps repository: {}",
            validation
                .message
                .unwrap_or_else(|| "required repository files are missing".to_string())
        ));
    }

    let started = Instant::now();
    let java = match discover_compatible_java() {
        Ok(java) => java,
        Err(error) => return Ok(runner_failure_result(error, elapsed_millis(started))),
    };

    let compile_cache = create_compile_cache(&root, &java, &args.fully_qualified_class_name)?;
    let run_temp = create_init_script(&compile_cache)?;
    let test_filter = args
        .test_method
        .as_deref()
        .map(|method| format!("{}.{}", args.fully_qualified_class_name, method))
        .unwrap_or_else(|| args.fully_qualified_class_name.clone());
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Compiling,
        },
    );
    let mut command = Command::new(&wrapper);
    command
        .current_dir(&root)
        .env("JAVA_HOME", &java.home)
        .env("PATH", path_with_java_home(&java.home))
        .arg("--init-script")
        .arg(&run_temp.path)
        .arg(format!(
            "-DleetcoderResultDir={}",
            run_temp.result_dir.display()
        ))
        .arg(format!(
            "-DleetcoderClassesDir={}",
            run_temp.classes_dir.display()
        ))
        .arg(format!(
            "-DleetcoderSharedClassesDir={}",
            run_temp.shared_classes_dir.display()
        ))
        .arg(format!(
            "-DleetcoderProblemClass={}",
            args.fully_qualified_class_name
        ))
        .arg("leetcoderProblemTest")
        .arg("--tests")
        .arg(test_filter)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!(
                "Unable to run Gradle wrapper '{}': {error}",
                wrapper.display()
            );
            emit_event(
                &sink,
                ProblemTestEvent::Log {
                    stream: ProblemTestOutputStream::Stderr,
                    text: message.clone(),
                },
            );
            emit_event(
                &sink,
                ProblemTestEvent::Phase {
                    phase: ProblemTestProgressPhase::Finishing,
                },
            );
            return Ok(runner_failure_result(message, elapsed_millis(started)));
        }
    };

    let capture = capture_child_output(child, sink.clone());
    let elapsed_ms = elapsed_millis(started);
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Finishing,
        },
    );
    Ok(build_problem_test_result(
        &run_temp.result_dir,
        capture.exit_code,
        capture.process_success,
        capture.stdout,
        capture.stderr,
        elapsed_ms,
    ))
}
pub(crate) fn build_problem_test_result(
    result_dir: &Path,
    exit_code: Option<i32>,
    process_success: bool,
    stdout: String,
    stderr: String,
    elapsed_ms: u64,
) -> ProblemTestResult {
    let report = parse_junit_reports(result_dir);
    let (parsed, report_error) = match report {
        Ok(parsed) => (parsed, None),
        Err(error) => (ParsedReports::default(), Some(error)),
    };

    let mut diagnostics = parse_compilation_diagnostics(&stdout);
    diagnostics.extend(parse_compilation_diagnostics(&stderr));
    deduplicate_diagnostics(&mut diagnostics);

    let report_failed = report_error.is_some();
    if let Some(error) = report_error {
        diagnostics.push(ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: None,
            line: None,
            column: None,
            message: error,
            source: Some("junit".to_string()),
            caret: None,
        });
    }

    let has_error_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ProblemDiagnosticSeverity::Error);
    if !process_success && !has_error_diagnostic {
        if let Some(message) = first_output_line(&stderr).or_else(|| first_output_line(&stdout)) {
            diagnostics.push(ProblemDiagnostic {
                severity: ProblemDiagnosticSeverity::Error,
                file: None,
                line: None,
                column: None,
                message,
                source: Some("runner".to_string()),
                caret: None,
            });
        }
    }

    let has_compilation_error = diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == ProblemDiagnosticSeverity::Error
            && !matches!(diagnostic.source.as_deref(), Some("runner") | Some("junit"))
    }) || looks_like_compilation_failure(&stdout)
        || looks_like_compilation_failure(&stderr);

    let summary = summarize_tests(&parsed.tests, parsed.duration_ms, elapsed_ms);
    let has_tests = !parsed.tests.is_empty();
    let no_tests = !has_tests && looks_like_no_tests(&stdout, &stderr);
    let phase = if has_tests {
        ProblemTestPhase::Tests
    } else if has_compilation_error {
        ProblemTestPhase::Compilation
    } else if report_failed {
        ProblemTestPhase::Runner
    } else if process_success || no_tests {
        ProblemTestPhase::NoTests
    } else {
        ProblemTestPhase::Runner
    };
    let success = phase == ProblemTestPhase::Tests
        && process_success
        && summary.failed == 0
        && summary.errors == 0;

    ProblemTestResult {
        success,
        phase,
        exit_code,
        summary,
        tests: parsed.tests,
        diagnostics,
        stdout,
        stderr,
    }
}

fn first_output_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn runner_failure_result(message: String, duration_ms: u64) -> ProblemTestResult {
    ProblemTestResult {
        success: false,
        phase: ProblemTestPhase::Runner,
        exit_code: None,
        summary: ProblemTestSummary {
            duration_ms,
            ..ProblemTestSummary::default()
        },
        tests: Vec::new(),
        diagnostics: vec![ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: None,
            line: None,
            column: None,
            message: message.clone(),
            source: Some("runner".to_string()),
            caret: None,
        }],
        stdout: String::new(),
        stderr: message,
    }
}

pub(crate) fn summarize_tests(
    tests: &[ProblemTestCase],
    report_duration_ms: Option<u64>,
    elapsed_ms: u64,
) -> ProblemTestSummary {
    let mut summary = ProblemTestSummary {
        total: tests.len().min(u32::MAX as usize) as u32,
        ..ProblemTestSummary::default()
    };
    for test in tests {
        match test.status {
            ProblemTestStatus::Passed => summary.passed = summary.passed.saturating_add(1),
            ProblemTestStatus::Failed => summary.failed = summary.failed.saturating_add(1),
            ProblemTestStatus::Skipped => summary.skipped = summary.skipped.saturating_add(1),
            ProblemTestStatus::Error => summary.errors = summary.errors.saturating_add(1),
        }
    }
    summary.duration_ms = report_duration_ms
        .or_else(|| {
            let mut duration = 0u64;
            let mut found = false;
            for test in tests {
                if let Some(value) = test.duration_ms {
                    duration = duration.saturating_add(value);
                    found = true;
                }
            }
            found.then_some(duration)
        })
        .unwrap_or(elapsed_ms);
    summary
}

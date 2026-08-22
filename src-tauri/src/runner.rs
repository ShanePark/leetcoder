use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use tempfile::{Builder, TempDir};

use crate::models::{
    ProblemDiagnostic, ProblemDiagnosticSeverity, ProblemTestCase, ProblemTestPhase,
    ProblemTestResult, ProblemTestStatus, ProblemTestSummary, RunProblemTestArgs,
};
use crate::repository;
use crate::security::canonical_project_root;

const INIT_SCRIPT_PREFIX: &str = "leetcoder-init";
const MAX_JUNIT_XML_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) fn run_problem_test(args: RunProblemTestArgs) -> Result<ProblemTestResult, String> {
    let root = canonical_project_root(&args.project_root)?;
    validate_fully_qualified_class_name(&args.fully_qualified_class_name)?;

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

    let run_temp = create_init_script()?;
    let started = Instant::now();
    let output = Command::new(&wrapper)
        .current_dir(&root)
        .arg("--init-script")
        .arg(&run_temp.path)
        .arg(format!(
            "-DleetcoderResultDir={}",
            run_temp.result_dir.display()
        ))
        .arg("leetcoderProblemTest")
        .arg("--tests")
        .arg(&args.fully_qualified_class_name)
        .output();

    let elapsed_ms = elapsed_millis(started);
    match output {
        Ok(output) => Ok(build_problem_test_result(
            &run_temp.result_dir,
            output.status.code(),
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
            elapsed_ms,
        )),
        Err(error) => Ok(runner_failure_result(
            format!(
                "Unable to run Gradle wrapper '{}': {error}",
                wrapper.display()
            ),
            elapsed_ms,
        )),
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn gradle_wrapper(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("gradlew.bat")
    } else {
        root.join("gradlew")
    }
}

fn validate_gradle_wrapper(wrapper: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(wrapper).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("Gradle wrapper was not found: {}", wrapper.display())
        } else {
            format!(
                "Unable to inspect Gradle wrapper '{}': {error}",
                wrapper.display()
            )
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Gradle wrapper symlink is not allowed: {}",
            wrapper.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Gradle wrapper is not a regular file: {}",
            wrapper.display()
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Gradle wrapper is not executable: {} (run chmod +x gradlew)",
                wrapper.display()
            ));
        }
    }
    Ok(())
}

struct InitScript {
    _directory: TempDir,
    path: PathBuf,
    result_dir: PathBuf,
}

pub(crate) fn build_gradle_init_script() -> &'static str {
    r#"// Generated temporarily by leetcoder. It is deleted after the run.
allprojects {
    plugins.withId('java') {
        tasks.register('leetcoderProblemTest', Test) {
            description = 'Runs one leetcoder problem class from the main source set.'
            group = 'verification'
            testClassesDirs = sourceSets.main.output.classesDirs
            classpath = sourceSets.main.output + configurations.testRuntimeClasspath
            useJUnitPlatform()
            def resultDir = System.getProperty('leetcoderResultDir')
            if (resultDir == null || resultDir.trim().isEmpty()) {
                throw new GradleException('leetcoderResultDir was not provided')
            }
            reports.junitXml.outputLocation = project.file(resultDir)
            outputs.upToDateWhen { false }
        }
    }
}
"#
}

fn create_init_script() -> Result<InitScript, String> {
    let directory = Builder::new()
        .prefix(INIT_SCRIPT_PREFIX)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| {
            format!("Unable to create private temporary Gradle script directory: {error}")
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "Unable to secure temporary Gradle script directory '{}': {error}",
                    directory.path().display()
                )
            },
        )?;
    }

    let path = directory.path().join("init.gradle");
    let result_dir = directory.path().join("junit-results");
    fs::create_dir(&result_dir).map_err(|error| {
        format!(
            "Unable to create temporary JUnit result directory '{}': {error}",
            result_dir.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&result_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Unable to secure temporary JUnit result directory '{}': {error}",
                result_dir.display()
            )
        })?;
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Unable to create temporary Gradle init script '{}': {error}",
                path.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Unable to secure temporary Gradle init script '{}': {error}",
                path.display()
            )
        })?;
    }
    file.write_all(build_gradle_init_script().as_bytes())
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to write temporary Gradle init script: {error}"))?;
    Ok(InitScript {
        _directory: directory,
        path,
        result_dir,
    })
}

fn validate_fully_qualified_class_name(class_name: &str) -> Result<(), String> {
    let name = class_name.trim();
    if name.is_empty() {
        return Err("fullyQualifiedClassName must not be empty".to_string());
    }
    for segment in name.split('.') {
        if segment.is_empty() {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
        let mut characters = segment.chars();
        let first = characters.next().expect("non-empty segment");
        if !(first == '_' || first == '$' || first.is_ascii_alphabetic())
            || !characters.all(|character| {
                character == '_' || character == '$' || character.is_ascii_alphanumeric()
            })
        {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct ParsedReports {
    tests: Vec<ProblemTestCase>,
    duration_ms: Option<u64>,
}

fn build_problem_test_result(
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
    let has_compilation_error = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ProblemDiagnosticSeverity::Error)
        || looks_like_compilation_failure(&stdout)
        || looks_like_compilation_failure(&stderr);

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

fn summarize_tests(
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

fn parse_junit_reports(result_dir: &Path) -> Result<ParsedReports, String> {
    if !result_dir.exists() {
        return Ok(ParsedReports::default());
    }
    let metadata = fs::symlink_metadata(result_dir).map_err(|error| {
        format!(
            "Unable to inspect JUnit result directory '{}': {error}",
            result_dir.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "JUnit result path is not a regular directory: {}",
            result_dir.display()
        ));
    }

    let mut files = Vec::new();
    collect_xml_files(result_dir, &mut files)?;
    let mut reports = ParsedReports::default();
    for file in files {
        let metadata = fs::symlink_metadata(&file).map_err(|error| {
            format!(
                "Unable to inspect JUnit report '{}': {error}",
                file.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.len() > MAX_JUNIT_XML_BYTES {
            return Err(format!(
                "JUnit report is larger than {} bytes: {}",
                MAX_JUNIT_XML_BYTES,
                file.display()
            ));
        }
        let xml = fs::read_to_string(&file).map_err(|error| {
            format!("Unable to read JUnit report '{}': {error}", file.display())
        })?;
        let parsed = parse_junit_xml(&xml).map_err(|error| {
            format!("Unable to parse JUnit report '{}': {error}", file.display())
        })?;
        reports.tests.extend(parsed.tests);
        if let Some(duration) = parsed.duration_ms {
            reports.duration_ms = Some(
                reports
                    .duration_ms
                    .unwrap_or_default()
                    .saturating_add(duration),
            );
        }
    }
    Ok(reports)
}

fn collect_xml_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| {
        format!(
            "Unable to list JUnit result directory '{}': {error}",
            directory.display()
        )
    })?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Unable to inspect JUnit result entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Unable to inspect JUnit result entry '{}': {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_xml_files(&path, files)?;
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xml"))
        {
            files.push(path);
        }
    }
    Ok(())
}

#[derive(Debug)]
struct ActiveTest {
    class_name: String,
    name: String,
    duration_ms: Option<u64>,
    message: Option<String>,
    details: String,
    status: ProblemTestStatus,
    source_file: Option<String>,
    source_line: Option<u32>,
    capturing_details: bool,
}

#[derive(Debug, Default)]
struct XmlFailure {
    message: Option<String>,
    details: String,
}

fn parse_junit_xml(xml: &str) -> Result<ParsedReports, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut reports = ParsedReports::default();
    let mut suite_classes: Vec<String> = Vec::new();
    let mut suite_depth = 0usize;
    let mut active_test: Option<ActiveTest> = None;
    let mut active_failure: Option<XmlFailure> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"testsuite" {
                    if suite_depth == 0 {
                        reports.duration_ms = attr_value(&element, b"time")
                            .and_then(|value| parse_duration_ms(&value));
                    }
                    suite_classes.push(
                        attr_value(&element, b"classname")
                            .or_else(|| attr_value(&element, b"name"))
                            .unwrap_or_default(),
                    );
                    suite_depth = suite_depth.saturating_add(1);
                } else if tag.as_slice() == b"testcase" {
                    active_test = Some(active_test_from_xml(&element, &suite_classes));
                } else if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = if tag.as_slice() == b"error" {
                            ProblemTestStatus::Error
                        } else {
                            ProblemTestStatus::Failed
                        };
                        test.capturing_details = true;
                        active_failure = Some(XmlFailure {
                            message: attr_value(&element, b"message"),
                            details: String::new(),
                        });
                    }
                } else if tag.as_slice() == b"skipped" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = ProblemTestStatus::Skipped;
                        test.message = attr_value(&element, b"message");
                        test.capturing_details = false;
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"testsuite" {
                    if suite_depth == 0 {
                        reports.duration_ms = attr_value(&element, b"time")
                            .and_then(|value| parse_duration_ms(&value));
                    }
                } else if tag.as_slice() == b"testcase" {
                    reports.tests.push(finish_active_test(active_test_from_xml(
                        &element,
                        &suite_classes,
                    )));
                } else if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = if tag.as_slice() == b"error" {
                            ProblemTestStatus::Error
                        } else {
                            ProblemTestStatus::Failed
                        };
                        test.message = attr_value(&element, b"message");
                    }
                } else if tag.as_slice() == b"skipped" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = ProblemTestStatus::Skipped;
                        test.message = attr_value(&element, b"message");
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(failure) = active_failure.as_mut() {
                    let decoded = text
                        .decode()
                        .map_err(|error| format!("invalid JUnit text: {error}"))?;
                    failure.details.push_str(
                        &unescape(decoded.as_ref())
                            .map_err(|error| format!("invalid JUnit escape: {error}"))?,
                    );
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(failure) = active_failure.as_mut() {
                    failure
                        .details
                        .push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::End(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let (Some(test), Some(failure)) =
                        (active_test.as_mut(), active_failure.take())
                    {
                        test.message = failure.message;
                        test.details.push_str(&failure.details);
                        test.capturing_details = false;
                    }
                } else if tag.as_slice() == b"testcase" {
                    if let Some(test) = active_test.take() {
                        reports.tests.push(finish_active_test(test));
                    }
                } else if tag.as_slice() == b"testsuite" {
                    suite_depth = suite_depth.saturating_sub(1);
                    suite_classes.pop();
                }
            }
            Ok(
                Event::Comment(_)
                | Event::Decl(_)
                | Event::PI(_)
                | Event::DocType(_)
                | Event::GeneralRef(_),
            ) => {}
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(reports)
}

fn active_test_from_xml(element: &BytesStart<'_>, suite_classes: &[String]) -> ActiveTest {
    ActiveTest {
        class_name: attr_value(element, b"classname")
            .or_else(|| attr_value(element, b"class"))
            .or_else(|| suite_classes.last().cloned())
            .unwrap_or_default(),
        name: attr_value(element, b"name").unwrap_or_default(),
        duration_ms: attr_value(element, b"time").and_then(|value| parse_duration_ms(&value)),
        message: None,
        details: String::new(),
        status: ProblemTestStatus::Passed,
        source_file: attr_value(element, b"file"),
        source_line: attr_value(element, b"line").and_then(|line| line.parse().ok()),
        capturing_details: false,
    }
}

fn finish_active_test(mut test: ActiveTest) -> ProblemTestCase {
    let details = clean_text(&test.details);
    let comparison_text = format!(
        "{}\n{}",
        test.message.as_deref().unwrap_or_default(),
        details.as_deref().unwrap_or_default()
    );
    let (expected, actual) = extract_expected_actual(&comparison_text);
    if test.source_file.is_none() || test.source_line.is_none() {
        if let Some((file, line)) = extract_source_location(&comparison_text) {
            if test.source_file.is_none() {
                test.source_file = Some(file);
            }
            if test.source_line.is_none() {
                test.source_line = Some(line);
            }
        }
    }
    ProblemTestCase {
        class_name: test.class_name,
        name: test.name,
        status: test.status,
        duration_ms: test.duration_ms,
        message: clean_text(&test.message.unwrap_or_default()),
        details,
        expected,
        actual,
        source_file: test.source_file,
        source_line: test.source_line,
    }
}

fn attr_value(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .find(|attribute| attribute.key.as_ref() == name)
        .and_then(|attribute| {
            attribute
                .decoded_and_normalized_value(XmlVersion::Implicit1_0, element.decoder())
                .ok()
                .map(|value| value.into_owned())
        })
}

fn parse_duration_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }
    Some((seconds * 1000.0).round().min(u64::MAX as f64) as u64)
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn extract_source_location(text: &str) -> Option<(String, u32)> {
    for line in text.lines().rev() {
        let Some(open) = line.rfind('(') else {
            continue;
        };
        let Some(close_offset) = line[open + 1..].find(')') else {
            continue;
        };
        let close = close_offset + open + 1;
        let frame = &line[open + 1..close];
        let Some((file, line_number)) = frame.rsplit_once(':') else {
            continue;
        };
        let Ok(line_number) = line_number.parse::<u32>() else {
            continue;
        };
        if file.is_empty() || line_number == 0 {
            continue;
        }
        let file_start = file
            .rfind('/')
            .or_else(|| file.rfind('\\'))
            .map(|index| index + 1)
            .unwrap_or(0);
        return Some((file[file_start..].to_string(), line_number));
    }
    None
}

fn extract_expected_actual(text: &str) -> (Option<String>, Option<String>) {
    let explicit_expected = extract_label_value(text, "expected:")
        .or_else(|| extract_label_value(text, "to be equal to:"));
    let explicit_actual = extract_label_value(text, "actual:");
    let was = extract_label_value(text, "but was:");
    if explicit_expected.is_some() {
        (explicit_expected, explicit_actual.or(was))
    } else if explicit_actual.is_some() && was.is_some() {
        (was, explicit_actual)
    } else {
        (explicit_expected, explicit_actual.or(was))
    }
}

fn extract_label_value(text: &str, label: &str) -> Option<String> {
    let lower_text = text.to_ascii_lowercase();
    let lower_label = label.to_ascii_lowercase();
    let position = lower_text.find(&lower_label)?;
    let mut value = text[position + label.len()..].trim_start();
    if value.is_empty() {
        return None;
    }
    if let Some(next) = value.strip_prefix(':') {
        value = next.trim_start();
    }
    if value.is_empty() {
        value = text[position + label.len()..]
            .lines()
            .skip(1)
            .map(str::trim)
            .find(|line| !line.is_empty())?;
    }
    let value = value.lines().next().unwrap_or(value).trim();
    if value.is_empty() {
        return None;
    }
    let value = if let Some(value) = value.strip_prefix('<') {
        if let Some(end) = value.find('>') {
            &value[..end]
        } else {
            value
        }
    } else {
        value
    };
    Some(value.trim().to_string())
}

fn parse_compilation_diagnostics(output: &str) -> Vec<ProblemDiagnostic> {
    let lines: Vec<&str> = output.lines().collect();
    let mut diagnostics = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some((severity, file, line_number, mut column, mut message)) =
            parse_diagnostic_header(line)
        else {
            continue;
        };
        let mut source = None;
        let mut caret = None;
        if let (Some(source_line), Some(caret_line)) = (lines.get(index + 1), lines.get(index + 2))
        {
            if caret_line.contains('^') {
                source = Some((*source_line).to_string());
                caret = Some((*caret_line).to_string());
                if column.is_none() {
                    column = caret_line.find('^').map(|position| position as u32 + 1);
                }
            }
        }
        if message.is_empty() {
            message = "compiler diagnostic".to_string();
        }
        diagnostics.push(ProblemDiagnostic {
            severity,
            file,
            line: line_number,
            column,
            message,
            source,
            caret,
        });
    }
    diagnostics
}

fn parse_diagnostic_header(
    line: &str,
) -> Option<(
    ProblemDiagnosticSeverity,
    Option<String>,
    Option<u32>,
    Option<u32>,
    String,
)> {
    let markers = [
        (": error:", ProblemDiagnosticSeverity::Error),
        (": warning:", ProblemDiagnosticSeverity::Warning),
        (": note:", ProblemDiagnosticSeverity::Info),
    ];
    for (marker, severity) in markers {
        if let Some(position) = line.find(marker) {
            let prefix = line[..position].trim();
            let message = line[position + marker.len()..].trim().to_string();
            let (file, line_number, column) = parse_diagnostic_location(prefix);
            return Some((severity, file, line_number, column, message));
        }
    }
    let trimmed = line.trim_start();
    for (prefix, severity) in [
        ("error:", ProblemDiagnosticSeverity::Error),
        ("warning:", ProblemDiagnosticSeverity::Warning),
        ("note:", ProblemDiagnosticSeverity::Info),
    ] {
        if let Some(message) = trimmed.strip_prefix(prefix) {
            return Some((severity, None, None, None, message.trim().to_string()));
        }
    }
    None
}

fn parse_diagnostic_location(prefix: &str) -> (Option<String>, Option<u32>, Option<u32>) {
    let Some((before_line, last)) = prefix.rsplit_once(':') else {
        return (None, None, None);
    };
    let Ok(last_number) = last.parse::<u32>() else {
        return (None, None, None);
    };
    if let Some((file, line)) = before_line.rsplit_once(':') {
        if let Ok(line_number) = line.parse::<u32>() {
            return (Some(file.to_string()), Some(line_number), Some(last_number));
        }
    }
    (Some(before_line.to_string()), Some(last_number), None)
}

fn deduplicate_diagnostics(diagnostics: &mut Vec<ProblemDiagnostic>) {
    let mut unique = Vec::with_capacity(diagnostics.len());
    for diagnostic in diagnostics.drain(..) {
        if !unique
            .iter()
            .any(|existing: &ProblemDiagnostic| existing == &diagnostic)
        {
            unique.push(diagnostic);
        }
    }
    *diagnostics = unique;
}

fn looks_like_compilation_failure(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("compilation failed")
        || output.contains("failed to compile")
        || output.contains("compilation error")
        || output
            .lines()
            .any(|line| line.trim_start().starts_with("error:"))
}

fn looks_like_no_tests(stdout: &str, stderr: &str) -> bool {
    let output = format!("{}\n{}", stdout, stderr).to_ascii_lowercase();
    output.contains("no tests found")
        || output.contains("no matching tests")
        || output.contains("no tests executed")
        || output.contains("no tests were found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;

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
        assert!(script.contains("sourceSets.main.output.classesDirs"));
        assert!(script.contains("configurations.testRuntimeClasspath"));
        assert!(script.contains("useJUnitPlatform()"));
        assert!(script.contains("junitXml.outputLocation"));
        assert!(script.contains("outputs.upToDateWhen { false }"));
        assert!(script.contains("leetcoderResultDir"));
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
    fn temporary_script_and_results_are_private_unique_and_removed_on_drop() {
        let first = create_init_script().expect("first init script");
        let second = create_init_script().expect("second init script");
        assert_ne!(first.path, second.path);
        assert_ne!(first.result_dir, second.result_dir);
        assert!(first.path.is_file());
        assert!(first.result_dir.is_dir());
        assert!(second.path.is_file());
        assert!(second.result_dir.is_dir());

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
        }

        let first_path = first.path.clone();
        let first_results = first.result_dir.clone();
        drop(first);
        assert!(!first_path.exists());
        assert!(!first_results.exists());
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
        });
        assert!(result.unwrap_err().contains("valid ps repository"));
    }
}

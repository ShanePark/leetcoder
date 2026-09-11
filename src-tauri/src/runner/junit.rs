use std::fs;
use std::path::{Path, PathBuf};

use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use crate::models::{ProblemTestCase, ProblemTestStatus};

const MAX_JUNIT_XML_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct ParsedReports {
    pub(crate) tests: Vec<ProblemTestCase>,
    pub(crate) duration_ms: Option<u64>,
}
pub(crate) fn parse_junit_reports(result_dir: &Path) -> Result<ParsedReports, String> {
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

pub(crate) fn collect_xml_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
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
pub(crate) struct ActiveTest {
    class_name: String,
    name: String,
    pub(crate) duration_ms: Option<u64>,
    message: Option<String>,
    details: String,
    stdout: String,
    stderr: String,
    status: ProblemTestStatus,
    source_file: Option<String>,
    source_line: Option<u32>,
    capturing_details: bool,
}

#[derive(Debug, Default)]
pub(crate) struct XmlFailure {
    message: Option<String>,
    details: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum XmlOutputKind {
    Stdout,
    Stderr,
}

pub(crate) fn parse_junit_xml(xml: &str) -> Result<ParsedReports, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut reports = ParsedReports::default();
    let mut suite_classes: Vec<String> = Vec::new();
    let mut suite_depth = 0usize;
    let mut active_test: Option<ActiveTest> = None;
    let mut active_failure: Option<XmlFailure> = None;
    let mut active_output: Option<XmlOutputKind> = None;

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
                } else if tag.as_slice() == b"system-out" || tag.as_slice() == b"system-err" {
                    if active_test.is_some() {
                        active_output = Some(if tag.as_slice() == b"system-out" {
                            XmlOutputKind::Stdout
                        } else {
                            XmlOutputKind::Stderr
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
                } else if tag.as_slice() == b"system-out" || tag.as_slice() == b"system-err" {
                    // An empty per-test output element carries no output. A
                    // suite-level empty element is intentionally ignored.
                    active_output = None;
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
                } else if let (Some(test), Some(output_kind)) =
                    (active_test.as_mut(), active_output)
                {
                    let decoded = text
                        .decode()
                        .map_err(|error| format!("invalid JUnit text: {error}"))?;
                    let decoded = unescape(decoded.as_ref())
                        .map_err(|error| format!("invalid JUnit escape: {error}"))?;
                    append_test_output(test, output_kind, decoded.as_ref());
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(failure) = active_failure.as_mut() {
                    failure
                        .details
                        .push_str(&String::from_utf8_lossy(text.as_ref()));
                } else if let (Some(test), Some(output_kind)) =
                    (active_test.as_mut(), active_output)
                {
                    append_test_output(test, output_kind, &String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                let entity = reference
                    .decode()
                    .map_err(|error| format!("invalid JUnit entity: {error}"))?;
                let escaped = format!("&{};", entity.as_ref());
                let value =
                    unescape(&escaped).map_err(|error| format!("invalid JUnit escape: {error}"))?;
                if let Some(failure) = active_failure.as_mut() {
                    failure.details.push_str(value.as_ref());
                } else if let (Some(test), Some(output_kind)) =
                    (active_test.as_mut(), active_output)
                {
                    append_test_output(test, output_kind, value.as_ref());
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
                } else if tag.as_slice() == b"system-out" || tag.as_slice() == b"system-err" {
                    active_output = None;
                } else if tag.as_slice() == b"testcase" {
                    if let Some(test) = active_test.take() {
                        reports.tests.push(finish_active_test(test));
                    }
                } else if tag.as_slice() == b"testsuite" {
                    suite_depth = suite_depth.saturating_sub(1);
                    suite_classes.pop();
                }
            }
            Ok(Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_)) => {}
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(reports)
}

pub(crate) fn active_test_from_xml(
    element: &BytesStart<'_>,
    suite_classes: &[String],
) -> ActiveTest {
    ActiveTest {
        class_name: attr_value(element, b"classname")
            .or_else(|| attr_value(element, b"class"))
            .or_else(|| suite_classes.last().cloned())
            .unwrap_or_default(),
        name: attr_value(element, b"name").unwrap_or_default(),
        duration_ms: attr_value(element, b"time").and_then(|value| parse_duration_ms(&value)),
        message: None,
        details: String::new(),
        stdout: String::new(),
        stderr: String::new(),
        status: ProblemTestStatus::Passed,
        source_file: attr_value(element, b"file"),
        source_line: attr_value(element, b"line").and_then(|line| line.parse().ok()),
        capturing_details: false,
    }
}

pub(crate) fn append_test_output(test: &mut ActiveTest, output_kind: XmlOutputKind, text: &str) {
    match output_kind {
        XmlOutputKind::Stdout => test.stdout.push_str(text),
        XmlOutputKind::Stderr => test.stderr.push_str(text),
    }
}

pub(crate) fn finish_active_test(mut test: ActiveTest) -> ProblemTestCase {
    let details = clean_text(&test.details);
    let comparison_text = format!(
        "{}\n{}",
        test.message.as_deref().unwrap_or_default(),
        details.as_deref().unwrap_or_default()
    );
    let (expected, actual) = extract_expected_actual(&comparison_text);
    if test.source_file.is_none() || test.source_line.is_none() {
        if let Some((file, line)) = extract_source_location(&comparison_text, &test.class_name) {
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
        stdout: (!test.stdout.is_empty()).then_some(test.stdout),
        stderr: (!test.stderr.is_empty()).then_some(test.stderr),
        expected,
        actual,
        source_file: test.source_file,
        source_line: test.source_line,
    }
}

pub(crate) fn attr_value(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
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

pub(crate) fn parse_duration_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }
    Some((seconds * 1000.0).round().min(u64::MAX as f64) as u64)
}

pub(crate) fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn extract_source_location(text: &str, class_name: &str) -> Option<(String, u32)> {
    let expected_simple = class_name.rsplit('.').next().unwrap_or(class_name);
    let expected_outer = expected_simple.split('$').next().unwrap_or(expected_simple);
    let mut preferred = None;
    let mut fallback = None;
    let mut first = None;

    for line in text.lines() {
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
        let file_name = file[file_start..].to_string();
        let candidate = (file_name.clone(), line_number);
        first.get_or_insert_with(|| candidate.clone());

        let frame_head = line.trim().strip_prefix("at ").unwrap_or(line.trim());
        let owner_and_method = frame_head.split('(').next().unwrap_or_default();
        let owner = owner_and_method
            .rsplit_once('.')
            .map(|(owner, _)| owner)
            .unwrap_or_default();
        let owner_simple = owner.rsplit('.').next().unwrap_or(owner);
        let owner_outer = owner_simple.split('$').next().unwrap_or(owner_simple);
        let file_stem = file_name.strip_suffix(".java").unwrap_or(&file_name);
        let matches_active_class = owner_simple == expected_simple
            || owner_outer == expected_outer
            || file_stem == expected_simple
            || file_stem == expected_outer;
        if matches_active_class {
            preferred.get_or_insert(candidate.clone());
        }

        let framework = owner.starts_with("org.junit.")
            || owner.starts_with("org.opentest4j.")
            || owner.starts_with("org.gradle.")
            || owner.starts_with("java.")
            || owner.starts_with("jdk.")
            || owner.starts_with("sun.");
        if !framework {
            fallback.get_or_insert(candidate);
        }
    }
    preferred.or(fallback).or(first)
}

pub(crate) fn extract_expected_actual(text: &str) -> (Option<String>, Option<String>) {
    let explicit_expected = extract_label_value(text, "expected:")
        .or_else(|| extract_label_value(text, "to be equal to:"));
    let explicit_actual = extract_label_value(text, "actual:");
    let was = extract_label_value(text, "but was:");
    if let Some((expected, actual)) = extract_assertj_boolean_comparison(text) {
        (Some(expected), Some(actual))
    } else if explicit_expected.is_some() {
        (explicit_expected, explicit_actual.or(was))
    } else if explicit_actual.is_some() && was.is_some() {
        (was, explicit_actual)
    } else {
        (explicit_expected, explicit_actual.or(was))
    }
}

/// AssertJ uses this exact sentence for boolean assertions. Keep this parser
/// deliberately narrow so prose such as "expecting value to be ready but was
/// false" is not mistaken for a structured comparison.
pub(crate) fn extract_assertj_boolean_comparison(text: &str) -> Option<(String, String)> {
    const PREFIX: &str = "Expecting value to be ";
    const SEPARATOR: &str = " but was ";

    text.lines().map(str::trim).find_map(|line| {
        let remainder = line.strip_prefix(PREFIX)?;
        let (expected, actual) = remainder.split_once(SEPARATOR)?;
        let expected_is_boolean = matches!(expected, "true" | "false");
        let actual_is_boolean = matches!(actual, "true" | "false");
        if expected_is_boolean && actual_is_boolean {
            Some((expected.to_string(), actual.to_string()))
        } else {
            None
        }
    })
}

pub(crate) fn extract_label_value(text: &str, label: &str) -> Option<String> {
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

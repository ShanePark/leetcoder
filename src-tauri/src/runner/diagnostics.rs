use crate::models::{ProblemDiagnostic, ProblemDiagnosticSeverity};

pub(crate) fn parse_compilation_diagnostics(output: &str) -> Vec<ProblemDiagnostic> {
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

pub(crate) fn parse_diagnostic_header(
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

pub(crate) fn parse_diagnostic_location(
    prefix: &str,
) -> (Option<String>, Option<u32>, Option<u32>) {
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

pub(crate) fn deduplicate_diagnostics(diagnostics: &mut Vec<ProblemDiagnostic>) {
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

pub(crate) fn looks_like_compilation_failure(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("compilation failed")
        || output.contains("failed to compile")
        || output.contains("compilation error")
        || output
            .lines()
            .any(|line| line.trim_start().starts_with("error:"))
}

pub(crate) fn looks_like_no_tests(stdout: &str, stderr: &str) -> bool {
    let output = format!("{}\n{}", stdout, stderr).to_ascii_lowercase();
    output.contains("no tests found")
        || output.contains("no matching tests")
        || output.contains("no tests executed")
        || output.contains("no tests were found")
}

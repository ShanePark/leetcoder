use serde::{Deserialize, Serialize};

/// The result of checking that a directory is the expected ps repository.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectValidation {
    pub valid: bool,
    pub project_root: String,
    pub missing_paths: Vec<String>,
    pub errors: Vec<String>,
    pub message: Option<String>,
}

/// Problem metadata returned by LeetCode's daily challenge query.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyProblem {
    pub date: String,
    pub frontend_id: String,
    pub title: String,
    pub difficulty: String,
    pub title_slug: String,
    pub url: String,
    pub java_snippet: Option<String>,
}

/// A source file path relative to the selected repository root.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemFileList {
    pub files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemFileArgs {
    pub project_root: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProblemFileArgs {
    pub project_root: String,
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemFileContent {
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProblemTestArgs {
    pub project_root: String,
    pub fully_qualified_class_name: String,
}

/// Output from the Gradle task injected by the editor for one problem run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemTestResult {
    pub success: bool,
    pub phase: ProblemTestPhase,
    pub exit_code: Option<i32>,
    pub summary: ProblemTestSummary,
    pub tests: Vec<ProblemTestCase>,
    pub diagnostics: Vec<ProblemDiagnostic>,
    pub stdout: String,
    pub stderr: String,
}

/// The broad stage at which a problem run finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemTestPhase {
    Tests,
    Compilation,
    NoTests,
    Runner,
}

/// Counts and elapsed time for one problem run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemTestSummary {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub errors: u32,
    pub duration_ms: u64,
}

/// One testcase from a JUnit XML report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemTestCase {
    pub class_name: String,
    pub name: String,
    pub status: ProblemTestStatus,
    pub duration_ms: Option<u64>,
    pub message: Option<String>,
    pub details: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub source_file: Option<String>,
    pub source_line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemTestStatus {
    Passed,
    Failed,
    Skipped,
    Error,
}

/// A compiler or runner diagnostic associated with a problem run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemDiagnostic {
    pub severity: ProblemDiagnosticSeverity,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
    pub source: Option<String>,
    pub caret: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemDiagnosticSeverity {
    Error,
    Warning,
    Info,
}

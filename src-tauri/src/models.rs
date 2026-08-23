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

/// A path with changes in the selected repository.
///
/// `index_status` and `worktree_status` retain Git's two-column porcelain
/// status while `status` is the compact value used by the UI (for example,
/// `M`, `MM`, `A`, `D`, or `??`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub index_status: String,
    pub worktree_status: String,
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_hash: String,
    pub message: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub output: String,
    pub branch: Option<String>,
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

/// An incremental update emitted while a problem test is running.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProblemTestEvent {
    Started,
    Phase {
        phase: ProblemTestProgressPhase,
    },
    Log {
        stream: ProblemTestOutputStream,
        text: String,
    },
    TestStarted {
        test: ProblemTestProgressCase,
    },
    TestFinished {
        test: ProblemTestProgressCase,
    },
}

/// A phase reported before the authoritative final result is available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemTestProgressPhase {
    Starting,
    Compiling,
    RunningTests,
    Finishing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemTestOutputStream {
    Stdout,
    Stderr,
}

/// The compact testcase shape used by live progress events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemTestProgressCase {
    pub class_name: String,
    pub name: String,
    pub display_name: Option<String>,
    pub status: ProblemTestProgressStatus,
    pub duration_ms: Option<u64>,
    pub message: Option<String>,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemTestProgressStatus {
    Running,
    Passed,
    Failed,
    Skipped,
    Error,
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
    pub stdout: Option<String>,
    pub stderr: Option<String>,
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

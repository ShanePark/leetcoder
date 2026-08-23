use crate::git;
use crate::leetcode;
use crate::models::{
    CreateProblemFileArgs, DailyProblem, GitCommitResult, GitFileChange, GitPushResult,
    ProblemFileArgs, ProblemFileContent, ProblemFileList, ProblemTestEvent, ProblemTestResult,
    ProjectValidation, RunProblemTestArgs,
};
use crate::repository;
use crate::runner;
use std::sync::Arc;

#[tauri::command(rename_all = "camelCase")]
pub fn validate_project(repo_path: String) -> ProjectValidation {
    repository::validate_project(&repo_path)
}

#[tauri::command]
pub async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    leetcode::fetch_daily_problem().await
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_problem_files(repo_path: String) -> Result<ProblemFileList, String> {
    repository::list_problem_files(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn read_problem_file(repo_path: String, path: String) -> Result<ProblemFileContent, String> {
    repository::read_problem_file(ProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_problem_file(
    repo_path: String,
    path: String,
    source: String,
) -> Result<ProblemFileContent, String> {
    repository::create_problem_file(CreateProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
        content: source,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_problem_file(
    repo_path: String,
    path: String,
    content: String,
) -> Result<ProblemFileContent, String> {
    repository::save_problem_file(CreateProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
        content,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_problem_file(repo_path: String, path: String) -> Result<(), String> {
    repository::delete_problem_file(ProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_git_changes(repo_path: String) -> Result<Vec<GitFileChange>, String> {
    git::list_changes(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_git_diff(repo_path: String, paths: Vec<String>) -> Result<String, String> {
    git::diff(&repo_path, paths)
}

#[tauri::command(rename_all = "camelCase")]
pub fn commit_git(
    repo_path: String,
    paths: Vec<String>,
    message: String,
) -> Result<GitCommitResult, String> {
    git::commit(&repo_path, paths, message)
}

#[tauri::command(rename_all = "camelCase")]
pub fn push_git(repo_path: String) -> Result<GitPushResult, String> {
    git::push(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn run_problem_test(
    repo_path: String,
    fully_qualified_class_name: String,
    on_event: tauri::ipc::Channel<ProblemTestEvent>,
) -> Result<ProblemTestResult, String> {
    let sink = Arc::new(move |event| {
        // A disconnected webview should not turn an otherwise useful test
        // result into a runner failure.
        let _ = on_event.send(event);
    });
    tauri::async_runtime::spawn_blocking(move || {
        runner::run_problem_test_with_sink(
            RunProblemTestArgs {
                project_root: repo_path,
                fully_qualified_class_name,
            },
            Some(sink),
        )
    })
    .await
    .map_err(|error| format!("Problem test worker stopped unexpectedly: {error}"))?
}

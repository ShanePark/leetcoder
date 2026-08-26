use crate::git;
use crate::leetcode;
use crate::models::{
    CreateProblemFileArgs, DailyProblem, GitCommitResult, GitFileChange, GitPushResult,
    ProblemFileArgs, ProblemFileContent, ProblemFileList, ProblemTestEvent, ProblemTestResult,
    ProjectValidation, RenameProblemFileArgs, RunProblemTestArgs,
};
use crate::repository;
use crate::runner;
use std::sync::Arc;
use tauri_plugin_dialog::DialogExt;

/// Opens one folder picker attached to the leetcoder window.
///
/// The dialog plugin's JavaScript command only assigns a parent on Windows
/// and macOS. Assigning it here on Linux gives the desktop portal the parent
/// window identifier, which keeps the picker in front of this application.
#[tauri::command]
pub async fn choose_repository(window: tauri::Window) -> Result<Option<String>, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Select your leetcoder repository")
        .pick_folder(move |selected| {
            let _ = sender.blocking_send(selected);
        });

    let selected = receiver
        .recv()
        .await
        .ok_or_else(|| "The repository picker closed unexpectedly.".to_string())?;
    selected
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| format!("The selected repository path was invalid: {error}"))
        })
        .transpose()
}

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
pub fn duplicate_problem_file(
    repo_path: String,
    path: String,
) -> Result<ProblemFileContent, String> {
    repository::duplicate_problem_file(ProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_problem_file(
    repo_path: String,
    path: String,
    new_path: String,
) -> Result<ProblemFileContent, String> {
    repository::rename_problem_file(RenameProblemFileArgs {
        project_root: repo_path,
        relative_path: path,
        new_relative_path: new_path,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_git_changes(repo_path: String) -> Result<Vec<GitFileChange>, String> {
    git::list_changes(&repo_path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn discard_git_changes(repo_path: String, path: String) -> Result<(), String> {
    git::discard_changes(&repo_path, &path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn show_in_file_manager(repo_path: String, path: String) -> Result<(), String> {
    git::show_in_file_manager(&repo_path, &path)
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
    test_method: Option<String>,
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
                test_method,
            },
            Some(sink),
        )
    })
    .await
    .map_err(|error| format!("Problem test worker stopped unexpectedly: {error}"))?
}

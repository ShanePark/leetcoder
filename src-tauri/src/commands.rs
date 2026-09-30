use crate::git;
use crate::leetcode;
use crate::models::{
    CheckProblemDiagnosticsArgs, CreateProblemFileArgs, DailyProblem, GitCommitResult,
    GitFileChange, GitPushResult, JavaTypeMembersMetadata, ProblemDiagnosticsResult,
    ProblemFileArgs, ProblemFileContent, ProblemFileList, ProblemTestEvent, ProblemTestResult,
    ProjectSearchResult, ProjectValidation, PsLibraryMetadata, RenameProblemFileArgs,
    RunProblemTestArgs,
};
use crate::repository;
use crate::runner;
use crate::watcher;
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
pub async fn validate_project(repo_path: String) -> ProjectValidation {
    let fallback_root = repo_path.clone();
    tauri::async_runtime::spawn_blocking(move || repository::validate_project(&repo_path))
        .await
        .unwrap_or_else(|error| ProjectValidation {
            valid: false,
            project_root: fallback_root,
            missing_paths: Vec::new(),
            errors: vec![format!(
                "Project validation worker stopped unexpectedly: {error}"
            )],
            message: Some("Project validation could not be completed.".to_string()),
        })
}

#[tauri::command]
pub async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    leetcode::fetch_daily_problem().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_problem_by_number(frontend_id: String) -> Result<DailyProblem, String> {
    leetcode::fetch_problem_by_number(&frontend_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn list_problem_files(repo_path: String) -> Result<ProblemFileList, String> {
    tauri::async_runtime::spawn_blocking(move || repository::list_problem_files(&repo_path))
        .await
        .map_err(|error| format!("Problem file listing worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_ps_library(repo_path: String) -> Result<PsLibraryMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::security::canonical_project_root(&repo_path)?;
        crate::java_library::inspect_ps_library(&root)
    })
    .await
    .map_err(|error| format!("Library inspection worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_java_type_members(
    repo_path: String,
    type_names: Vec<String>,
) -> Result<JavaTypeMembersMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::java_library::inspect_java_type_members(repo_path, type_names)
    })
    .await
    .map_err(|error| format!("Java type inspection worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn search_project(
    repo_path: String,
    query: String,
    case_sensitive: bool,
    exclude_paths: Option<Vec<String>>,
) -> Result<ProjectSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::project_search::search_project(
            &repo_path,
            &query,
            case_sensitive,
            exclude_paths.as_deref().unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("Project search worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn read_problem_file(
    repo_path: String,
    path: String,
) -> Result<ProblemFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repository::read_problem_file(ProblemFileArgs {
            project_root: repo_path,
            relative_path: path,
        })
    })
    .await
    .map_err(|error| format!("Problem file read worker stopped unexpectedly: {error}"))?
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
pub async fn list_git_changes(repo_path: String) -> Result<Vec<GitFileChange>, String> {
    tauri::async_runtime::spawn_blocking(move || git::list_changes(&repo_path))
        .await
        .map_err(|error| format!("Git status worker stopped unexpectedly: {error}"))?
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
pub async fn get_git_diff(repo_path: String, paths: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git::diff(&repo_path, paths))
        .await
        .map_err(|error| format!("Git diff worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn commit_git(
    repo_path: String,
    paths: Vec<String>,
    message: String,
) -> Result<GitCommitResult, String> {
    tauri::async_runtime::spawn_blocking(move || git::commit(&repo_path, paths, message))
        .await
        .map_err(|error| format!("Git commit worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn push_git(repo_path: String) -> Result<GitPushResult, String> {
    tauri::async_runtime::spawn_blocking(move || git::push(&repo_path))
        .await
        .map_err(|error| format!("Git push worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn run_problem_test(
    repo_path: String,
    fully_qualified_class_name: String,
    test_method: Option<String>,
    test_run_id: u64,
    on_event: tauri::ipc::Channel<ProblemTestEvent>,
) -> Result<ProblemTestResult, String> {
    let registration = runner::register_test_run(test_run_id)?;
    let sink = Arc::new(move |event| {
        // A disconnected webview should not turn an otherwise useful test
        // result into a runner failure.
        let _ = on_event.send(event);
    });
    tauri::async_runtime::spawn_blocking(move || {
        runner::run_problem_test_with_registration(
            RunProblemTestArgs {
                project_root: repo_path,
                fully_qualified_class_name,
                test_method,
            },
            Some(sink),
            registration,
        )
    })
    .await
    .map_err(|error| format!("Problem test worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn stop_problem_test(test_run_id: u64) -> bool {
    runner::stop_problem_test(test_run_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn check_problem_diagnostics(
    repo_path: String,
    fully_qualified_class_name: String,
    test_method: Option<String>,
    source: String,
) -> Result<ProblemDiagnosticsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runner::check_problem_diagnostics(CheckProblemDiagnosticsArgs {
            project_root: repo_path,
            fully_qualified_class_name,
            test_method,
            source,
        })
    })
    .await
    .map_err(|error| format!("Problem diagnostics worker stopped unexpectedly: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn watch_repository(
    app: tauri::AppHandle,
    state: tauri::State<'_, watcher::RepositoryWatcher>,
    repo_path: String,
) -> Result<(), String> {
    watcher::watch(app, &state, &repo_path)
}

#[tauri::command]
pub fn unwatch_repository(state: tauri::State<'_, watcher::RepositoryWatcher>) {
    watcher::unwatch(&state);
}

#[cfg(test)]
mod tests;

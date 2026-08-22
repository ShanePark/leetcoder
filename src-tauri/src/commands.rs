use crate::leetcode;
use crate::models::{
    CreateProblemFileArgs, DailyProblem, ProblemFileArgs, ProblemFileContent, ProblemFileList,
    ProblemTestResult, ProjectValidation, RunProblemTestArgs,
};
use crate::repository;
use crate::runner;

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
pub fn run_problem_test(
    repo_path: String,
    fully_qualified_class_name: String,
) -> Result<ProblemTestResult, String> {
    runner::run_problem_test(RunProblemTestArgs {
        project_root: repo_path,
        fully_qualified_class_name,
    })
}

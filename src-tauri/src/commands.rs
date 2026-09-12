use crate::git;
use crate::leetcode;
use crate::models::{
    CheckProblemDiagnosticsArgs, CreateProblemFileArgs, DailyProblem, GitCommitResult,
    GitFileChange, GitPushResult, ProblemDiagnosticsResult, ProblemFileArgs, ProblemFileContent,
    ProblemFileList, ProblemTestEvent, ProblemTestResult, ProjectValidation, RenameProblemFileArgs,
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
mod tests {
    use super::*;
    use std::fs;
    use std::future::Future;
    use std::hint::black_box;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::task::{Context, Poll, Waker};
    use std::time::Instant;

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .expect("git is installed for command tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary repository");
        let root = directory.path();
        fs::create_dir_all(root.join("src/main/java/shane/leetcode/problems/easy"))
            .expect("easy package");
        fs::create_dir_all(root.join("src/main/java/shane/leetcode/problems/medium"))
            .expect("medium package");
        fs::create_dir_all(root.join("src/main/java/shane/leetcode/problems/xhard"))
            .expect("xhard package");
        fs::write(root.join("build.gradle"), "plugins {}\n").expect("build file");
        fs::write(
            root.join("settings.gradle"),
            "rootProject.name = 'fixture'\n",
        )
        .expect("settings file");
        fs::write(root.join("gradlew"), "#!/bin/sh\n").expect("wrapper file");
        fs::write(
            root.join("src/main/java/shane/leetcode/problems/easy/Q1.java"),
            "class Q1 {}\n",
        )
        .expect("problem file");

        run_git(root, &["init", "--quiet"]);
        run_git(root, &["config", "user.name", "Command Test"]);
        run_git(
            root,
            &["config", "user.email", "command-test@example.invalid"],
        );
        run_git(root, &["add", "--all"]);
        run_git(root, &["commit", "--quiet", "-m", "initial"]);
        fs::write(
            root.join("src/main/java/shane/leetcode/problems/easy/Q1.java"),
            "class Q1 { int value = 1; }\n",
        )
        .expect("modified problem file");
        directory
    }

    fn first_poll_then_complete<F: Future>(future: F) -> (u128, F::Output) {
        let mut future = Box::pin(future);
        let mut context = Context::from_waker(Waker::noop());
        let started = Instant::now();
        let first_poll = future.as_mut().poll(&mut context);
        let first_poll_ns = started.elapsed().as_nanos();
        let output = match first_poll {
            Poll::Ready(output) => output,
            Poll::Pending => tauri::async_runtime::block_on(future),
        };
        (first_poll_ns, output)
    }

    #[test]
    fn read_only_commands_match_direct_operations() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().into_owned();
        let path = "src/main/java/shane/leetcode/problems/easy/Q1.java".to_string();

        let expected_validation = repository::validate_project(&root);
        let actual_validation = tauri::async_runtime::block_on(validate_project(root.clone()));
        assert_eq!(
            serde_json::to_value(&actual_validation).unwrap(),
            serde_json::to_value(&expected_validation).unwrap()
        );

        let expected_files = repository::list_problem_files(&root).unwrap();
        let actual_files =
            tauri::async_runtime::block_on(list_problem_files(root.clone())).unwrap();
        assert_eq!(actual_files.files, expected_files.files);

        let expected_changes = git::list_changes(&root).unwrap();
        let actual_changes =
            tauri::async_runtime::block_on(list_git_changes(root.clone())).unwrap();
        assert_eq!(
            serde_json::to_value(&actual_changes).unwrap(),
            serde_json::to_value(&expected_changes).unwrap()
        );

        let expected_diff = git::diff(&root, vec![path.clone()]).unwrap();
        let actual_diff = tauri::async_runtime::block_on(get_git_diff(root, vec![path])).unwrap();
        assert_eq!(actual_diff, expected_diff);
    }

    #[test]
    #[ignore = "manual native command dispatch benchmark"]
    fn benchmark_read_only_command_dispatch() {
        const FILE_COUNT: usize = 2_000;
        let directory = fixture();
        let root = directory.path().to_string_lossy().into_owned();
        let source_root = directory
            .path()
            .join("src/main/java/shane/leetcode/problems/easy");
        for index in 0..FILE_COUNT {
            fs::write(
                source_root.join(format!("Q{index}.java")),
                format!("class Q{index} {{ int value = {index}; }}\n"),
            )
            .expect("benchmark source file");
        }
        let path = "src/main/java/shane/leetcode/problems/easy/Q1.java".to_string();
        assert_eq!(
            repository::list_problem_files(&root).unwrap().files.len(),
            FILE_COUNT
        );

        let mut sync_validation_samples = Vec::with_capacity(20);
        let mut first_poll_validation_samples = Vec::with_capacity(20);
        let mut sync_list_samples = Vec::with_capacity(20);
        let mut first_poll_list_samples = Vec::with_capacity(20);
        let mut sync_status_samples = Vec::with_capacity(20);
        let mut first_poll_status_samples = Vec::with_capacity(20);
        let mut sync_diff_samples = Vec::with_capacity(20);
        let mut first_poll_diff_samples = Vec::with_capacity(20);
        for _ in 0..5 {
            black_box(repository::validate_project(&root));
            black_box(tauri::async_runtime::block_on(validate_project(
                root.clone(),
            )));
            black_box(repository::list_problem_files(&root).unwrap());
            black_box(tauri::async_runtime::block_on(list_problem_files(root.clone())).unwrap());
            black_box(git::list_changes(&root).unwrap());
            black_box(tauri::async_runtime::block_on(list_git_changes(root.clone())).unwrap());
            black_box(git::diff(&root, vec![path.clone()]).unwrap());
            black_box(
                tauri::async_runtime::block_on(get_git_diff(root.clone(), vec![path.clone()]))
                    .unwrap(),
            );
        }
        for _ in 0..20 {
            let started = Instant::now();
            black_box(repository::validate_project(&root));
            sync_validation_samples.push(started.elapsed().as_nanos());

            let (first_poll_ns, validation) =
                first_poll_then_complete(validate_project(root.clone()));
            first_poll_validation_samples.push(first_poll_ns);
            black_box(validation);

            let started = Instant::now();
            black_box(repository::list_problem_files(&root).unwrap());
            sync_list_samples.push(started.elapsed().as_nanos());

            let (first_poll_ns, files) = first_poll_then_complete(list_problem_files(root.clone()));
            first_poll_list_samples.push(first_poll_ns);
            black_box(files.unwrap());

            let started = Instant::now();
            black_box(git::list_changes(&root).unwrap());
            sync_status_samples.push(started.elapsed().as_nanos());

            let (first_poll_ns, changes) = first_poll_then_complete(list_git_changes(root.clone()));
            first_poll_status_samples.push(first_poll_ns);
            black_box(changes.unwrap());

            let started = Instant::now();
            black_box(git::diff(&root, vec![path.clone()]).unwrap());
            sync_diff_samples.push(started.elapsed().as_nanos());

            let (first_poll_ns, diff) =
                first_poll_then_complete(get_git_diff(root.clone(), vec![path.clone()]));
            first_poll_diff_samples.push(first_poll_ns);
            black_box(diff.unwrap());
        }
        for samples in [
            &mut sync_validation_samples,
            &mut first_poll_validation_samples,
            &mut sync_list_samples,
            &mut first_poll_list_samples,
            &mut sync_status_samples,
            &mut first_poll_status_samples,
            &mut sync_diff_samples,
            &mut first_poll_diff_samples,
        ] {
            samples.sort_unstable();
        }

        let expected_validation = repository::validate_project(&root);
        let actual_validation = tauri::async_runtime::block_on(validate_project(root.clone()));
        assert_eq!(
            serde_json::to_value(&actual_validation).unwrap(),
            serde_json::to_value(&expected_validation).unwrap()
        );
        let expected_changes = git::list_changes(&root).unwrap();
        let actual_changes =
            tauri::async_runtime::block_on(list_git_changes(root.clone())).unwrap();
        assert_eq!(
            serde_json::to_value(&actual_changes).unwrap(),
            serde_json::to_value(&expected_changes).unwrap()
        );
        let expected_diff = git::diff(&root, vec![path.clone()]).unwrap();
        let actual_diff = tauri::async_runtime::block_on(get_git_diff(root, vec![path])).unwrap();
        assert_eq!(actual_diff, expected_diff);

        eprintln!(
            "command benchmark median_ns sync_call_validate={} first_poll_validate={} sync_call_list={} first_poll_list={} sync_call_status={} first_poll_status={} sync_call_diff={} first_poll_diff={} files={}",
            sync_validation_samples[sync_validation_samples.len() / 2],
            first_poll_validation_samples[first_poll_validation_samples.len() / 2],
            sync_list_samples[sync_list_samples.len() / 2],
            first_poll_list_samples[first_poll_list_samples.len() / 2],
            sync_status_samples[sync_status_samples.len() / 2],
            first_poll_status_samples[first_poll_status_samples.len() / 2],
            sync_diff_samples[sync_diff_samples.len() / 2],
            first_poll_diff_samples[first_poll_diff_samples.len() / 2],
            FILE_COUNT
        );
    }
}

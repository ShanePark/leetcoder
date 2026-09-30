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
    let actual_files = tauri::async_runtime::block_on(list_problem_files(root.clone())).unwrap();
    assert_eq!(actual_files.files, expected_files.files);

    let expected_changes = git::list_changes(&root).unwrap();
    let actual_changes = tauri::async_runtime::block_on(list_git_changes(root.clone())).unwrap();
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
            tauri::async_runtime::block_on(get_git_diff(root.clone(), vec![path.clone()])).unwrap(),
        );
    }
    for _ in 0..20 {
        let started = Instant::now();
        black_box(repository::validate_project(&root));
        sync_validation_samples.push(started.elapsed().as_nanos());

        let (first_poll_ns, validation) = first_poll_then_complete(validate_project(root.clone()));
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
    let actual_changes = tauri::async_runtime::block_on(list_git_changes(root.clone())).unwrap();
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

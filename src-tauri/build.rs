use std::{env, path::PathBuf, process::Command};

fn main() {
    tauri_build::build();

    // The installed app runs outside the checkout that produced it. Embed the
    // checkout path and exact source commit while Cargo still has that context
    // available so the running binary can detect a newer local build.
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required by Cargo"),
    );
    let fallback_root = manifest_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.clone());
    let source_root = git_output(&fallback_root, ["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok())
        .unwrap_or_else(|| {
            fallback_root
                .canonicalize()
                .unwrap_or_else(|_| fallback_root.clone())
        });
    let build_commit = git_output(&source_root, ["rev-parse", "HEAD"]).unwrap_or_default();

    println!(
        "cargo:rustc-env=LEETCODER_SOURCE_ROOT={}",
        source_root.to_string_lossy()
    );
    println!("cargo:rustc-env=LEETCODER_BUILD_COMMIT={build_commit}");

    // A branch ref changes when a commit is made even though source files do
    // not. Watching the common Git metadata makes `cargo build` refresh the
    // embedded commit after a local commit.
    if let Some(git_dir) = git_output(&source_root, ["rev-parse", "--git-dir"]) {
        let git_dir = PathBuf::from(git_dir);
        let git_dir = if git_dir.is_absolute() {
            git_dir
        } else {
            source_root.join(git_dir)
        };
        for name in ["HEAD", "index", "packed-refs"] {
            println!(
                "cargo:rerun-if-changed={}",
                git_dir.join(name).to_string_lossy()
            );
        }
        if let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD")) {
            if let Some(reference) = head.trim().strip_prefix("ref: ") {
                println!(
                    "cargo:rerun-if-changed={}",
                    git_dir.join(reference).to_string_lossy()
                );
            }
        }
    }
}

fn git_output<const N: usize>(directory: &PathBuf, arguments: [&str; N]) -> Option<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

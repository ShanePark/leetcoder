use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

use super::fingerprint::classpath_fingerprint;
use super::helpers::GRADLE_INIT_SCRIPT;
use super::process::{
    create_private_temp_dir, first_output_line, format_process_failure, run_bounded,
    write_private_file,
};

pub(super) const CLASSPATH_MARKER: &str = "LEETCODER_PS_CLASSPATH_V1:";
const GRADLE_TASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
pub(super) const MAX_CLASSPATH_ENTRIES: usize = 4096;
const INIT_SCRIPT_NAME: &str = "leetcoder-ps-classpath.gradle";

#[derive(Debug, Deserialize)]
struct ClasspathEntry {
    path: PathBuf,
}

pub(super) fn gradle_wrapper(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("gradlew.bat")
    } else {
        root.join("gradlew")
    }
}

pub(super) fn validate_gradle_wrapper(wrapper: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(wrapper).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!("Gradle wrapper was not found: {}", wrapper.display())
        } else {
            format!(
                "Unable to inspect Gradle wrapper '{}': {error}",
                wrapper.display()
            )
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Gradle wrapper must be a regular file: {}",
            wrapper.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Gradle wrapper is not executable: {} (run chmod +x gradlew)",
                wrapper.display()
            ));
        }
    }
    Ok(())
}

pub(super) fn resolve_main_compile_classpath(
    root: &Path,
    wrapper: &Path,
    java_home: &Path,
) -> Result<Vec<PathBuf>, String> {
    let temp = create_private_temp_dir("leetcoder-ps-classpath")?;
    let script = temp.path().join(INIT_SCRIPT_NAME);
    write_private_file(&script, GRADLE_INIT_SCRIPT.as_bytes(), "Gradle init script")?;

    let mut command = Command::new(wrapper);
    command
        .current_dir(root)
        .env("JAVA_HOME", java_home)
        .arg("--console=plain")
        .arg("--quiet")
        .arg("--init-script")
        .arg(&script)
        .arg("leetcoderPrintMainCompileClasspath")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(
        &mut command,
        GRADLE_TASK_TIMEOUT,
        "Gradle classpath resolution",
    )?;
    if !output.success {
        return Err(format_process_failure(
            "Gradle could not resolve the main Java compile classpath",
            &output,
        ));
    }
    parse_classpath_output(&output.stdout)
}

pub(super) fn parse_classpath_output(stdout: &[u8]) -> Result<Vec<PathBuf>, String> {
    let text = String::from_utf8_lossy(stdout);
    let mut found = None;
    for line in text.lines() {
        let Some(json) = line.trim().strip_prefix(CLASSPATH_MARKER) else {
            continue;
        };
        if found.is_some() {
            return Err("Gradle returned more than one main compile classpath.".to_string());
        }
        found = Some(json);
    }
    let json = found.ok_or_else(|| {
        let detail = first_output_line(&text);
        match detail {
            Some(line) => {
                format!("Gradle did not report the main Java compile classpath. Output: {line}")
            }
            None => "Gradle did not report the main Java compile classpath.".to_string(),
        }
    })?;
    let entries: Vec<ClasspathEntry> = serde_json::from_str(json)
        .map_err(|error| format!("Gradle returned invalid classpath metadata: {error}"))?;
    if entries.len() > MAX_CLASSPATH_ENTRIES {
        return Err(format!(
            "Gradle returned too many compile classpath entries (maximum {MAX_CLASSPATH_ENTRIES})."
        ));
    }

    let mut paths = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = fs::canonicalize(&entry.path).map_err(|error| {
            format!(
                "Unable to resolve Gradle classpath entry '{}': {error}",
                entry.path.display()
            )
        })?;
        if !path.is_file() && !path.is_dir() {
            return Err(format!(
                "Gradle classpath entry is not a file or directory: {}",
                path.display()
            ));
        }
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(super) fn resolve_project_classpath(root: &Path) -> Result<(Vec<PathBuf>, String), String> {
    let wrapper = gradle_wrapper(root);
    validate_gradle_wrapper(&wrapper)?;
    let gradle_java = crate::runner::discover_compatible_java()?;
    let classpath = resolve_main_compile_classpath(root, &wrapper, &gradle_java.home)?;
    let fingerprint = classpath_fingerprint(root, &classpath)?;
    Ok((classpath, fingerprint))
}

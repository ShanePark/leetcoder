use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

const MIN_SUPPORTED_JAVA_MAJOR: u32 = 11;
const TARGET_JAVA_MAJOR: u32 = 17;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JavaInstallation {
    pub(crate) home: PathBuf,
    pub(crate) major_version: u32,
}

pub(crate) fn discover_compatible_java() -> Result<JavaInstallation, String> {
    let mut homes = Vec::new();
    for variable in ["JAVA_HOME", "JDK_HOME"] {
        if let Some(home) = std::env::var_os(variable) {
            homes.push(PathBuf::from(home));
        }
    }

    if let Some(java) = executable_from_path("java") {
        if let Some(home) = java_home_from_executable(&java) {
            homes.push(home);
        }
    }
    if let Some(javac) = executable_from_path("javac") {
        if let Some(home) = java_home_from_executable(&javac) {
            homes.push(home);
        }
    }
    homes.extend(discover_environment_java_homes());

    #[cfg(target_os = "macos")]
    homes.extend(discover_macos_java_homes());

    #[cfg(target_os = "linux")]
    homes.extend(discover_linux_java_homes());

    let homes = deduplicate_paths(homes);
    let installations: Vec<JavaInstallation> = homes
        .iter()
        .filter_map(|home| probe_java_home(home))
        .collect();
    if let Some(java) = select_compatible_java(&installations) {
        return Ok(java);
    }

    let detected = installations
        .iter()
        .map(|java| format!("{} (Java {})", java.home.display(), java.major_version))
        .collect::<Vec<_>>();
    let detected = if detected.is_empty() {
        "none discovered".to_string()
    } else {
        detected.join(", ")
    };
    Err(format!(
        "No compatible JDK was found for Gradle 7.3.3. Leetcoder prefers Java {} and supports Java {}-{}. Detected: {}. Install a compatible JDK or set JAVA_HOME before launching leetcoder.",
        TARGET_JAVA_MAJOR, MIN_SUPPORTED_JAVA_MAJOR, TARGET_JAVA_MAJOR, detected
    ))
}

pub(crate) fn select_compatible_java(candidates: &[JavaInstallation]) -> Option<JavaInstallation> {
    candidates
        .iter()
        .filter(|candidate| {
            (MIN_SUPPORTED_JAVA_MAJOR..=TARGET_JAVA_MAJOR).contains(&candidate.major_version)
        })
        .max_by_key(|candidate| candidate.major_version)
        .cloned()
}

pub(crate) fn probe_java_home(home: &Path) -> Option<JavaInstallation> {
    let java = home.join("bin").join(executable_name("java"));
    let javac = home.join("bin").join(executable_name("javac"));
    if !is_regular_file(&java) || !is_regular_file(&javac) {
        return None;
    }
    let output = Command::new(&java).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let major_version = parse_java_major_version(&version_output)?;
    Some(JavaInstallation {
        home: canonical_path(home),
        major_version,
    })
}

pub(crate) fn parse_java_major_version(output: &str) -> Option<u32> {
    let version = output
        .lines()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            let marker = lower.find("version")?;
            let value = line[marker + "version".len()..]
                .trim()
                .split_whitespace()
                .next()?
                .trim_matches('"');
            Some(value)
        })
        .or_else(|| {
            output.split_whitespace().find_map(|value| {
                value
                    .trim_matches('"')
                    .chars()
                    .next()
                    .filter(char::is_ascii_digit)
                    .map(|_| value.trim_matches('"'))
            })
        })?;

    let mut components = version.split('.');
    let first = components.next()?.parse::<u32>().ok()?;
    if first == 1 {
        components.next()?.parse::<u32>().ok()
    } else {
        Some(first)
    }
}

pub(crate) fn path_with_java_home(home: &Path) -> OsString {
    let mut paths = vec![home.join("bin")];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| {
        let mut fallback = OsString::from(home.join("bin").as_os_str());
        if let Some(path) = std::env::var_os("PATH") {
            fallback.push(if cfg!(windows) { ";" } else { ":" });
            fallback.push(path);
        }
        fallback
    })
}

pub(crate) fn executable_from_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(executable_name(name));
        if is_regular_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn java_home_from_executable(executable: &Path) -> Option<PathBuf> {
    let executable = canonical_path(executable);
    let bin = executable.parent()?;
    if bin.file_name() != Some(OsStr::new("bin")) {
        return None;
    }
    bin.parent().map(Path::to_path_buf)
}

pub(crate) fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub(crate) fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

pub(crate) fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| canonical_path(&path))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

pub(crate) fn discover_environment_java_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Some(root) = std::env::var_os("SDKMAN_CANDIDATES_DIR") {
        scan_java_home_root(&PathBuf::from(root).join("java"), &mut homes);
    }
    if let Some(home) = std::env::var_os("HOME") {
        scan_java_home_root(
            &PathBuf::from(home).join(".sdkman/candidates/java"),
            &mut homes,
        );
    }
    if let Some(root) = std::env::var_os("ASDF_DATA_DIR") {
        scan_java_home_root(&PathBuf::from(root).join("installs/java"), &mut homes);
    }
    homes
}

#[cfg(target_os = "macos")]
pub(crate) fn discover_macos_java_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for version in MIN_SUPPORTED_JAVA_MAJOR..=TARGET_JAVA_MAJOR {
        let output = Command::new("/usr/libexec/java_home")
            .arg("-v")
            .arg(version.to_string())
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !home.is_empty() {
                    homes.push(PathBuf::from(home));
                }
            }
        }
    }
    homes
}

#[cfg(target_os = "linux")]
pub(crate) fn discover_linux_java_homes() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Ok(output) = Command::new("update-alternatives")
        .args(["--list", "java"])
        .output()
    {
        if output.status.success() {
            for executable in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some(home) = java_home_from_executable(Path::new(executable.trim())) {
                    homes.push(home);
                }
            }
        }
    }
    for root in ["/usr/lib/jvm", "/usr/java", "/opt/java"] {
        scan_java_home_root(Path::new(root), &mut homes);
    }
    homes
}

pub(crate) fn scan_java_home_root(root: &Path, homes: &mut Vec<PathBuf>) {
    if is_regular_file(&root.join("bin").join(executable_name("java"))) {
        homes.push(root.to_path_buf());
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_regular_file(&path.join("bin").join(executable_name("java"))) {
            homes.push(path);
        }
    }
}

pub(crate) fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

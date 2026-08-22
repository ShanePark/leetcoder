use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) const SOURCE_ROOT: &str = "src/main/java/shane/leetcode/problems";
pub(crate) const KOTLIN_SOURCE_ROOT: &str = "src/main/kotlin/shane/leetcode/problems";
pub(crate) const PACKAGE_SEGMENTS: [&str; 3] = ["easy", "medium", "xhard"];

/// Resolve a user-selected project directory once, before any filesystem
/// operation. Commands intentionally work from the canonical directory so a
/// project selected through a symlink cannot change its security boundary.
pub(crate) fn canonical_project_root(project_root: &str) -> Result<PathBuf, String> {
    let input = project_root.trim();
    if input.is_empty() {
        return Err("projectRoot must not be empty".to_string());
    }

    let root = fs::canonicalize(input)
        .map_err(|error| format!("Unable to resolve projectRoot '{}': {error}", input))?;
    if !root.is_dir() {
        return Err(format!(
            "projectRoot is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

pub(crate) fn package_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let source_root = root.join(SOURCE_ROOT);
    let mut directories = Vec::with_capacity(PACKAGE_SEGMENTS.len());

    for segment in PACKAGE_SEGMENTS {
        let lexical = source_root.join(segment);
        let metadata = fs::symlink_metadata(&lexical).map_err(|error| {
            format!(
                "Required package directory '{}' is unavailable: {error}",
                lexical.display()
            )
        })?;
        if !metadata.is_dir() {
            return Err(format!(
                "Required package path is not a directory: {}",
                lexical.display()
            ));
        }

        // A symlinked package directory is not needed by this repository and
        // makes it much easier to accidentally expose files outside ps.
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Symlinked package directory is not allowed: {}",
                lexical.display()
            ));
        }

        let canonical = fs::canonicalize(&lexical).map_err(|error| {
            format!(
                "Unable to resolve package directory '{}': {error}",
                lexical.display()
            )
        })?;
        if !is_within(root, &canonical) {
            return Err(format!(
                "Package directory escapes projectRoot: {}",
                lexical.display()
            ));
        }
        directories.push(canonical);
    }

    Ok(directories)
}

/// Return Java and (when present) Kotlin problem package directories. Java is
/// the required source tree for this project; Kotlin is included so collision
/// detection and the file browser see the repository's existing `.kt` files.
pub(crate) fn all_package_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut directories = package_directories(root)?;
    let kotlin_source_root = root.join(KOTLIN_SOURCE_ROOT);
    if !kotlin_source_root.exists() {
        return Ok(directories);
    }

    for segment in PACKAGE_SEGMENTS {
        let lexical = kotlin_source_root.join(segment);
        let metadata = match fs::symlink_metadata(&lexical) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Unable to inspect Kotlin package directory '{}': {error}",
                    lexical.display()
                ))
            }
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Kotlin package path is not a regular directory: {}",
                lexical.display()
            ));
        }
        let canonical = fs::canonicalize(&lexical).map_err(|error| {
            format!(
                "Unable to resolve Kotlin package directory '{}': {error}",
                lexical.display()
            )
        })?;
        if !is_within(root, &canonical) {
            return Err(format!(
                "Kotlin package directory escapes projectRoot: {}",
                lexical.display()
            ));
        }
        directories.push(canonical);
    }
    Ok(directories)
}

pub(crate) fn is_source_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("java") || extension.eq_ignore_ascii_case("kt")
        })
}

/// Reject absolute paths and parent components before joining a path to the
/// selected repository. This is deliberately stricter than normalizing `..`:
/// callers cannot use a path that is temporarily outside the boundary.
pub(crate) fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let input = relative_path.trim();
    if input.is_empty() {
        return Err("relativePath must not be empty".to_string());
    }

    let path = Path::new(input);
    if path.is_absolute() {
        return Err("relativePath must be relative to projectRoot".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir => return Err("relativePath may not contain '..'".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("relativePath must not contain a root or volume prefix".to_string())
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("relativePath must identify a file".to_string());
    }
    if !is_source_file(&normalized) {
        return Err("Only .java and .kt source files are allowed".to_string());
    }
    Ok(normalized)
}

pub(crate) fn resolve_existing_source_file(
    root: &Path,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let relative = validate_relative_path(relative_path)?;
    let package_dirs = all_package_directories(root)?;
    let lexical = root.join(&relative);
    let package_dir = package_dirs
        .iter()
        .find(|directory| lexical.starts_with(directory))
        .ok_or_else(|| {
            format!(
                "Path is outside the allowed problem packages: {}",
                relative.display()
            )
        })?;

    let metadata = fs::symlink_metadata(&lexical)
        .map_err(|error| format!("Unable to access '{}': {error}", relative.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Symlinked source files are not allowed: {relative_path}"
        ));
    }
    if !metadata.is_file() {
        return Err(format!("Path is not a regular file: {relative_path}"));
    }

    let canonical = fs::canonicalize(&lexical)
        .map_err(|error| format!("Unable to resolve '{}': {error}", relative.display()))?;
    if !is_within(package_dir, &canonical) {
        return Err(format!(
            "Path escapes the allowed problem package: {relative_path}"
        ));
    }

    Ok((lexical, canonical))
}

pub(crate) fn resolve_new_source_file(
    root: &Path,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let relative = validate_relative_path(relative_path)?;
    let package_dirs = all_package_directories(root)?;
    let lexical = root.join(&relative);
    let package_dir = package_dirs
        .iter()
        .find(|directory| lexical.starts_with(directory))
        .ok_or_else(|| {
            format!(
                "Path is outside the allowed problem packages: {}",
                relative.display()
            )
        })?;

    let parent = lexical
        .parent()
        .ok_or_else(|| format!("Unable to determine parent directory: {relative_path}"))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        format!(
            "Unable to resolve parent directory for '{}': {error}",
            relative.display()
        )
    })?;
    if !is_within(package_dir, &canonical_parent) {
        return Err(format!(
            "Parent directory escapes the allowed package: {relative_path}"
        ));
    }

    // `symlink_metadata` also finds dangling links. create_new below remains
    // the final no-overwrite guarantee, while this check prevents us from
    // treating a link as a new source path.
    if fs::symlink_metadata(&lexical).is_ok() {
        return Err(format!("File already exists: {relative_path}"));
    }

    Ok((lexical, canonical_parent))
}

pub(crate) fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("Path is outside projectRoot: {}", path.display()))?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

pub(crate) fn is_within(base: &Path, candidate: &Path) -> bool {
    candidate == base || candidate.starts_with(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs as unix_fs;

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("tempdir");
        for segment in PACKAGE_SEGMENTS {
            fs::create_dir_all(directory.path().join(SOURCE_ROOT).join(segment))
                .expect("package directory");
        }
        directory
    }

    #[test]
    fn rejects_absolute_and_parent_paths() {
        assert!(validate_relative_path("/tmp/escape.java").is_err());
        assert!(validate_relative_path("src/main/java/../escape.java").is_err());
        assert!(
            validate_relative_path("src/main/java/shane/leetcode/problems/easy/a.txt").is_err()
        );
    }

    #[test]
    fn allows_only_problem_package_files() {
        let directory = fixture();
        let root = canonical_project_root(directory.path().to_str().unwrap()).unwrap();
        let path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
        fs::write(root.join(path), "class Q1 {}").unwrap();
        assert!(resolve_existing_source_file(&root, path).is_ok());
        assert!(resolve_new_source_file(
            &root,
            "src/main/java/shane/leetcode/problems/easy/Q2.java"
        )
        .is_ok());
        assert!(resolve_new_source_file(
            &root,
            "src/main/java/shane/leetcode/problems/other/Q2.java"
        )
        .is_err());
    }

    #[test]
    fn rejects_symlink_escape_for_existing_and_new_paths() {
        let directory = fixture();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("outside.java");
        fs::write(&outside_file, "outside").unwrap();
        let root = canonical_project_root(directory.path().to_str().unwrap()).unwrap();
        let link = root.join(SOURCE_ROOT).join("easy").join("Escape.java");
        unix_fs::symlink(&outside_file, &link).unwrap();

        assert!(resolve_existing_source_file(
            &root,
            "src/main/java/shane/leetcode/problems/easy/Escape.java"
        )
        .is_err());
        assert!(resolve_new_source_file(
            &root,
            "src/main/java/shane/leetcode/problems/easy/Escape.java"
        )
        .is_err());
    }
}

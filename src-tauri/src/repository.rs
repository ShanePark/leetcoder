use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::models::{
    CreateProblemFileArgs, ProblemFileArgs, ProblemFileContent, ProblemFileList, ProjectValidation,
};
use crate::security::{
    all_package_directories, canonical_project_root, relative_path, resolve_existing_source_file,
    resolve_new_source_file, PACKAGE_SEGMENTS, SOURCE_ROOT,
};

const REQUIRED_FILES: [&str; 3] = ["build.gradle", "settings.gradle", "gradlew"];

pub(crate) fn validate_project(project_root: &str) -> ProjectValidation {
    let requested_root = project_root.trim().to_string();
    let mut missing_paths = Vec::new();
    let mut errors = Vec::new();

    let root = match canonical_project_root(project_root) {
        Ok(root) => root,
        Err(error) => {
            if !requested_root.is_empty() && !Path::new(&requested_root).exists() {
                missing_paths.push("projectRoot".to_string());
            }
            errors.push(error.clone());
            return ProjectValidation {
                valid: false,
                project_root: requested_root,
                missing_paths,
                errors,
                message: Some(error),
            };
        }
    };

    for required_file in REQUIRED_FILES {
        let path = root.join(required_file);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => errors.push(format!(
                "Required path is not a regular file: {required_file}"
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_paths.push(required_file.to_string())
            }
            Err(error) => errors.push(format!("Unable to inspect {required_file}: {error}")),
        }
    }

    let source_root = root.join(SOURCE_ROOT);
    match fs::symlink_metadata(&source_root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => errors.push(format!("Required path is not a directory: {SOURCE_ROOT}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            missing_paths.push(SOURCE_ROOT.to_string())
        }
        Err(error) => errors.push(format!("Unable to inspect {SOURCE_ROOT}: {error}")),
    }

    for segment in PACKAGE_SEGMENTS {
        let relative = format!("{SOURCE_ROOT}/{segment}");
        let path = root.join(&relative);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                if metadata.file_type().is_symlink() {
                    errors.push(format!(
                        "Symlinked package directory is not allowed: {relative}"
                    ));
                } else if let Ok(canonical) = fs::canonicalize(&path) {
                    if !crate::security::is_within(&root, &canonical) {
                        errors.push(format!("Package directory escapes projectRoot: {relative}"));
                    }
                }
            }
            Ok(_) => errors.push(format!("Required path is not a directory: {relative}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_paths.push(relative)
            }
            Err(error) => errors.push(format!("Unable to inspect {relative}: {error}")),
        }
    }

    let message = if missing_paths.is_empty() && errors.is_empty() {
        None
    } else {
        let mut details = missing_paths.clone();
        details.extend(errors.clone());
        Some(details.join("; "))
    };
    ProjectValidation {
        valid: missing_paths.is_empty() && errors.is_empty(),
        project_root: root.to_string_lossy().into_owned(),
        missing_paths,
        errors,
        message,
    }
}

pub(crate) fn list_problem_files(project_root: &str) -> Result<ProblemFileList, String> {
    let root = canonical_project_root(project_root)?;
    let package_dirs = all_package_directories(&root)?;
    let mut files = Vec::new();

    for package_dir in package_dirs {
        collect_source_files(&root, &package_dir, &mut files)?;
    }
    files.sort();
    Ok(ProblemFileList { files })
}

fn collect_source_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Unable to list '{}': {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect directory entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Unable to inspect '{}': {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_source_files(root, &path, files)?;
        } else if metadata.is_file() && crate::security::is_source_file(&path) {
            files.push(relative_path(root, &path)?);
        }
    }
    Ok(())
}

pub(crate) fn read_problem_file(args: ProblemFileArgs) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    let content = fs::read_to_string(&canonical)
        .map_err(|error| format!("Unable to read '{}': {error}", args.relative_path))?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &lexical)?,
        content,
    })
}

pub(crate) fn create_problem_file(
    args: CreateProblemFileArgs,
) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (path, canonical_parent) = resolve_new_source_file(&root, &args.relative_path)?;
    let mut temporary = NamedTempFile::new_in(&canonical_parent).map_err(|error| {
        format!(
            "Unable to create a temporary file for '{}': {error}",
            args.relative_path
        )
    })?;
    temporary
        .write_all(args.content.as_bytes())
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Unable to prepare '{}': {error}", args.relative_path))?;
    temporary
        .persist_noclobber(&path)
        .map_err(|error| format!("Unable to create '{}': {}", args.relative_path, error.error))?;
    sync_directory(&canonical_parent).map_err(|error| {
        format!(
            "File '{}' was created, but its directory could not be synchronized: {error}",
            args.relative_path
        )
    })?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &path)?,
        content: args.content,
    })
}

pub(crate) fn save_problem_file(args: CreateProblemFileArgs) -> Result<ProblemFileContent, String> {
    let root = canonical_project_root(&args.project_root)?;
    let (lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    let canonical_parent = canonical.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory: {}",
            args.relative_path
        )
    })?;
    let existing_permissions = fs::metadata(&canonical)
        .map_err(|error| format!("Unable to inspect '{}': {error}", args.relative_path))?
        .permissions();
    let mut temporary = NamedTempFile::new_in(canonical_parent).map_err(|error| {
        format!(
            "Unable to create a temporary file for '{}': {error}",
            args.relative_path
        )
    })?;
    temporary
        .as_file()
        .set_permissions(existing_permissions)
        .and_then(|_| temporary.write_all(args.content.as_bytes()))
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Unable to prepare '{}': {error}", args.relative_path))?;
    temporary
        .persist(&canonical)
        .map_err(|error| format!("Unable to save '{}': {}", args.relative_path, error.error))?;
    sync_directory(canonical_parent).map_err(|error| {
        format!(
            "File '{}' was saved, but its directory could not be synchronized: {error}",
            args.relative_path
        )
    })?;
    Ok(ProblemFileContent {
        relative_path: relative_path(&root, &lexical)?,
        content: args.content,
    })
}

pub(crate) fn delete_problem_file(args: ProblemFileArgs) -> Result<(), String> {
    let root = canonical_project_root(&args.project_root)?;
    let (_lexical, canonical) = resolve_existing_source_file(&root, &args.relative_path)?;
    fs::remove_file(&canonical)
        .map_err(|error| format!("Unable to delete '{}': {error}", args.relative_path))?;
    let canonical_parent = canonical.parent().ok_or_else(|| {
        format!(
            "File '{}' was deleted, but its parent directory could not be determined",
            args.relative_path
        )
    })?;
    // The directory sync improves durability on Unix, but the file has
    // already been removed successfully. Keep deletion successful if the
    // filesystem cannot sync the parent (for example, on a special volume).
    let _ = sync_directory(canonical_parent);
    Ok(())
}

fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::PACKAGE_SEGMENTS;

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("tempdir");
        for segment in PACKAGE_SEGMENTS {
            fs::create_dir_all(directory.path().join(SOURCE_ROOT).join(segment))
                .expect("package directory");
        }
        for file in REQUIRED_FILES {
            std::fs::File::create(directory.path().join(file)).expect("required file");
        }
        directory
    }

    #[test]
    fn validation_reports_missing_repository_parts() {
        let directory = tempfile::tempdir().unwrap();
        let result = validate_project(directory.path().to_str().unwrap());
        assert!(!result.valid);
        assert!(result
            .missing_paths
            .iter()
            .any(|path| path == "build.gradle"));
        assert!(result
            .missing_paths
            .iter()
            .any(|path| path.ends_with("/easy")));
    }

    #[test]
    fn create_is_new_only_and_save_requires_existing_file() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
        let created = create_problem_file(CreateProblemFileArgs {
            project_root: root.clone(),
            relative_path: relative_path.to_string(),
            content: "first".to_string(),
        })
        .unwrap();
        assert_eq!(created.content, "first");
        assert!(create_problem_file(CreateProblemFileArgs {
            project_root: root.clone(),
            relative_path: relative_path.to_string(),
            content: "second".to_string(),
        })
        .is_err());
        let saved = save_problem_file(CreateProblemFileArgs {
            project_root: root,
            relative_path: relative_path.to_string(),
            content: "second".to_string(),
        })
        .unwrap();
        assert_eq!(saved.content, "second");
        assert_eq!(
            fs::read_to_string(directory.path().join(relative_path)).unwrap(),
            "second"
        );
    }

    #[test]
    fn atomic_save_leaves_no_temp_source_file() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
        let target = directory.path().join(relative_path);
        fs::write(&target, "before").unwrap();
        let parent = target.parent().unwrap();
        let before_entries = fs::read_dir(parent).unwrap().count();

        save_problem_file(CreateProblemFileArgs {
            project_root: root,
            relative_path: relative_path.to_string(),
            content: "after".to_string(),
        })
        .unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        assert_eq!(fs::read_dir(parent).unwrap().count(), before_entries);
    }

    #[test]
    fn delete_removes_only_existing_problem_source_files() {
        let directory = fixture();
        let root = directory.path().to_string_lossy().to_string();
        let relative_path = "src/main/java/shane/leetcode/problems/easy/Q1.java";
        fs::write(directory.path().join(relative_path), "class Q1 {}").unwrap();

        delete_problem_file(ProblemFileArgs {
            project_root: root.clone(),
            relative_path: relative_path.to_string(),
        })
        .unwrap();
        assert!(!directory.path().join(relative_path).exists());
        let error = delete_problem_file(ProblemFileArgs {
            project_root: root,
            relative_path: relative_path.to_string(),
        })
        .unwrap_err();
        assert!(error.contains("Unable to access") || error.contains("not a regular file"));
    }

    #[test]
    fn delete_rejects_non_source_paths() {
        let directory = fixture();
        let error = delete_problem_file(ProblemFileArgs {
            project_root: directory.path().to_string_lossy().to_string(),
            relative_path: "build.gradle".to_string(),
        })
        .unwrap_err();
        assert!(error.contains("Only .java and .kt source files are allowed"));
    }
}

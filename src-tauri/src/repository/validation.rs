use std::fs;
use std::path::Path;

use crate::models::ProjectValidation;
use crate::security::{canonical_project_root, PACKAGE_SEGMENTS, SOURCE_ROOT};

pub(super) const REQUIRED_FILES: [&str; 3] = ["build.gradle", "settings.gradle", "gradlew"];

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

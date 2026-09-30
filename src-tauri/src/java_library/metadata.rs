use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::classpath::{gradle_wrapper, resolve_main_compile_classpath, validate_gradle_wrapper};
use super::fingerprint::classpath_fingerprint;
use super::inspection::inspect_classpath;
use super::types::PsLibraryMetadata;

static LAST_METADATA: OnceLock<Mutex<Option<(PathBuf, String, PsLibraryMetadata)>>> =
    OnceLock::new();

/// Resolve the selected Gradle project's main compile classpath and inspect its Ps class.
/// The Gradle wrapper is run only when the caller explicitly refreshes library metadata.
pub(crate) fn inspect_ps_library(project_root: &Path) -> Result<PsLibraryMetadata, String> {
    let root = fs::canonicalize(project_root).map_err(|error| {
        format!(
            "Unable to resolve Java project root '{}': {error}",
            project_root.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Java project root is not a directory: {}",
            root.display()
        ));
    }

    let wrapper = gradle_wrapper(&root);
    validate_gradle_wrapper(&wrapper)?;
    let java = crate::runner::discover_compatible_java()?;
    let classpath = resolve_main_compile_classpath(&root, &wrapper, &java.home)?;
    let fingerprint = classpath_fingerprint(&root, &classpath)?;

    if let Some(metadata) = cached_metadata(&root, &fingerprint) {
        return Ok(metadata);
    }

    let mut methods = inspect_classpath(&java.home, &classpath)?;
    methods.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| {
                left.parameters
                    .iter()
                    .map(|parameter| parameter.type_name.as_str())
                    .cmp(
                        right
                            .parameters
                            .iter()
                            .map(|parameter| parameter.type_name.as_str()),
                    )
            })
            .then_with(|| left.return_type.cmp(&right.return_type))
    });

    let metadata = PsLibraryMetadata {
        fingerprint,
        methods,
    };
    store_cached_metadata(root, metadata.clone());
    Ok(metadata)
}

fn cached_metadata(root: &Path, fingerprint: &str) -> Option<PsLibraryMetadata> {
    LAST_METADATA
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|(cached_root, cached_fingerprint, _)| {
            cached_root == root && cached_fingerprint == fingerprint
        })
        .map(|(_, _, metadata)| metadata.clone())
}

fn store_cached_metadata(root: PathBuf, metadata: PsLibraryMetadata) {
    *LAST_METADATA
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((root, metadata.fingerprint.clone(), metadata));
}

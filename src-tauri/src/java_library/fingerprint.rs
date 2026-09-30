use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const METADATA_SCHEMA: &str = "ps-metadata-v1";
pub(super) const TYPE_MEMBERS_SCHEMA: &str = "java-type-members-v1";
const MAX_FINGERPRINT_FILES: usize = 200_000;
const MAX_FINGERPRINT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(super) fn java_environment_fingerprint() -> String {
    let mut hash = StableHash::new();
    for variable in ["JAVA_HOME", "JDK_HOME", "PATH"] {
        hash.update(variable.as_bytes());
        hash.update(&[0]);
        if let Some(value) = std::env::var_os(variable) {
            hash.update(value.to_string_lossy().as_bytes());
        }
        hash.update(&[0xff]);
    }
    format!("env-{:016x}", hash.finish())
}

pub(super) fn java_identity(java: &crate::runner::JavaInstallation) -> String {
    let release = fs::read(java.home.join("release")).unwrap_or_default();
    let mut hash = StableHash::new();
    hash.update(java.home.to_string_lossy().as_bytes());
    hash.update(&release);
    let version = String::from_utf8_lossy(&release)
        .lines()
        .find_map(|line| line.strip_prefix("JAVA_VERSION=\""))
        .and_then(|version| version.strip_suffix('"'))
        .unwrap_or("unknown")
        .to_string();
    format!(
        "jdk-{version}-{}#{:016x}",
        java.major_version,
        hash.finish()
    )
}

pub(super) fn project_config_fingerprint(root: &Path) -> Result<String, String> {
    let mut candidates = vec![
        root.join("settings.gradle"),
        root.join("settings.gradle.kts"),
        root.join("build.gradle"),
        root.join("build.gradle.kts"),
        root.join("gradle.properties"),
        root.join("gradle/wrapper/gradle-wrapper.properties"),
        root.join("gradle/libs.versions.toml"),
    ];
    if let Ok(entries) = fs::read_dir(root.join("gradle")) {
        candidates.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".versions.toml"))
        }));
    }
    candidates.sort();
    candidates.dedup();
    let mut hash = StableHash::new();
    hash.update(root.to_string_lossy().as_bytes());
    let mut total_bytes = 0_u64;
    for path in candidates {
        if !path.is_file() {
            continue;
        }
        let contents = fs::read(&path).map_err(|error| {
            format!(
                "Unable to fingerprint Gradle configuration '{}': {error}",
                path.display()
            )
        })?;
        total_bytes = total_bytes.saturating_add(contents.len() as u64);
        if total_bytes > 4 * 1024 * 1024 {
            return Err(
                "Gradle configuration files exceed the metadata fingerprint limit.".to_string(),
            );
        }
        hash.update(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_bytes(),
        );
        hash.update(&contents);
    }
    Ok(format!("config-{:016x}", hash.finish()))
}

pub(super) fn metadata_fingerprint(
    root: &Path,
    config_fingerprint: &str,
    java_identity: &str,
    classpath_fingerprint: Option<&str>,
) -> String {
    let root_key = root.to_string_lossy();
    let mut root_hash = StableHash::new();
    root_hash.update(root_key.as_bytes());
    let classpath_fingerprint = classpath_fingerprint.unwrap_or("unresolved");
    format!(
        "{TYPE_MEMBERS_SCHEMA}:root-{:016x}:{config_fingerprint}:{java_identity}:classpath-{classpath_fingerprint}",
        root_hash.finish()
    )
}

pub(super) fn classpath_fingerprint(root: &Path, classpath: &[PathBuf]) -> Result<String, String> {
    let mut hash = StableHash::new();
    hash.update(METADATA_SCHEMA.as_bytes());
    hash.update(root.to_string_lossy().as_bytes());
    let mut files_hashed = 0_usize;
    let mut entries_visited = 0_usize;
    let mut bytes_hashed = 0_u64;

    for path in classpath {
        hash.update(&[0]);
        hash.update(path.to_string_lossy().as_bytes());
        if path.is_file() {
            hash.update(&[1]);
            hash_file(path, &mut hash, &mut files_hashed, &mut bytes_hashed)?;
        } else {
            hash.update(&[2]);
            hash_directory_class_files(
                path,
                path,
                &mut hash,
                &mut files_hashed,
                &mut entries_visited,
                &mut bytes_hashed,
                &mut HashSet::new(),
            )?;
        }
    }
    Ok(format!("{}:{:016x}", METADATA_SCHEMA, hash.finish()))
}

fn hash_directory_class_files(
    logical_directory: &Path,
    directory: &Path,
    hash: &mut StableHash,
    files_hashed: &mut usize,
    entries_visited: &mut usize,
    bytes_hashed: &mut u64,
    visited_directories: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical = fs::canonicalize(directory).map_err(|error| {
        format!(
            "Unable to resolve Java classpath directory '{}': {error}",
            directory.display()
        )
    })?;
    if !visited_directories.insert(canonical.clone()) {
        hash.update(b"directory-already-visited");
        return Ok(());
    }

    let mut entries = fs::read_dir(&canonical)
        .map_err(|error| {
            format!(
                "Unable to read Java classpath directory '{}': {error}",
                canonical.display()
            )
        })?
        .map(|entry| {
            entry.map(|entry| entry.path()).map_err(|error| {
                format!(
                    "Unable to list Java classpath directory '{}': {error}",
                    canonical.display()
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    for entry in entries {
        *entries_visited += 1;
        if *entries_visited > MAX_FINGERPRINT_FILES {
            return Err(format!(
                "The Java compile classpath contains more than {MAX_FINGERPRINT_FILES} directory entries."
            ));
        }
        let file_name = entry.file_name().ok_or_else(|| {
            format!(
                "Unable to determine a Java classpath entry name: {}",
                entry.display()
            )
        })?;
        let logical_entry = logical_directory.join(file_name);
        let metadata = fs::symlink_metadata(&entry).map_err(|error| {
            format!(
                "Unable to inspect Java classpath entry '{}': {error}",
                entry.display()
            )
        })?;
        let resolved = if metadata.file_type().is_symlink() {
            match fs::canonicalize(&entry) {
                Ok(path) => path,
                Err(_) => {
                    hash.update(b"broken-symlink");
                    hash.update(logical_entry.to_string_lossy().as_bytes());
                    continue;
                }
            }
        } else {
            entry
        };

        let resolved_metadata = fs::metadata(&resolved).map_err(|error| {
            format!(
                "Unable to inspect Java classpath entry '{}': {error}",
                resolved.display()
            )
        })?;
        if resolved_metadata.is_dir() {
            hash.update(b"directory-entry");
            hash.update(logical_entry.to_string_lossy().as_bytes());
            hash_directory_class_files(
                &logical_entry,
                &resolved,
                hash,
                files_hashed,
                entries_visited,
                bytes_hashed,
                visited_directories,
            )?;
        } else if resolved_metadata.is_file()
            && logical_entry
                .extension()
                .is_some_and(|extension| extension == "class")
        {
            hash.update(b"class-entry");
            hash.update(logical_entry.to_string_lossy().as_bytes());
            hash_file(&resolved, hash, files_hashed, bytes_hashed)?;
        }
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    hash: &mut StableHash,
    files_hashed: &mut usize,
    bytes_hashed: &mut u64,
) -> Result<(), String> {
    *files_hashed += 1;
    if *files_hashed > MAX_FINGERPRINT_FILES {
        return Err(format!(
            "The Java compile classpath contains more than {MAX_FINGERPRINT_FILES} files."
        ));
    }
    let mut file = File::open(path).map_err(|error| {
        format!(
            "Unable to read Java classpath entry '{}': {error}",
            path.display()
        )
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            format!(
                "Unable to fingerprint Java classpath entry '{}': {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        *bytes_hashed = bytes_hashed.saturating_add(read as u64);
        if *bytes_hashed > MAX_FINGERPRINT_BYTES {
            return Err(format!(
                "The Java compile classpath exceeds the {} GiB metadata fingerprint limit.",
                MAX_FINGERPRINT_BYTES / (1024 * 1024 * 1024)
            ));
        }
        hash.update(&buffer[..read]);
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct StableHash(u64);

impl StableHash {
    pub(super) fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    pub(super) fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    pub(super) fn finish(&self) -> u64 {
        self.0
    }
}

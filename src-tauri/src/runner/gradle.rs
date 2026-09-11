use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use tempfile::{Builder, TempDir};

use crate::models::ProblemDiagnostic;
use crate::security::is_within;

use super::java::JavaInstallation;

const INIT_SCRIPT_PREFIX: &str = "leetcoder-init";
const COMPILE_CACHE_SCHEMA: &str = "v1";
const DIAGNOSTICS_TEMP_PREFIX: &str = "leetcoder-diagnostics";

pub(crate) fn gradle_wrapper(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("gradlew.bat")
    } else {
        root.join("gradlew")
    }
}

pub(crate) fn validate_gradle_wrapper(wrapper: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(wrapper).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("Gradle wrapper was not found: {}", wrapper.display())
        } else {
            format!(
                "Unable to inspect Gradle wrapper '{}': {error}",
                wrapper.display()
            )
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Gradle wrapper symlink is not allowed: {}",
            wrapper.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Gradle wrapper is not a regular file: {}",
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

pub(crate) struct InitScript {
    pub(crate) _directory: TempDir,
    pub(crate) path: PathBuf,
    pub(crate) result_dir: PathBuf,
    pub(crate) classes_dir: PathBuf,
    pub(crate) shared_classes_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompileCache {
    pub(crate) classes_dir: PathBuf,
    pub(crate) shared_classes_dir: PathBuf,
}

pub(crate) fn create_compile_cache(
    root: &Path,
    java: &JavaInstallation,
    fully_qualified_class_name: &str,
) -> Result<CompileCache, String> {
    let gradle_version = gradle_wrapper_version(root);
    let java_key = stable_cache_key(&java.home.to_string_lossy());
    let problem_key = stable_cache_key(fully_qualified_class_name);
    let cache_root = root
        .join("build")
        .join("leetcoder")
        .join(COMPILE_CACHE_SCHEMA)
        .join(format!(
            "gradle-{}",
            sanitize_cache_component(&gradle_version)
        ))
        .join(format!("java-{}-{}", java.major_version, java_key));
    let shared_classes_dir = cache_root.join("shared");
    let classes_dir = cache_root.join("problems").join(problem_key);

    secure_cache_directory(root, &shared_classes_dir, "shared Java classes")?;
    secure_cache_directory(root, &classes_dir, "problem Java classes")?;
    Ok(CompileCache {
        classes_dir,
        shared_classes_dir,
    })
}

pub(crate) fn secure_cache_directory(
    root: &Path,
    path: &Path,
    description: &str,
) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Unable to create {description} cache directory '{}': {error}",
            path.display()
        )
    })?;
    let canonical = fs::canonicalize(path).map_err(|error| {
        format!(
            "Unable to resolve {description} cache directory '{}': {error}",
            path.display()
        )
    })?;
    if !is_within(root, &canonical) {
        return Err(format!(
            "The {description} cache directory must stay inside the selected repository: {}",
            canonical.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Unable to secure {description} cache directory '{}': {error}",
                canonical.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn gradle_wrapper_version(root: &Path) -> String {
    let properties = root.join("gradle/wrapper/gradle-wrapper.properties");
    let Ok(contents) = fs::read_to_string(properties) else {
        return "unknown".to_string();
    };
    let Some(distribution_url) = contents
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("distributionUrl="))
    else {
        return "unknown".to_string();
    };
    let filename = distribution_url
        .rsplit('/')
        .next()
        .unwrap_or(distribution_url);
    let filename = filename.replace("\\:", ":");
    let Some(version) = filename.strip_prefix("gradle-") else {
        return "unknown".to_string();
    };
    version
        .split_once("-bin")
        .or_else(|| version.split_once("-all"))
        .map(|(version, _)| version.to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

pub(crate) fn sanitize_cache_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn stable_cache_key(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3_u64);
    }
    format!("{hash:016x}")
}

pub(crate) fn build_gradle_init_script() -> &'static str {
    r#"// Generated temporarily by leetcoder. It is deleted after the run.
import groovy.json.JsonOutput

allprojects {
    plugins.withId('java') {
        def selectedClass = System.getProperty('leetcoderProblemClass')
        if (selectedClass == null || selectedClass.trim().isEmpty()) {
            throw new GradleException('leetcoderProblemClass was not provided')
        }
        def selectedSourcePath = selectedClass.replace('.', '/') + '.java'
        def problemSourceFiles = files(sourceSets.main.java.srcDirs).asFileTree.matching {
            include '**/*.java'
            exclude 'shane/leetcode/problems/easy/**'
            exclude 'shane/leetcode/problems/medium/**'
            exclude 'shane/leetcode/problems/xhard/**'
        }
        def sourceOverride = System.getProperty('leetcoderSourceFile')
        def selectedSourceFiles = sourceOverride != null && !sourceOverride.trim().isEmpty()
            ? files(project.file(sourceOverride))
            : files(sourceSets.main.java.srcDirs).asFileTree.matching {
                include selectedSourcePath
            }
        if (selectedSourceFiles.isEmpty()) {
            throw new GradleException("Selected problem source was not found: ${selectedSourcePath}")
        }
        def classesDirProperty = System.getProperty('leetcoderClassesDir')
        if (classesDirProperty == null || classesDirProperty.trim().isEmpty()) {
            throw new GradleException('leetcoderClassesDir was not provided')
        }
        def classesDir = project.file(classesDirProperty)
        def sharedClassesDirProperty = System.getProperty('leetcoderSharedClassesDir')
        if (sharedClassesDirProperty == null || sharedClassesDirProperty.trim().isEmpty()) {
            throw new GradleException('leetcoderSharedClassesDir was not provided')
        }
        def sharedClassesDir = project.file(sharedClassesDirProperty)
        def jarClasspath = configurations.testRuntimeClasspath.filter { file ->
            file.isFile() && file.name.toLowerCase().endsWith('.jar')
        }
        def sharedCompileTask = tasks.register('leetcoderSharedCompile', JavaCompile) {
            description = 'Compiles shared leetcoder sources only.'
            source problemSourceFiles
            destinationDirectory.set(sharedClassesDir)
            classpath = jarClasspath
            options.encoding = 'UTF-8'
        }
        def compileTask = tasks.register('leetcoderProblemCompile', JavaCompile) {
            description = 'Compiles the selected leetcoder problem only.'
            dependsOn sharedCompileTask
            source selectedSourceFiles
            destinationDirectory.set(classesDir)
            classpath = files(sharedClassesDir) + jarClasspath
            options.encoding = 'UTF-8'
        }
        tasks.register('leetcoderProblemTest', Test) {
            description = 'Runs one leetcoder problem class from the main source set.'
            group = 'verification'
            dependsOn compileTask
            testClassesDirs = files(classesDir)
            classpath = files(classesDir, sharedClassesDir, sourceSets.main.resources.srcDirs) + jarClasspath
            useJUnitPlatform()
            testLogging.showStandardStreams = true
            def resultDir = System.getProperty('leetcoderResultDir')
            if (resultDir == null || resultDir.trim().isEmpty()) {
                throw new GradleException('leetcoderResultDir was not provided')
            }
            reports.junitXml.outputLocation = project.file(resultDir)
            reports.junitXml.outputPerTestCase = true
            def progressMarker = 'LEETCODER_TEST_EVENT_V1:'
            def emitProgress = { payload ->
                println(progressMarker + JsonOutput.toJson(payload))
            }
            beforeTest { descriptor ->
                if (!descriptor.composite) {
                    emitProgress([
                        kind: 'started',
                        className: descriptor.className ?: '',
                        name: descriptor.name ?: '',
                        displayName: descriptor.displayName ?: descriptor.name ?: '',
                        status: 'running',
                    ])
                }
            }
            afterTest { descriptor, result ->
                if (!descriptor.composite) {
                    def resultType = result.resultType?.toString()?.toLowerCase()
                    def status = resultType == 'success' ? 'passed' :
                        resultType == 'failure' ? 'failed' :
                        resultType == 'skipped' ? 'skipped' : 'error'
                    def exceptions = result.exceptions ?: []
                    def message = exceptions ? exceptions[0]?.message : null
                    def details = exceptions
                        .collect { exception -> exception?.toString() }
                        .findAll { value -> value }
                        .join('\n')
                    def durationMs = null
                    if (result.startTime != null && result.endTime != null) {
                        durationMs = Math.max(0L, result.endTime - result.startTime)
                    }
                    emitProgress([
                        kind: 'finished',
                        className: descriptor.className ?: '',
                        name: descriptor.name ?: '',
                        displayName: descriptor.displayName ?: descriptor.name ?: '',
                        status: status,
                        durationMs: durationMs,
                        message: message,
                        details: details ?: null,
                    ])
                }
            }
            outputs.upToDateWhen { false }
        }
    }
}
"#
}

pub(crate) fn create_init_script(compile_cache: &CompileCache) -> Result<InitScript, String> {
    let directory = Builder::new()
        .prefix(INIT_SCRIPT_PREFIX)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| {
            format!("Unable to create private temporary Gradle script directory: {error}")
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "Unable to secure temporary Gradle script directory '{}': {error}",
                    directory.path().display()
                )
            },
        )?;
    }

    let path = directory.path().join("init.gradle");
    let result_dir = directory.path().join("junit-results");
    fs::create_dir(&result_dir).map_err(|error| {
        format!(
            "Unable to create temporary JUnit result directory '{}': {error}",
            result_dir.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&result_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Unable to secure temporary JUnit result directory '{}': {error}",
                result_dir.display()
            )
        })?;
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Unable to create temporary Gradle init script '{}': {error}",
                path.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Unable to secure temporary Gradle init script '{}': {error}",
                path.display()
            )
        })?;
    }
    file.write_all(build_gradle_init_script().as_bytes())
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to write temporary Gradle init script: {error}"))?;
    Ok(InitScript {
        _directory: directory,
        path,
        result_dir,
        classes_dir: compile_cache.classes_dir.clone(),
        shared_classes_dir: compile_cache.shared_classes_dir.clone(),
    })
}

pub(crate) fn create_diagnostics_workspace() -> Result<TempDir, String> {
    let directory = Builder::new()
        .prefix(DIAGNOSTICS_TEMP_PREFIX)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| format!("Unable to create private diagnostics workspace: {error}"))?;
    secure_temp_path(directory.path(), "diagnostics workspace")?;
    Ok(directory)
}

pub(crate) fn write_diagnostics_snapshot(path: &Path, source: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Unable to create temporary diagnostics source '{}': {error}",
                path.display()
            )
        })?;
    file.write_all(source.as_bytes())
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            format!(
                "Unable to write temporary diagnostics source '{}': {error}",
                path.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Unable to secure temporary diagnostics source '{}': {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn secure_temp_path(path: &Path, description: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Unable to inspect {description} '{}': {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{description} is not a regular directory: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Unable to secure {description} '{}': {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

pub(crate) fn remap_snapshot_diagnostics(
    diagnostics: &mut [ProblemDiagnostic],
    snapshot_path: &Path,
    source_relative: &str,
) {
    let canonical_snapshot = fs::canonicalize(snapshot_path).ok();
    for diagnostic in diagnostics {
        let Some(file) = diagnostic.file.as_deref() else {
            continue;
        };
        let exact_match = Path::new(file) == snapshot_path;
        let canonical_match = canonical_snapshot
            .as_ref()
            .is_some_and(|canonical| fs::canonicalize(file).ok().as_ref() == Some(canonical));
        if exact_match || canonical_match {
            diagnostic.file = Some(source_relative.to_string());
        }
    }
}

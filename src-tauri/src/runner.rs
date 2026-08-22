use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde::Deserialize;
use tempfile::{Builder, TempDir};

use crate::models::{
    ProblemDiagnostic, ProblemDiagnosticSeverity, ProblemTestCase, ProblemTestEvent,
    ProblemTestOutputStream, ProblemTestPhase, ProblemTestProgressCase, ProblemTestProgressPhase,
    ProblemTestProgressStatus, ProblemTestResult, ProblemTestStatus, ProblemTestSummary,
    RunProblemTestArgs,
};
use crate::repository;
use crate::security::canonical_project_root;

const INIT_SCRIPT_PREFIX: &str = "leetcoder-init";
const TEST_EVENT_MARKER: &str = "LEETCODER_TEST_EVENT_V1:";
const MAX_JUNIT_XML_BYTES: u64 = 16 * 1024 * 1024;
const MIN_SUPPORTED_JAVA_MAJOR: u32 = 11;
const TARGET_JAVA_MAJOR: u32 = 17;

#[allow(dead_code)]
pub(crate) fn run_problem_test(args: RunProblemTestArgs) -> Result<ProblemTestResult, String> {
    run_problem_test_with_sink(args, None)
}

pub(crate) type ProblemTestEventSink = Arc<dyn Fn(ProblemTestEvent) + Send + Sync + 'static>;

pub(crate) fn run_problem_test_with_sink(
    args: RunProblemTestArgs,
    sink: Option<ProblemTestEventSink>,
) -> Result<ProblemTestResult, String> {
    emit_event(&sink, ProblemTestEvent::Started);
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Starting,
        },
    );
    let root = canonical_project_root(&args.project_root)?;
    validate_fully_qualified_class_name(&args.fully_qualified_class_name)?;

    let wrapper = gradle_wrapper(&root);
    validate_gradle_wrapper(&wrapper)?;

    let validation = repository::validate_project(&args.project_root);
    if !validation.valid {
        return Err(format!(
            "Selected directory is not a valid ps repository: {}",
            validation
                .message
                .unwrap_or_else(|| "required repository files are missing".to_string())
        ));
    }

    let started = Instant::now();
    let java = match discover_compatible_java() {
        Ok(java) => java,
        Err(error) => return Ok(runner_failure_result(error, elapsed_millis(started))),
    };

    let run_temp = create_init_script()?;
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Compiling,
        },
    );
    let mut command = Command::new(&wrapper);
    command
        .current_dir(&root)
        .env("JAVA_HOME", &java.home)
        .env("PATH", path_with_java_home(&java.home))
        .arg("--init-script")
        .arg(&run_temp.path)
        .arg(format!(
            "-DleetcoderResultDir={}",
            run_temp.result_dir.display()
        ))
        .arg(format!(
            "-DleetcoderClassesDir={}",
            run_temp.classes_dir.display()
        ))
        .arg(format!(
            "-DleetcoderProblemClass={}",
            args.fully_qualified_class_name
        ))
        .arg("--no-daemon")
        .arg("leetcoderProblemTest")
        .arg("--tests")
        .arg(&args.fully_qualified_class_name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!(
                "Unable to run Gradle wrapper '{}': {error}",
                wrapper.display()
            );
            emit_event(
                &sink,
                ProblemTestEvent::Log {
                    stream: ProblemTestOutputStream::Stderr,
                    text: message.clone(),
                },
            );
            emit_event(
                &sink,
                ProblemTestEvent::Phase {
                    phase: ProblemTestProgressPhase::Finishing,
                },
            );
            return Ok(runner_failure_result(message, elapsed_millis(started)));
        }
    };

    let capture = capture_child_output(child, sink.clone());
    let elapsed_ms = elapsed_millis(started);
    emit_event(
        &sink,
        ProblemTestEvent::Phase {
            phase: ProblemTestProgressPhase::Finishing,
        },
    );
    Ok(build_problem_test_result(
        &run_temp.result_dir,
        capture.exit_code,
        capture.process_success,
        capture.stdout,
        capture.stderr,
        elapsed_ms,
    ))
}

fn emit_event(sink: &Option<ProblemTestEventSink>, event: ProblemTestEvent) {
    if let Some(sink) = sink {
        sink(event);
    }
}

#[derive(Debug, Default)]
struct ChildOutputCapture {
    exit_code: Option<i32>,
    process_success: bool,
    stdout: String,
    stderr: String,
}

fn capture_child_output(
    mut child: Child,
    sink: Option<ProblemTestEventSink>,
) -> ChildOutputCapture {
    let running_phase_emitted = Arc::new(AtomicBool::new(false));
    let stdout_handle = child.stdout.take().map(|stdout| {
        spawn_stream_reader(
            stdout,
            ProblemTestOutputStream::Stdout,
            sink.clone(),
            running_phase_emitted.clone(),
        )
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        spawn_stream_reader(
            stderr,
            ProblemTestOutputStream::Stderr,
            sink.clone(),
            running_phase_emitted,
        )
    });

    let wait_result = child.wait();
    let mut capture = ChildOutputCapture {
        exit_code: wait_result.as_ref().ok().and_then(|status| status.code()),
        process_success: wait_result
            .as_ref()
            .map(std::process::ExitStatus::success)
            .unwrap_or(false),
        stdout: join_stream_reader(stdout_handle),
        stderr: join_stream_reader(stderr_handle),
    };
    if let Err(error) = wait_result {
        let message = format!("Unable to wait for Gradle wrapper: {error}");
        if !capture.stderr.is_empty() && !capture.stderr.ends_with('\n') {
            capture.stderr.push('\n');
        }
        capture.stderr.push_str(&message);
        emit_event(
            &sink,
            ProblemTestEvent::Log {
                stream: ProblemTestOutputStream::Stderr,
                text: message,
            },
        );
    }
    capture
}

fn spawn_stream_reader<R: Read + Send + 'static>(
    reader: R,
    stream: ProblemTestOutputStream,
    sink: Option<ProblemTestEventSink>,
    running_phase_emitted: Arc<AtomicBool>,
) -> JoinHandle<String> {
    thread::spawn(move || read_stream(reader, stream, sink, running_phase_emitted))
}

fn join_stream_reader(handle: Option<JoinHandle<String>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

fn read_stream<R: Read>(
    reader: R,
    stream: ProblemTestOutputStream,
    sink: Option<ProblemTestEventSink>,
    running_phase_emitted: Arc<AtomicBool>,
) -> String {
    let mut reader = BufReader::new(reader);
    let mut output = String::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let bytes_read = match reader.read_until(b'\n', &mut line) {
            Ok(bytes_read) => bytes_read,
            Err(_) => break,
        };
        if bytes_read == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&line).into_owned();
        if stream == ProblemTestOutputStream::Stdout {
            if let Some(marker) = parse_test_progress_marker(&text) {
                match marker.kind.as_str() {
                    "started" => {
                        if !running_phase_emitted.swap(true, Ordering::AcqRel) {
                            emit_event(
                                &sink,
                                ProblemTestEvent::Phase {
                                    phase: ProblemTestProgressPhase::RunningTests,
                                },
                            );
                        }
                        emit_event(
                            &sink,
                            ProblemTestEvent::TestStarted {
                                test: progress_case_from_marker(
                                    &marker,
                                    ProblemTestProgressStatus::Running,
                                ),
                            },
                        );
                    }
                    "finished" => emit_event(
                        &sink,
                        ProblemTestEvent::TestFinished {
                            test: progress_case_from_marker(&marker, marker_status(&marker)),
                        },
                    ),
                    _ => emit_log(&sink, stream, &text),
                }
                continue;
            }
        }
        output.push_str(&text);
        emit_log(&sink, stream, &text);
    }
    output
}

fn emit_log(sink: &Option<ProblemTestEventSink>, stream: ProblemTestOutputStream, text: &str) {
    if !text.is_empty() {
        // Keep the line ending so consumers can append chunks directly to
        // their live console without having to reconstruct line boundaries.
        emit_event(
            sink,
            ProblemTestEvent::Log {
                stream,
                text: text.to_string(),
            },
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestProgressMarker {
    kind: String,
    #[serde(default)]
    class_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    details: Option<String>,
}

fn parse_test_progress_marker(line: &str) -> Option<TestProgressMarker> {
    let line = line.trim_end_matches(&['\r', '\n'][..]);
    let payload = line.strip_prefix(TEST_EVENT_MARKER)?;
    serde_json::from_str(payload).ok()
}

fn marker_status(marker: &TestProgressMarker) -> ProblemTestProgressStatus {
    match marker
        .status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "passed" | "success" | "successful" => ProblemTestProgressStatus::Passed,
        "failed" | "failure" => ProblemTestProgressStatus::Failed,
        "skipped" | "skip" => ProblemTestProgressStatus::Skipped,
        "running" | "started" => ProblemTestProgressStatus::Running,
        _ => ProblemTestProgressStatus::Error,
    }
}

fn progress_case_from_marker(
    marker: &TestProgressMarker,
    default_status: ProblemTestProgressStatus,
) -> ProblemTestProgressCase {
    ProblemTestProgressCase {
        class_name: marker.class_name.clone(),
        name: marker.name.clone(),
        display_name: marker.display_name.clone(),
        status: if marker.status.is_some() {
            marker_status(marker)
        } else {
            default_status
        },
        duration_ms: marker.duration_ms,
        message: marker.message.clone(),
        details: marker.details.clone(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct JavaInstallation {
    home: PathBuf,
    major_version: u32,
}

fn discover_compatible_java() -> Result<JavaInstallation, String> {
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

fn select_compatible_java(candidates: &[JavaInstallation]) -> Option<JavaInstallation> {
    candidates
        .iter()
        .filter(|candidate| {
            (MIN_SUPPORTED_JAVA_MAJOR..=TARGET_JAVA_MAJOR).contains(&candidate.major_version)
        })
        .max_by_key(|candidate| candidate.major_version)
        .cloned()
}

fn probe_java_home(home: &Path) -> Option<JavaInstallation> {
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

fn parse_java_major_version(output: &str) -> Option<u32> {
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

fn path_with_java_home(home: &Path) -> OsString {
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

fn executable_from_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(executable_name(name));
        if is_regular_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn java_home_from_executable(executable: &Path) -> Option<PathBuf> {
    let executable = canonical_path(executable);
    let bin = executable.parent()?;
    if bin.file_name() != Some(OsStr::new("bin")) {
        return None;
    }
    bin.parent().map(Path::to_path_buf)
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| canonical_path(&path))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn discover_environment_java_homes() -> Vec<PathBuf> {
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
fn discover_macos_java_homes() -> Vec<PathBuf> {
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
fn discover_linux_java_homes() -> Vec<PathBuf> {
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

fn scan_java_home_root(root: &Path, homes: &mut Vec<PathBuf>) {
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

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn gradle_wrapper(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("gradlew.bat")
    } else {
        root.join("gradlew")
    }
}

fn validate_gradle_wrapper(wrapper: &Path) -> Result<(), String> {
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

struct InitScript {
    _directory: TempDir,
    path: PathBuf,
    result_dir: PathBuf,
    classes_dir: PathBuf,
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
        def selectedSourceFiles = files(sourceSets.main.java.srcDirs).asFileTree.matching {
            include selectedSourcePath
        }
        if (selectedSourceFiles.isEmpty()) {
            throw new GradleException("Selected problem source was not found: ${selectedSourcePath}")
        }
        def isolatedSources = files(problemSourceFiles, selectedSourceFiles)
        def classesDirProperty = System.getProperty('leetcoderClassesDir')
        if (classesDirProperty == null || classesDirProperty.trim().isEmpty()) {
            throw new GradleException('leetcoderClassesDir was not provided')
        }
        def classesDir = project.file(classesDirProperty)
        def jarClasspath = configurations.testRuntimeClasspath.filter { file ->
            file.isFile() && file.name.toLowerCase().endsWith('.jar')
        }
        def compileTask = tasks.register('leetcoderProblemCompile', JavaCompile) {
            description = 'Compiles shared sources and the selected leetcoder problem only.'
            source isolatedSources
            destinationDirectory.set(classesDir)
            classpath = jarClasspath
            options.sourcepath = files(sourceSets.main.java.srcDirs)
            options.encoding = 'UTF-8'
            outputs.upToDateWhen { false }
        }
        tasks.register('leetcoderProblemTest', Test) {
            description = 'Runs one leetcoder problem class from the main source set.'
            group = 'verification'
            dependsOn compileTask
            testClassesDirs = files(classesDir)
            classpath = files(classesDir, sourceSets.main.resources.srcDirs) + jarClasspath
            useJUnitPlatform()
            testLogging.showStandardStreams = true
            def resultDir = System.getProperty('leetcoderResultDir')
            if (resultDir == null || resultDir.trim().isEmpty()) {
                throw new GradleException('leetcoderResultDir was not provided')
            }
            reports.junitXml.outputLocation = project.file(resultDir)
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

fn create_init_script() -> Result<InitScript, String> {
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
    let classes_dir = directory.path().join("classes");
    fs::create_dir(&result_dir).map_err(|error| {
        format!(
            "Unable to create temporary JUnit result directory '{}': {error}",
            result_dir.display()
        )
    })?;
    fs::create_dir(&classes_dir).map_err(|error| {
        format!(
            "Unable to create temporary Java classes directory '{}': {error}",
            classes_dir.display()
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
        fs::set_permissions(&classes_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Unable to secure temporary Java classes directory '{}': {error}",
                classes_dir.display()
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
        classes_dir,
    })
}

fn validate_fully_qualified_class_name(class_name: &str) -> Result<(), String> {
    let name = class_name.trim();
    if name.is_empty() {
        return Err("fullyQualifiedClassName must not be empty".to_string());
    }
    for segment in name.split('.') {
        if segment.is_empty() {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
        let mut characters = segment.chars();
        let first = characters.next().expect("non-empty segment");
        if !(first == '_' || first == '$' || first.is_ascii_alphabetic())
            || !characters.all(|character| {
                character == '_' || character == '$' || character.is_ascii_alphanumeric()
            })
        {
            return Err(format!("Invalid fully-qualified class name: {class_name}"));
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct ParsedReports {
    tests: Vec<ProblemTestCase>,
    duration_ms: Option<u64>,
}

fn build_problem_test_result(
    result_dir: &Path,
    exit_code: Option<i32>,
    process_success: bool,
    stdout: String,
    stderr: String,
    elapsed_ms: u64,
) -> ProblemTestResult {
    let report = parse_junit_reports(result_dir);
    let (parsed, report_error) = match report {
        Ok(parsed) => (parsed, None),
        Err(error) => (ParsedReports::default(), Some(error)),
    };

    let mut diagnostics = parse_compilation_diagnostics(&stdout);
    diagnostics.extend(parse_compilation_diagnostics(&stderr));
    deduplicate_diagnostics(&mut diagnostics);

    let report_failed = report_error.is_some();
    if let Some(error) = report_error {
        diagnostics.push(ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: None,
            line: None,
            column: None,
            message: error,
            source: Some("junit".to_string()),
            caret: None,
        });
    }

    let has_error_diagnostic = diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == ProblemDiagnosticSeverity::Error);
    if !process_success && !has_error_diagnostic {
        if let Some(message) = first_output_line(&stderr).or_else(|| first_output_line(&stdout)) {
            diagnostics.push(ProblemDiagnostic {
                severity: ProblemDiagnosticSeverity::Error,
                file: None,
                line: None,
                column: None,
                message,
                source: Some("runner".to_string()),
                caret: None,
            });
        }
    }

    let has_compilation_error = diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == ProblemDiagnosticSeverity::Error
            && !matches!(diagnostic.source.as_deref(), Some("runner") | Some("junit"))
    }) || looks_like_compilation_failure(&stdout)
        || looks_like_compilation_failure(&stderr);

    let summary = summarize_tests(&parsed.tests, parsed.duration_ms, elapsed_ms);
    let has_tests = !parsed.tests.is_empty();
    let no_tests = !has_tests && looks_like_no_tests(&stdout, &stderr);
    let phase = if has_tests {
        ProblemTestPhase::Tests
    } else if has_compilation_error {
        ProblemTestPhase::Compilation
    } else if report_failed {
        ProblemTestPhase::Runner
    } else if process_success || no_tests {
        ProblemTestPhase::NoTests
    } else {
        ProblemTestPhase::Runner
    };
    let success = phase == ProblemTestPhase::Tests
        && process_success
        && summary.failed == 0
        && summary.errors == 0;

    ProblemTestResult {
        success,
        phase,
        exit_code,
        summary,
        tests: parsed.tests,
        diagnostics,
        stdout,
        stderr,
    }
}

fn first_output_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn runner_failure_result(message: String, duration_ms: u64) -> ProblemTestResult {
    ProblemTestResult {
        success: false,
        phase: ProblemTestPhase::Runner,
        exit_code: None,
        summary: ProblemTestSummary {
            duration_ms,
            ..ProblemTestSummary::default()
        },
        tests: Vec::new(),
        diagnostics: vec![ProblemDiagnostic {
            severity: ProblemDiagnosticSeverity::Error,
            file: None,
            line: None,
            column: None,
            message: message.clone(),
            source: Some("runner".to_string()),
            caret: None,
        }],
        stdout: String::new(),
        stderr: message,
    }
}

fn summarize_tests(
    tests: &[ProblemTestCase],
    report_duration_ms: Option<u64>,
    elapsed_ms: u64,
) -> ProblemTestSummary {
    let mut summary = ProblemTestSummary {
        total: tests.len().min(u32::MAX as usize) as u32,
        ..ProblemTestSummary::default()
    };
    for test in tests {
        match test.status {
            ProblemTestStatus::Passed => summary.passed = summary.passed.saturating_add(1),
            ProblemTestStatus::Failed => summary.failed = summary.failed.saturating_add(1),
            ProblemTestStatus::Skipped => summary.skipped = summary.skipped.saturating_add(1),
            ProblemTestStatus::Error => summary.errors = summary.errors.saturating_add(1),
        }
    }
    summary.duration_ms = report_duration_ms
        .or_else(|| {
            let mut duration = 0u64;
            let mut found = false;
            for test in tests {
                if let Some(value) = test.duration_ms {
                    duration = duration.saturating_add(value);
                    found = true;
                }
            }
            found.then_some(duration)
        })
        .unwrap_or(elapsed_ms);
    summary
}

fn parse_junit_reports(result_dir: &Path) -> Result<ParsedReports, String> {
    if !result_dir.exists() {
        return Ok(ParsedReports::default());
    }
    let metadata = fs::symlink_metadata(result_dir).map_err(|error| {
        format!(
            "Unable to inspect JUnit result directory '{}': {error}",
            result_dir.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "JUnit result path is not a regular directory: {}",
            result_dir.display()
        ));
    }

    let mut files = Vec::new();
    collect_xml_files(result_dir, &mut files)?;
    let mut reports = ParsedReports::default();
    for file in files {
        let metadata = fs::symlink_metadata(&file).map_err(|error| {
            format!(
                "Unable to inspect JUnit report '{}': {error}",
                file.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.len() > MAX_JUNIT_XML_BYTES {
            return Err(format!(
                "JUnit report is larger than {} bytes: {}",
                MAX_JUNIT_XML_BYTES,
                file.display()
            ));
        }
        let xml = fs::read_to_string(&file).map_err(|error| {
            format!("Unable to read JUnit report '{}': {error}", file.display())
        })?;
        let parsed = parse_junit_xml(&xml).map_err(|error| {
            format!("Unable to parse JUnit report '{}': {error}", file.display())
        })?;
        reports.tests.extend(parsed.tests);
        if let Some(duration) = parsed.duration_ms {
            reports.duration_ms = Some(
                reports
                    .duration_ms
                    .unwrap_or_default()
                    .saturating_add(duration),
            );
        }
    }
    Ok(reports)
}

fn collect_xml_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| {
        format!(
            "Unable to list JUnit result directory '{}': {error}",
            directory.display()
        )
    })?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Unable to inspect JUnit result entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Unable to inspect JUnit result entry '{}': {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_xml_files(&path, files)?;
        } else if metadata.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xml"))
        {
            files.push(path);
        }
    }
    Ok(())
}

#[derive(Debug)]
struct ActiveTest {
    class_name: String,
    name: String,
    duration_ms: Option<u64>,
    message: Option<String>,
    details: String,
    status: ProblemTestStatus,
    source_file: Option<String>,
    source_line: Option<u32>,
    capturing_details: bool,
}

#[derive(Debug, Default)]
struct XmlFailure {
    message: Option<String>,
    details: String,
}

fn parse_junit_xml(xml: &str) -> Result<ParsedReports, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut reports = ParsedReports::default();
    let mut suite_classes: Vec<String> = Vec::new();
    let mut suite_depth = 0usize;
    let mut active_test: Option<ActiveTest> = None;
    let mut active_failure: Option<XmlFailure> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"testsuite" {
                    if suite_depth == 0 {
                        reports.duration_ms = attr_value(&element, b"time")
                            .and_then(|value| parse_duration_ms(&value));
                    }
                    suite_classes.push(
                        attr_value(&element, b"classname")
                            .or_else(|| attr_value(&element, b"name"))
                            .unwrap_or_default(),
                    );
                    suite_depth = suite_depth.saturating_add(1);
                } else if tag.as_slice() == b"testcase" {
                    active_test = Some(active_test_from_xml(&element, &suite_classes));
                } else if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = if tag.as_slice() == b"error" {
                            ProblemTestStatus::Error
                        } else {
                            ProblemTestStatus::Failed
                        };
                        test.capturing_details = true;
                        active_failure = Some(XmlFailure {
                            message: attr_value(&element, b"message"),
                            details: String::new(),
                        });
                    }
                } else if tag.as_slice() == b"skipped" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = ProblemTestStatus::Skipped;
                        test.message = attr_value(&element, b"message");
                        test.capturing_details = false;
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"testsuite" {
                    if suite_depth == 0 {
                        reports.duration_ms = attr_value(&element, b"time")
                            .and_then(|value| parse_duration_ms(&value));
                    }
                } else if tag.as_slice() == b"testcase" {
                    reports.tests.push(finish_active_test(active_test_from_xml(
                        &element,
                        &suite_classes,
                    )));
                } else if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = if tag.as_slice() == b"error" {
                            ProblemTestStatus::Error
                        } else {
                            ProblemTestStatus::Failed
                        };
                        test.message = attr_value(&element, b"message");
                    }
                } else if tag.as_slice() == b"skipped" {
                    if let Some(test) = active_test.as_mut() {
                        test.status = ProblemTestStatus::Skipped;
                        test.message = attr_value(&element, b"message");
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(failure) = active_failure.as_mut() {
                    let decoded = text
                        .decode()
                        .map_err(|error| format!("invalid JUnit text: {error}"))?;
                    failure.details.push_str(
                        &unescape(decoded.as_ref())
                            .map_err(|error| format!("invalid JUnit escape: {error}"))?,
                    );
                }
            }
            Ok(Event::CData(text)) => {
                if let Some(failure) = active_failure.as_mut() {
                    failure
                        .details
                        .push_str(&String::from_utf8_lossy(text.as_ref()));
                }
            }
            Ok(Event::End(element)) => {
                let tag = element.name().as_ref().to_vec();
                if tag.as_slice() == b"failure" || tag.as_slice() == b"error" {
                    if let (Some(test), Some(failure)) =
                        (active_test.as_mut(), active_failure.take())
                    {
                        test.message = failure.message;
                        test.details.push_str(&failure.details);
                        test.capturing_details = false;
                    }
                } else if tag.as_slice() == b"testcase" {
                    if let Some(test) = active_test.take() {
                        reports.tests.push(finish_active_test(test));
                    }
                } else if tag.as_slice() == b"testsuite" {
                    suite_depth = suite_depth.saturating_sub(1);
                    suite_classes.pop();
                }
            }
            Ok(
                Event::Comment(_)
                | Event::Decl(_)
                | Event::PI(_)
                | Event::DocType(_)
                | Event::GeneralRef(_),
            ) => {}
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(reports)
}

fn active_test_from_xml(element: &BytesStart<'_>, suite_classes: &[String]) -> ActiveTest {
    ActiveTest {
        class_name: attr_value(element, b"classname")
            .or_else(|| attr_value(element, b"class"))
            .or_else(|| suite_classes.last().cloned())
            .unwrap_or_default(),
        name: attr_value(element, b"name").unwrap_or_default(),
        duration_ms: attr_value(element, b"time").and_then(|value| parse_duration_ms(&value)),
        message: None,
        details: String::new(),
        status: ProblemTestStatus::Passed,
        source_file: attr_value(element, b"file"),
        source_line: attr_value(element, b"line").and_then(|line| line.parse().ok()),
        capturing_details: false,
    }
}

fn finish_active_test(mut test: ActiveTest) -> ProblemTestCase {
    let details = clean_text(&test.details);
    let comparison_text = format!(
        "{}\n{}",
        test.message.as_deref().unwrap_or_default(),
        details.as_deref().unwrap_or_default()
    );
    let (expected, actual) = extract_expected_actual(&comparison_text);
    if test.source_file.is_none() || test.source_line.is_none() {
        if let Some((file, line)) = extract_source_location(&comparison_text) {
            if test.source_file.is_none() {
                test.source_file = Some(file);
            }
            if test.source_line.is_none() {
                test.source_line = Some(line);
            }
        }
    }
    ProblemTestCase {
        class_name: test.class_name,
        name: test.name,
        status: test.status,
        duration_ms: test.duration_ms,
        message: clean_text(&test.message.unwrap_or_default()),
        details,
        expected,
        actual,
        source_file: test.source_file,
        source_line: test.source_line,
    }
}

fn attr_value(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .find(|attribute| attribute.key.as_ref() == name)
        .and_then(|attribute| {
            attribute
                .decoded_and_normalized_value(XmlVersion::Implicit1_0, element.decoder())
                .ok()
                .map(|value| value.into_owned())
        })
}

fn parse_duration_ms(value: &str) -> Option<u64> {
    let seconds = value.trim().parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }
    Some((seconds * 1000.0).round().min(u64::MAX as f64) as u64)
}

fn clean_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn extract_source_location(text: &str) -> Option<(String, u32)> {
    for line in text.lines().rev() {
        let Some(open) = line.rfind('(') else {
            continue;
        };
        let Some(close_offset) = line[open + 1..].find(')') else {
            continue;
        };
        let close = close_offset + open + 1;
        let frame = &line[open + 1..close];
        let Some((file, line_number)) = frame.rsplit_once(':') else {
            continue;
        };
        let Ok(line_number) = line_number.parse::<u32>() else {
            continue;
        };
        if file.is_empty() || line_number == 0 {
            continue;
        }
        let file_start = file
            .rfind('/')
            .or_else(|| file.rfind('\\'))
            .map(|index| index + 1)
            .unwrap_or(0);
        return Some((file[file_start..].to_string(), line_number));
    }
    None
}

fn extract_expected_actual(text: &str) -> (Option<String>, Option<String>) {
    let explicit_expected = extract_label_value(text, "expected:")
        .or_else(|| extract_label_value(text, "to be equal to:"));
    let explicit_actual = extract_label_value(text, "actual:");
    let was = extract_label_value(text, "but was:");
    if explicit_expected.is_some() {
        (explicit_expected, explicit_actual.or(was))
    } else if explicit_actual.is_some() && was.is_some() {
        (was, explicit_actual)
    } else {
        (explicit_expected, explicit_actual.or(was))
    }
}

fn extract_label_value(text: &str, label: &str) -> Option<String> {
    let lower_text = text.to_ascii_lowercase();
    let lower_label = label.to_ascii_lowercase();
    let position = lower_text.find(&lower_label)?;
    let mut value = text[position + label.len()..].trim_start();
    if value.is_empty() {
        return None;
    }
    if let Some(next) = value.strip_prefix(':') {
        value = next.trim_start();
    }
    if value.is_empty() {
        value = text[position + label.len()..]
            .lines()
            .skip(1)
            .map(str::trim)
            .find(|line| !line.is_empty())?;
    }
    let value = value.lines().next().unwrap_or(value).trim();
    if value.is_empty() {
        return None;
    }
    let value = if let Some(value) = value.strip_prefix('<') {
        if let Some(end) = value.find('>') {
            &value[..end]
        } else {
            value
        }
    } else {
        value
    };
    Some(value.trim().to_string())
}

fn parse_compilation_diagnostics(output: &str) -> Vec<ProblemDiagnostic> {
    let lines: Vec<&str> = output.lines().collect();
    let mut diagnostics = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some((severity, file, line_number, mut column, mut message)) =
            parse_diagnostic_header(line)
        else {
            continue;
        };
        let mut source = None;
        let mut caret = None;
        if let (Some(source_line), Some(caret_line)) = (lines.get(index + 1), lines.get(index + 2))
        {
            if caret_line.contains('^') {
                source = Some((*source_line).to_string());
                caret = Some((*caret_line).to_string());
                if column.is_none() {
                    column = caret_line.find('^').map(|position| position as u32 + 1);
                }
            }
        }
        if message.is_empty() {
            message = "compiler diagnostic".to_string();
        }
        diagnostics.push(ProblemDiagnostic {
            severity,
            file,
            line: line_number,
            column,
            message,
            source,
            caret,
        });
    }
    diagnostics
}

fn parse_diagnostic_header(
    line: &str,
) -> Option<(
    ProblemDiagnosticSeverity,
    Option<String>,
    Option<u32>,
    Option<u32>,
    String,
)> {
    let markers = [
        (": error:", ProblemDiagnosticSeverity::Error),
        (": warning:", ProblemDiagnosticSeverity::Warning),
        (": note:", ProblemDiagnosticSeverity::Info),
    ];
    for (marker, severity) in markers {
        if let Some(position) = line.find(marker) {
            let prefix = line[..position].trim();
            let message = line[position + marker.len()..].trim().to_string();
            let (file, line_number, column) = parse_diagnostic_location(prefix);
            return Some((severity, file, line_number, column, message));
        }
    }
    let trimmed = line.trim_start();
    for (prefix, severity) in [
        ("error:", ProblemDiagnosticSeverity::Error),
        ("warning:", ProblemDiagnosticSeverity::Warning),
        ("note:", ProblemDiagnosticSeverity::Info),
    ] {
        if let Some(message) = trimmed.strip_prefix(prefix) {
            return Some((severity, None, None, None, message.trim().to_string()));
        }
    }
    None
}

fn parse_diagnostic_location(prefix: &str) -> (Option<String>, Option<u32>, Option<u32>) {
    let Some((before_line, last)) = prefix.rsplit_once(':') else {
        return (None, None, None);
    };
    let Ok(last_number) = last.parse::<u32>() else {
        return (None, None, None);
    };
    if let Some((file, line)) = before_line.rsplit_once(':') {
        if let Ok(line_number) = line.parse::<u32>() {
            return (Some(file.to_string()), Some(line_number), Some(last_number));
        }
    }
    (Some(before_line.to_string()), Some(last_number), None)
}

fn deduplicate_diagnostics(diagnostics: &mut Vec<ProblemDiagnostic>) {
    let mut unique = Vec::with_capacity(diagnostics.len());
    for diagnostic in diagnostics.drain(..) {
        if !unique
            .iter()
            .any(|existing: &ProblemDiagnostic| existing == &diagnostic)
        {
            unique.push(diagnostic);
        }
    }
    *diagnostics = unique;
}

fn looks_like_compilation_failure(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    output.contains("compilation failed")
        || output.contains("failed to compile")
        || output.contains("compilation error")
        || output
            .lines()
            .any(|line| line.trim_start().starts_with("error:"))
}

fn looks_like_no_tests(stdout: &str, stderr: &str) -> bool {
    let output = format!("{}\n{}", stdout, stderr).to_ascii_lowercase();
    output.contains("no tests found")
        || output.contains("no matching tests")
        || output.contains("no tests executed")
        || output.contains("no tests were found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::io::Cursor;
    use std::sync::Mutex;

    const JUNIT_FIXTURE: &str = r#"
<testsuites>
  <testsuite name="Q1" tests="4" time="0.125">
    <testcase classname="sample.Q1" name="passes" time="0.001"/>
    <testcase classname="sample.Q1" name="fails" time="0.002">
      <failure message="expected: &lt;5&gt; but was: &lt;4&gt;"><![CDATA[
expected: <5>
 but was: <4>
 at sample.Q1.test(Q1.java:19)
]]></failure>
    </testcase>
    <testcase classname="sample.Q1" name="skips" time="0.003"><skipped message="not today"/></testcase>
    <testcase classname="sample.Q1" name="errors" time="0.004">
      <error message="boom"><![CDATA[at sample.Q1.test(Q1.java:27)]]></error>
    </testcase>
  </testsuite>
</testsuites>
"#;

    #[test]
    fn init_script_writes_junit_reports_to_each_run_directory() {
        let script = build_gradle_init_script();
        assert!(script.contains("leetcoderProblemTest"));
        assert!(script.contains("leetcoderProblemCompile"));
        assert!(script.contains("sourceSets.main.java.srcDirs"));
        assert!(script.contains("exclude 'shane/leetcode/problems/easy/**'"));
        assert!(script.contains("exclude 'shane/leetcode/problems/medium/**'"));
        assert!(script.contains("exclude 'shane/leetcode/problems/xhard/**'"));
        assert!(script.contains("selectedSourcePath"));
        assert!(script.contains("options.sourcepath"));
        assert!(script.contains("leetcoderClassesDir"));
        assert!(script.contains("sourceSets.main.resources.srcDirs"));
        assert!(script.contains("file.isFile() && file.name.toLowerCase().endsWith('.jar')"));
        assert!(script.contains("useJUnitPlatform()"));
        assert!(script.contains("testLogging.showStandardStreams = true"));
        assert!(script.contains("junitXml.outputLocation"));
        assert!(script.contains("outputs.upToDateWhen { false }"));
        assert!(script.contains("leetcoderResultDir"));
        assert!(script.contains(TEST_EVENT_MARKER));
        assert!(script.contains("beforeTest"));
        assert!(script.contains("afterTest"));
        assert!(script.contains("descriptor.composite"));
        assert!(script.contains("JsonOutput.toJson"));
    }

    #[test]
    fn progress_marker_is_parsed_into_a_live_test_case() {
        let marker = format!(
            "{TEST_EVENT_MARKER}{{\"kind\":\"finished\",\"className\":\"sample.Q1\",\"name\":\"fails\",\"displayName\":\"fails()\",\"status\":\"failed\",\"durationMs\":12,\"message\":\"boom\",\"details\":\"stack\"}}\n"
        );
        let parsed = parse_test_progress_marker(&marker).expect("progress marker");
        let test = progress_case_from_marker(&parsed, marker_status(&parsed));
        assert_eq!(test.class_name, "sample.Q1");
        assert_eq!(test.display_name.as_deref(), Some("fails()"));
        assert_eq!(test.status, ProblemTestProgressStatus::Failed);
        assert_eq!(test.duration_ms, Some(12));
        assert_eq!(test.details.as_deref(), Some("stack"));
    }

    #[test]
    fn stream_reader_filters_markers_but_emits_logs_and_test_events() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let event_sink: ProblemTestEventSink = {
            let events = events.clone();
            Arc::new(move |event| events.lock().unwrap().push(event))
        };
        let output = format!(
            "before\n{TEST_EVENT_MARKER}{{\"kind\":\"started\",\"className\":\"sample.Q1\",\"name\":\"passes\",\"status\":\"running\"}}\n{TEST_EVENT_MARKER}{{\"kind\":\"finished\",\"className\":\"sample.Q1\",\"name\":\"passes\",\"status\":\"passed\",\"durationMs\":3}}\nafter\n"
        );
        let captured = read_stream(
            Cursor::new(output),
            ProblemTestOutputStream::Stdout,
            Some(event_sink),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(captured, "before\nafter\n");
        let events = events.lock().unwrap();
        assert!(matches!(events[0], ProblemTestEvent::Log { .. }));
        if let ProblemTestEvent::Log { text, .. } = &events[0] {
            assert_eq!(text, "before\n");
        }
        assert!(matches!(
            events[1],
            ProblemTestEvent::Phase {
                phase: ProblemTestProgressPhase::RunningTests
            }
        ));
        assert!(matches!(events[2], ProblemTestEvent::TestStarted { .. }));
        assert!(matches!(events[3], ProblemTestEvent::TestFinished { .. }));
        assert!(matches!(events[4], ProblemTestEvent::Log { .. }));
    }

    #[test]
    fn progress_events_serialize_as_camel_case_tagged_messages() {
        let event = ProblemTestEvent::Log {
            stream: ProblemTestOutputStream::Stderr,
            text: "warning".to_string(),
        };
        let value = serde_json::to_value(event).expect("event serializes");
        assert_eq!(value["kind"], Value::String("log".to_string()));
        assert_eq!(value["stream"], Value::String("stderr".to_string()));
        assert_eq!(value["text"], Value::String("warning".to_string()));
    }

    #[test]
    fn java_version_parser_supports_modern_and_legacy_output() {
        assert_eq!(
            parse_java_major_version("openjdk version \"17.0.18\" 2026-01-20\n"),
            Some(17)
        );
        assert_eq!(
            parse_java_major_version("java version \"1.8.0_382\"\n"),
            Some(8)
        );
        assert_eq!(
            parse_java_major_version("openjdk version \"25\" 2026-01-20\n"),
            Some(25)
        );
        assert_eq!(parse_java_major_version("not a java version"), None);
    }

    #[test]
    fn java_selection_prefers_java_17_and_rejects_newer_jdks() {
        let candidates = vec![
            JavaInstallation {
                home: PathBuf::from("/jdk-25"),
                major_version: 25,
            },
            JavaInstallation {
                home: PathBuf::from("/jdk-11"),
                major_version: 11,
            },
            JavaInstallation {
                home: PathBuf::from("/jdk-17"),
                major_version: 17,
            },
            JavaInstallation {
                home: PathBuf::from("/jdk-8"),
                major_version: 8,
            },
        ];
        assert_eq!(
            select_compatible_java(&candidates),
            Some(JavaInstallation {
                home: PathBuf::from("/jdk-17"),
                major_version: 17,
            })
        );
        assert!(select_compatible_java(&candidates[..1]).is_none());
    }

    #[test]
    fn java_selection_falls_back_to_java_11() {
        let candidates = vec![
            JavaInstallation {
                home: PathBuf::from("/jdk-25"),
                major_version: 25,
            },
            JavaInstallation {
                home: PathBuf::from("/jdk-11"),
                major_version: 11,
            },
        ];

        assert_eq!(
            select_compatible_java(&candidates),
            Some(JavaInstallation {
                home: PathBuf::from("/jdk-11"),
                major_version: 11,
            })
        );
    }

    #[test]
    fn class_name_validation_rejects_command_like_input() {
        assert!(validate_fully_qualified_class_name("shane.leetcode.Q1").is_ok());
        assert!(validate_fully_qualified_class_name("shane.leetcode.Q$1").is_ok());
        assert!(validate_fully_qualified_class_name("shane.leetcode.Q1 --info").is_err());
        assert!(validate_fully_qualified_class_name("../Q1").is_err());
        assert!(validate_fully_qualified_class_name("").is_err());
    }

    #[test]
    fn temporary_script_and_results_are_private_unique_and_removed_on_drop() {
        let first = create_init_script().expect("first init script");
        let second = create_init_script().expect("second init script");
        assert_ne!(first.path, second.path);
        assert_ne!(first.result_dir, second.result_dir);
        assert!(first.path.is_file());
        assert!(first.result_dir.is_dir());
        assert!(first.classes_dir.is_dir());
        assert!(second.path.is_file());
        assert!(second.result_dir.is_dir());
        assert!(second.classes_dir.is_dir());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(first.path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&first.result_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&first.classes_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        let first_path = first.path.clone();
        let first_results = first.result_dir.clone();
        let first_classes = first.classes_dir.clone();
        drop(first);
        assert!(!first_path.exists());
        assert!(!first_results.exists());
        assert!(!first_classes.exists());
        assert!(second.path.exists());
        drop(second);
    }

    #[test]
    fn parses_pass_fail_skip_and_error_with_comparison_and_source_location() {
        let parsed = parse_junit_xml(JUNIT_FIXTURE).expect("fixture parses");
        assert_eq!(parsed.duration_ms, Some(125));
        assert_eq!(parsed.tests.len(), 4);
        assert_eq!(parsed.tests[0].status, ProblemTestStatus::Passed);
        assert_eq!(parsed.tests[1].status, ProblemTestStatus::Failed);
        assert_eq!(parsed.tests[1].expected.as_deref(), Some("5"));
        assert_eq!(parsed.tests[1].actual.as_deref(), Some("4"));
        assert_eq!(parsed.tests[1].source_file.as_deref(), Some("Q1.java"));
        assert_eq!(parsed.tests[1].source_line, Some(19));
        assert_eq!(parsed.tests[2].status, ProblemTestStatus::Skipped);
        assert_eq!(parsed.tests[2].message.as_deref(), Some("not today"));
        assert_eq!(parsed.tests[3].status, ProblemTestStatus::Error);
        assert_eq!(parsed.tests[3].source_line, Some(27));

        let summary = summarize_tests(&parsed.tests, parsed.duration_ms, 1000);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.passed, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.errors, 1);
        assert_eq!(summary.duration_ms, 125);
    }

    #[test]
    fn parses_compilation_diagnostics_with_source_and_caret() {
        let output = "/tmp/Q1.java:12: error: cannot find symbol\n    value++\n         ^\n/tmp/Q1.java:21: warning: unused variable\n    int unused = 1;\n                  ^\n";
        let diagnostics = parse_compilation_diagnostics(output);
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].severity, ProblemDiagnosticSeverity::Error);
        assert_eq!(diagnostics[0].file.as_deref(), Some("/tmp/Q1.java"));
        assert_eq!(diagnostics[0].line, Some(12));
        assert_eq!(diagnostics[0].column, Some(10));
        assert_eq!(diagnostics[0].source.as_deref(), Some("    value++"));
        assert_eq!(diagnostics[0].caret.as_deref(), Some("         ^"));
        assert_eq!(diagnostics[1].severity, ProblemDiagnosticSeverity::Warning);
        assert_eq!(diagnostics[1].line, Some(21));
    }

    #[test]
    fn distinguishes_compilation_no_tests_and_runner_phases() {
        let compilation = build_problem_test_result(
            Path::new("/path/that/does/not/exist"),
            Some(1),
            false,
            "".to_string(),
            "/tmp/Q1.java:12: error: ';' expected\n    foo\n       ^\n".to_string(),
            42,
        );
        assert_eq!(compilation.phase, ProblemTestPhase::Compilation);
        assert_eq!(compilation.diagnostics.len(), 1);
        assert!(!compilation.success);

        let no_tests = build_problem_test_result(
            Path::new("/path/that/does/not/exist"),
            Some(0),
            true,
            "BUILD SUCCESSFUL\n".to_string(),
            String::new(),
            9,
        );
        assert_eq!(no_tests.phase, ProblemTestPhase::NoTests);
        assert!(!no_tests.success);
        assert_eq!(no_tests.summary.total, 0);

        let runner = build_problem_test_result(
            Path::new("/path/that/does/not/exist"),
            Some(1),
            false,
            String::new(),
            "Gradle daemon disappeared unexpectedly".to_string(),
            9,
        );
        assert_eq!(runner.phase, ProblemTestPhase::Runner);
        assert!(!runner.success);
    }

    #[test]
    fn runner_output_keeps_a_useful_diagnostic_when_no_report_exists() {
        let result = build_problem_test_result(
            Path::new("/path/that/does/not/exist"),
            Some(1),
            false,
            String::new(),
            "Unsupported class file major version 69\nmore details\n".to_string(),
            9,
        );
        assert_eq!(result.phase, ProblemTestPhase::Runner);
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(
            result.diagnostics[0].message,
            "Unsupported class file major version 69"
        );
        assert_eq!(result.diagnostics[0].source.as_deref(), Some("runner"));
    }

    #[test]
    fn serializes_the_stable_result_shape() {
        let result = build_problem_test_result(
            Path::new("/path/that/does/not/exist"),
            Some(0),
            true,
            "out".to_string(),
            "err".to_string(),
            9,
        );
        let value: Value = serde_json::to_value(result).expect("result serializes");
        assert_eq!(value["phase"], Value::String("noTests".to_string()));
        assert!(value["summary"]["durationMs"].is_number());
        assert!(value["tests"].is_array());
        assert!(value["diagnostics"].is_array());
        assert!(value.get("stdout").is_some());
        assert!(value.get("stderr").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn gradle_wrapper_must_be_executable_and_not_a_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().expect("tempdir");
        let wrapper = directory.path().join("gradlew");
        fs::write(&wrapper, "#!/bin/sh\nexit 0\n").expect("wrapper");
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(validate_gradle_wrapper(&wrapper)
            .unwrap_err()
            .contains("not executable"));

        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_gradle_wrapper(&wrapper).is_ok());

        let link = directory.path().join("gradlew-link");
        symlink(&wrapper, &link).unwrap();
        assert!(validate_gradle_wrapper(&link)
            .unwrap_err()
            .contains("symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn test_run_requires_the_expected_ps_repository_structure() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let wrapper = directory.path().join("gradlew");
        fs::write(&wrapper, "#!/bin/sh\nexit 0\n").expect("wrapper");
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let result = run_problem_test(RunProblemTestArgs {
            project_root: directory.path().to_string_lossy().into_owned(),
            fully_qualified_class_name: "shane.leetcode.problems.easy.Q1".to_string(),
        });
        assert!(result.unwrap_err().contains("valid ps repository"));
    }
}

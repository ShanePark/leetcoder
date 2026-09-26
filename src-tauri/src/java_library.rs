use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tempfile::{Builder, TempDir};

const CLASSPATH_MARKER: &str = "LEETCODER_PS_CLASSPATH_V1:";
const METADATA_SCHEMA: &str = "ps-metadata-v1";
const GRADLE_TASK_TIMEOUT: Duration = Duration::from_secs(120);
const JAVA_HELPER_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_millis(200);
const MAX_CAPTURED_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_CLASSPATH_ENTRIES: usize = 4096;
const MAX_FINGERPRINT_FILES: usize = 200_000;
const MAX_FINGERPRINT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const INIT_SCRIPT_NAME: &str = "leetcoder-ps-classpath.gradle";
const JAVA_HELPER_NAME: &str = "LeetcoderPsMetadata.java";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsLibraryMetadata {
    pub(crate) fingerprint: String,
    pub(crate) methods: Vec<PsMethod>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsMethod {
    pub(crate) name: String,
    pub(crate) return_type: String,
    pub(crate) parameters: Vec<PsParameter>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PsParameter {
    pub(crate) name: Option<String>,
    pub(crate) type_name: String,
}

#[derive(Debug, Deserialize)]
struct ClasspathEntry {
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperResult {
    methods: Vec<PsMethod>,
}

#[derive(Default)]
struct OutputCapture {
    bytes: Vec<u8>,
}

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

fn gradle_wrapper(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("gradlew.bat")
    } else {
        root.join("gradlew")
    }
}

fn validate_gradle_wrapper(wrapper: &Path) -> Result<(), String> {
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

fn resolve_main_compile_classpath(
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

fn parse_classpath_output(stdout: &[u8]) -> Result<Vec<PathBuf>, String> {
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

fn classpath_fingerprint(root: &Path, classpath: &[PathBuf]) -> Result<String, String> {
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
struct StableHash(u64);

impl StableHash {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

fn inspect_classpath(java_home: &Path, classpath: &[PathBuf]) -> Result<Vec<PsMethod>, String> {
    let temp = create_private_temp_dir("leetcoder-ps-inspect")?;
    let source = temp.path().join(JAVA_HELPER_NAME);
    write_private_file(&source, JAVA_HELPER.as_bytes(), "Java metadata helper")?;
    let java = java_home.join("bin").join(java_executable_name());
    if !java.is_file() {
        return Err(format!(
            "The selected JDK Java executable was not found: {}",
            java.display()
        ));
    }
    let classpath = std::env::join_paths(classpath).map_err(|error| {
        format!("Unable to construct the Java classpath for Ps inspection: {error}")
    })?;

    let mut command = Command::new(&java);
    command
        .arg("--class-path")
        .arg(classpath)
        .arg(&source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_bounded(&mut command, JAVA_HELPER_TIMEOUT, "Ps metadata inspection")?;
    if !output.success {
        return Err(format_process_failure(
            "Unable to inspect public Ps methods",
            &output,
        ));
    }
    let result: HelperResult = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "The Java metadata helper returned invalid Ps metadata: {error}. Output: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })?;
    Ok(result.methods)
}

fn create_private_temp_dir(prefix: &str) -> Result<TempDir, String> {
    let directory = Builder::new()
        .prefix(prefix)
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| format!("Unable to create private Java metadata workspace: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "Unable to secure Java metadata workspace '{}': {error}",
                    directory.path().display()
                )
            },
        )?;
    }
    Ok(directory)
}

fn write_private_file(path: &Path, contents: &[u8], description: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Unable to create {description} '{}': {error}",
                path.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "Unable to secure {description} '{}': {error}",
                path.display()
            )
        })?;
    }
    file.write_all(contents)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to write {description}: {error}"))
}

fn run_bounded(
    command: &mut Command,
    timeout: Duration,
    description: &str,
) -> Result<BoundedOutput, String> {
    isolate_process_session(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {description}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .map(|stream| spawn_bounded_reader(stream));
    let stderr = child
        .stderr
        .take()
        .map(|stream| spawn_bounded_reader(stream));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                terminate_process_tree(&mut child);
                return Err(format!("Unable to wait for {description}: {error}"));
            }
        }
        if started.elapsed() >= timeout {
            terminate_process_tree(&mut child);
            let output = collect_output(stdout, stderr);
            return Err(format!(
                "{description} exceeded the {} second timeout.{}",
                timeout.as_secs(),
                output_diagnostic_suffix(&output)
            ));
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    };
    let output = collect_output(stdout, stderr);
    Ok(BoundedOutput {
        success: status.success(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn spawn_bounded_reader<R: Read + Send + 'static>(reader: R) -> JoinHandle<OutputCapture> {
    thread::spawn(move || {
        let mut reader = reader;
        let mut capture = OutputCapture::default();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let remaining = MAX_CAPTURED_OUTPUT.saturating_sub(capture.bytes.len());
                    capture
                        .bytes
                        .extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
        capture
    })
}

struct BoundedOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn collect_output(
    stdout: Option<JoinHandle<OutputCapture>>,
    stderr: Option<JoinHandle<OutputCapture>>,
) -> BoundedOutput {
    BoundedOutput {
        success: false,
        stdout: join_reader(stdout),
        stderr: join_reader(stderr),
    }
}

fn join_reader(reader: Option<JoinHandle<OutputCapture>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .map(|capture| capture.bytes)
        .unwrap_or_default()
}

fn format_process_failure(message: &str, output: &BoundedOutput) -> String {
    let detail = first_output_line(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| first_output_line(&String::from_utf8_lossy(&output.stdout)));
    match detail {
        Some(detail) => format!("{message}: {detail}"),
        None => message.to_string(),
    }
}

fn output_diagnostic_suffix(output: &BoundedOutput) -> String {
    first_output_line(&String::from_utf8_lossy(&output.stderr))
        .or_else(|| first_output_line(&String::from_utf8_lossy(&output.stdout)))
        .map(|line| format!(" Output: {line}"))
        .unwrap_or_default()
}

fn first_output_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(500).collect())
}

fn isolate_process_session(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-process_group, libc::SIGTERM);
        }
        let deadline = Instant::now() + PROCESS_TERMINATION_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
        let _ = child.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn java_executable_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

const GRADLE_INIT_SCRIPT: &str = r#"
import groovy.json.JsonOutput

allprojects {
    plugins.withId('java') {
        if (project == rootProject) {
            tasks.register('leetcoderPrintMainCompileClasspath') {
                doLast {
                    def entries = sourceSets.main.compileClasspath.files.collect { file ->
                        if (!file.exists()) {
                            throw new GradleException("Compile classpath entry does not exist: ${file}")
                        }
                        [path: file.canonicalPath]
                    }
                    println('LEETCODER_PS_CLASSPATH_V1:' + JsonOutput.toJson(entries))
                }
            }
        }
    }
}
"#;

const JAVA_HELPER: &str = r#"
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

public class LeetcoderPsMetadata {
    private static final String CLASS_NAME = "io.github.shanepark.Ps";

    public static void main(String[] args) throws Exception {
        List<URL> urls = Arrays.stream(System.getProperty("java.class.path", "").split(
                java.util.regex.Pattern.quote(System.getProperty("path.separator"))))
            .filter(value -> !value.isEmpty())
            .map(Paths::get)
            .map(LeetcoderPsMetadata::toUrl)
            .collect(Collectors.toList());

        List<MethodMetadata> methods = new ArrayList<>();
        try (URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[0]),
                ClassLoader.getPlatformClassLoader())) {
            try {
                Class<?> type = Class.forName(CLASS_NAME, false, loader);
                for (Method method : type.getMethods()) {
                    int modifiers = method.getModifiers();
                    if (!Modifier.isPublic(modifiers) || !Modifier.isStatic(modifiers)
                            || method.isBridge() || method.isSynthetic()) {
                        continue;
                    }
                    java.lang.reflect.Type[] genericTypes = method.getGenericParameterTypes();
                    java.lang.reflect.Parameter[] reflectedParameters = method.getParameters();
                    List<ParameterMetadata> parameters = new ArrayList<>();
                    for (int index = 0; index < genericTypes.length; index++) {
                        String typeName = genericTypes[index].getTypeName();
                        if (method.isVarArgs() && index == genericTypes.length - 1
                                && typeName.endsWith("[]")) {
                            typeName = typeName.substring(0, typeName.length() - 2) + "...";
                        }
                        java.lang.reflect.Parameter parameter = reflectedParameters[index];
                        parameters.add(new ParameterMetadata(
                            parameter.isNamePresent() ? parameter.getName() : null,
                            typeName));
                    }
                    methods.add(new MethodMetadata(method.getName(),
                            method.getGenericReturnType().getTypeName(), parameters));
                }
            } catch (ClassNotFoundException absent) {
                // An absent library is a normal result for projects without the dependency.
            }
        }
        methods.sort(Comparator.comparing(MethodMetadata::sortKey));
        System.out.println("{\"methods\":[" + methods.stream().map(MethodMetadata::toJson)
                    .collect(Collectors.joining(",")) + "]}");
    }

    private static URL toUrl(Path path) {
        try {
            return path.toUri().toURL();
        } catch (Exception exception) {
            throw new IllegalArgumentException("Invalid classpath entry: " + path, exception);
        }
    }

    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (char character : value.toCharArray()) {
            switch (character) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20) result.append(String.format("\\u%04x", (int) character));
                    else result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private static class MethodMetadata {
        private final String name;
        private final String returnType;
        private final List<ParameterMetadata> parameters;
        MethodMetadata(String name, String returnType, List<ParameterMetadata> parameters) {
            this.name = name; this.returnType = returnType; this.parameters = parameters;
        }
        String sortKey() {
            return name + parameters.stream().map(parameter -> parameter.typeName)
                    .collect(Collectors.joining(";", "(", ")")) + returnType;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"returnType\":" + json(returnType)
                    + ",\"parameters\":[" + parameters.stream()
                        .map(ParameterMetadata::toJson).collect(Collectors.joining(",")) + "]}";
        }
    }

    private static class ParameterMetadata {
        private final String name;
        private final String typeName;
        ParameterMetadata(String name, String typeName) {
            this.name = name; this.typeName = typeName;
        }
        String toJson() {
            return "{\"name\":" + json(name) + ",\"typeName\":" + json(typeName) + "}";
        }
    }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    use crate::runner::discover_compatible_java;

    const PS_CLASS_RESOURCE: &str = "io/github/shanepark/Ps.class";

    #[test]
    fn classpath_fingerprint_tracks_jar_and_inherited_class_content() {
        let workspace = tempfile::tempdir().expect("workspace");
        let jar = workspace.path().join("dependency with spaces.jar");
        fs::write(&jar, b"version one").expect("write jar");
        let jar_path = fs::canonicalize(&jar).expect("canonical jar");
        let root = workspace.path();
        let first = classpath_fingerprint(root, std::slice::from_ref(&jar_path))
            .expect("first fingerprint");
        fs::write(&jar, b"version two").expect("replace jar content");
        let second = classpath_fingerprint(root, std::slice::from_ref(&jar_path))
            .expect("second fingerprint");
        assert_ne!(first, second);

        let classes = workspace.path().join("classes");
        let ps_class = classes.join(PS_CLASS_RESOURCE);
        let base_class = classes.join("io/github/shanepark/Base.class");
        fs::create_dir_all(ps_class.parent().expect("Ps parent")).expect("Ps directory");
        fs::write(&ps_class, b"Ps bytecode v1").expect("write Ps class");
        fs::write(&base_class, b"Base bytecode v1").expect("write Base class");
        let first = classpath_fingerprint(root, std::slice::from_ref(&classes))
            .expect("directory fingerprint");
        fs::write(&classes.join("resource.txt"), b"not a class").expect("write resource");
        let unchanged = classpath_fingerprint(root, std::slice::from_ref(&classes))
            .expect("resource change fingerprint");
        assert_eq!(first, unchanged);
        fs::write(&base_class, b"Base bytecode v2").expect("replace Base class");
        let changed = classpath_fingerprint(root, std::slice::from_ref(&classes))
            .expect("changed inherited class fingerprint");
        assert_ne!(first, changed);
        fs::write(&ps_class, b"Ps bytecode v2").expect("replace Ps class");
        let changed_ps = classpath_fingerprint(root, std::slice::from_ref(&classes))
            .expect("changed Ps fingerprint");
        assert_ne!(changed, changed_ps);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&classes, classes.join("cycle"))
                .expect("create directory loop");
            classpath_fingerprint(root, std::slice::from_ref(&classes))
                .expect("directory symlink loop is bounded");
        }
    }

    #[test]
    fn parses_gradle_classpath_output_with_paths_containing_spaces() {
        let workspace = tempfile::tempdir().expect("workspace");
        let path = workspace.path().join("gradle cache/dependency.jar");
        fs::create_dir_all(path.parent().expect("jar parent")).expect("jar directory");
        fs::write(&path, b"dependency").expect("jar file");
        let path = fs::canonicalize(path).expect("canonical jar");
        let output = format!(
            "Gradle startup output\n{CLASSPATH_MARKER}[{{\"path\":{}}}]\n",
            serde_json::to_string(&path).expect("path json")
        );
        let parsed = parse_classpath_output(output.as_bytes()).expect("classpath output");
        assert_eq!(parsed, vec![path]);
    }

    #[test]
    fn gradle_script_resolves_only_the_main_compile_classpath() {
        assert!(GRADLE_INIT_SCRIPT.contains("sourceSets.main.compileClasspath.files"));
        assert!(GRADLE_INIT_SCRIPT.contains("project == rootProject"));
        assert!(!GRADLE_INIT_SCRIPT.contains("testRuntimeClasspath"));
    }

    #[test]
    fn reflects_current_jar_signatures_without_initializing_classes() {
        let java = discover_compatible_java().expect("compatible JDK");
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace
            .path()
            .join("src with spaces/io/github/shanepark/Ps.java");
        let dependent = workspace
            .path()
            .join("src with spaces/io/github/shanepark/Dependency.java");
        let base = workspace
            .path()
            .join("src with spaces/io/github/shanepark/Base.java");
        fs::create_dir_all(source.parent().expect("Ps package")).expect("source directory");
        fs::write(
            &dependent,
            r#"package io.github.shanepark;
public class Dependency {
    static { if (Boolean.parseBoolean("true")) throw new AssertionError("Dependency initialized"); }
}"#,
        )
        .expect("dependency source");
        fs::write(
            &base,
            r#"package io.github.shanepark;
public class Base {
    public static String inherited(String... values) { return ""; }
}"#,
        )
        .expect("base source");

        let jar = workspace.path().join("library with spaces.jar");
        let classes = workspace.path().join("compiled classes");
        write_ps_fixture(
            &java.home,
            &source,
            &classes,
            &jar,
            &format!(
                r#"package io.github.shanepark;
public class Ps extends Base {{
    static {{ if (Boolean.parseBoolean("true")) throw new AssertionError("Ps initialized"); }}
    public static java.util.List<java.lang.String> entries(String input) {{ return null; }}
    public static int[][] entries(int[][] input) {{ return input; }}
    public static String[] names(Dependency dependency, String... values) {{ return values; }}
    private static void hidden() {{ }}
    public void instanceMethod() {{ }}
}}"#,
            ),
        );
        let methods =
            inspect_classpath(&java.home, std::slice::from_ref(&jar)).expect("first jar metadata");
        assert_eq!(methods.len(), 4, "private and instance methods are omitted");
        assert!(methods.iter().any(|method| method.name == "inherited"));
        assert!(methods.iter().any(|method| {
            method.name == "entries"
                && method.return_type == "int[][]"
                && method.parameters[0].type_name == "int[][]"
        }));
        assert!(methods.iter().any(|method| {
            method.name == "entries"
                && method.return_type == "java.util.List<java.lang.String>"
                && method.parameters[0].type_name == "java.lang.String"
                && method.parameters[0].name.as_deref() == Some("input")
        }));
        assert!(methods.iter().any(|method| {
            method.name == "names"
                && method.parameters[0].type_name == "io.github.shanepark.Dependency"
                && method.parameters[1].type_name == "java.lang.String..."
        }));

        run_helper(&java.home, std::slice::from_ref(&jar)).expect("helper json");

        let first_fingerprint = classpath_fingerprint(workspace.path(), std::slice::from_ref(&jar))
            .expect("first fingerprint");
        write_ps_fixture(
            &java.home,
            &source,
            &classes,
            &jar,
            r#"package io.github.shanepark;
public class Ps {
    public static long added(String input, int index) { return 0L; }
}"#,
        );
        let updated_methods = inspect_classpath(&java.home, std::slice::from_ref(&jar))
            .expect("updated jar metadata");
        assert_eq!(updated_methods.len(), 1);
        assert_eq!(updated_methods[0].name, "added");
        assert_eq!(updated_methods[0].parameters.len(), 2);
        let second_fingerprint =
            classpath_fingerprint(workspace.path(), std::slice::from_ref(&jar))
                .expect("second fingerprint");
        assert_ne!(first_fingerprint, second_fingerprint);
    }

    #[test]
    fn absence_of_ps_returns_empty_metadata() {
        let java = discover_compatible_java().expect("compatible JDK");
        let workspace = tempfile::tempdir().expect("workspace");
        let classes = workspace.path().join("classes");
        fs::create_dir(&classes).expect("classes dir");
        let methods = inspect_classpath(&java.home, std::slice::from_ref(&classes))
            .expect("missing Ps metadata");
        assert!(methods.is_empty());
    }

    fn write_ps_fixture(
        java_home: &Path,
        source: &Path,
        classes: &Path,
        jar: &Path,
        source_text: &str,
    ) {
        fs::write(source, source_text).expect("write Ps source");
        let dependency = source
            .parent()
            .expect("Ps source parent")
            .join("Dependency.java");
        let base = source.parent().expect("Ps source parent").join("Base.java");
        let javac = java_home.join("bin").join(executable_name("javac"));
        let mut compile = Command::new(javac);
        compile
            .arg("-parameters")
            .arg("-d")
            .arg(classes)
            .arg(source);
        if dependency.is_file() {
            compile.arg(dependency);
        }
        if base.is_file() {
            compile.arg(base);
        }
        run_test_command(&mut compile, "compile test Ps library");
        let jar_tool = java_home.join("bin").join(executable_name("jar"));
        let mut package = Command::new(jar_tool);
        package.arg("cf").arg(jar).arg("-C").arg(classes).arg(".");
        run_test_command(&mut package, "package test Ps jar");
    }

    fn run_helper(java_home: &Path, classpath: &[PathBuf]) -> Result<HelperResult, String> {
        let workspace = create_private_temp_dir("leetcoder-ps-helper-test")?;
        let source = workspace.path().join(JAVA_HELPER_NAME);
        write_private_file(&source, JAVA_HELPER.as_bytes(), "Java metadata helper")?;
        let classpath = std::env::join_paths(classpath)
            .map_err(|error| format!("Unable to construct helper classpath: {error}"))?;
        let java = java_home.join("bin").join(executable_name("java"));
        let mut command = Command::new(java);
        command
            .arg("--class-path")
            .arg(classpath)
            .arg(source)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = run_bounded(&mut command, JAVA_HELPER_TIMEOUT, "test metadata helper")?;
        if !output.success {
            return Err(format_process_failure(
                "Test metadata helper failed",
                &output,
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Test metadata JSON was invalid: {error}"))
    }

    fn run_test_command(command: &mut Command, description: &str) {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let output = run_bounded(command, Duration::from_secs(30), description)
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(
            output.success,
            "{}",
            format_process_failure(description, &output)
        );
    }

    fn executable_name(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }
}

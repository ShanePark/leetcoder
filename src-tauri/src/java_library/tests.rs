use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{classpath::*, fingerprint::*, helpers::*, inspection::*, process::*, type_members::*};
use crate::runner::discover_compatible_java;

const PS_CLASS_RESOURCE: &str = "io/github/shanepark/Ps.class";

#[test]
fn validates_bounded_type_batches_and_deduplicates_in_order() {
    assert_eq!(
        validate_type_names(vec![
            "java.util.Stack".to_string(),
            "example.Outer$Nested".to_string(),
            "java.util.Stack".to_string(),
        ])
        .expect("valid names"),
        ["java.util.Stack", "example.Outer$Nested"]
    );
    assert!(validate_type_names(vec!["int".to_string()]).is_err());
    assert!(validate_type_names(vec!["java.lang.String[]".to_string()]).is_err());
    assert!(validate_type_names(vec!["java.lang.String);System.exit(0)".to_string()]).is_err());
    assert!(validate_type_names(vec!["x".repeat(MAX_TYPE_NAME_BYTES + 1)]).is_err());
    assert!(validate_type_names(
        (0..=MAX_REQUESTED_TYPES)
            .map(|index| format!("example.Type{index}"))
            .collect()
    )
    .is_err());
}

#[test]
fn project_classpath_revalidates_after_success_and_failure_ttls() {
    let now = Instant::now();
    let fresh_success = CachedProjectClasspath {
        root: PathBuf::from("/project"),
        java_identity: "jdk".to_string(),
        config_fingerprint: "config".to_string(),
        checked_at: now,
        result: Ok((Vec::new(), "classpath".to_string())),
    };
    let stale_success = CachedProjectClasspath {
        checked_at: now - PROJECT_CLASSPATH_REVALIDATION,
        ..fresh_success.clone()
    };
    let fresh_failure = CachedProjectClasspath {
        checked_at: now,
        result: Err("unavailable".to_string()),
        ..fresh_success.clone()
    };
    let stale_failure = CachedProjectClasspath {
        checked_at: now - CLASSPATH_FAILURE_RETRY,
        ..fresh_failure.clone()
    };
    assert!(!project_classpath_needs_refresh(&fresh_success, now));
    assert!(project_classpath_needs_refresh(&stale_success, now));
    assert!(!project_classpath_needs_refresh(&fresh_failure, now));
    assert!(project_classpath_needs_refresh(&stale_failure, now));
}

#[test]
fn project_config_fingerprint_tracks_all_gradle_version_catalogs() {
    let project = tempfile::tempdir().expect("project");
    let catalogs = project.path().join("gradle");
    fs::create_dir_all(&catalogs).expect("Gradle catalog directory");
    let first_catalog = catalogs.join("libs.versions.toml");
    let second_catalog = catalogs.join("test.versions.toml");
    fs::write(&first_catalog, "[versions]\nfirst = '1'\n").expect("first catalog");
    let first = project_config_fingerprint(project.path()).expect("first config signature");
    fs::write(&second_catalog, "[versions]\nsecond = '1'\n").expect("second catalog");
    let second = project_config_fingerprint(project.path()).expect("second config signature");
    assert_ne!(first, second);
}

#[test]
fn reflects_jdk_stack_methods_without_gradle_and_reuses_cached_metadata() {
    let project = tempfile::tempdir().expect("project without Gradle wrapper");
    let first_started = Instant::now();
    let first = inspect_java_type_members(
        project.path().to_string_lossy().into_owned(),
        vec!["java.util.Stack".to_string()],
    )
    .expect("JDK Stack metadata");
    let first_elapsed = first_started.elapsed();
    let stack = first.types.first().expect("Stack type");
    assert!(stack.available);
    for method in ["push", "pop", "peek", "iterator"] {
        assert!(
            stack.methods.iter().any(|member| member.name == method),
            "missing Stack or inherited method {method}"
        );
    }
    assert!(first.fingerprint.contains("classpath-unresolved"));

    let cached_started = Instant::now();
    let cached = inspect_java_type_members(
        project.path().to_string_lossy().into_owned(),
        vec!["java.util.Stack".to_string()],
    )
    .expect("cached JDK Stack metadata");
    let cached_elapsed = cached_started.elapsed();
    assert_eq!(cached.fingerprint, first.fingerprint);
    assert_eq!(cached.types, first.types);
    eprintln!(
            "Stack metadata timings: first={}ms cached={}us; no Gradle wrapper present and classpath remains unresolved",
            first_elapsed.as_millis(),
            cached_elapsed.as_micros()
        );

    let mixed = inspect_java_type_members(
        project.path().to_string_lossy().into_owned(),
        vec![
            "java.util.Stack".to_string(),
            "java.lang.Integer".to_string(),
            "java.lang.Cloneable".to_string(),
        ],
    )
    .expect("mixed JDK metadata");
    assert_eq!(mixed.fingerprint, first.fingerprint);
    let integer = mixed.types.get(1).expect("Integer type");
    assert!(integer.available);
    assert!(integer
        .methods
        .iter()
        .any(|method| method.name == "parseInt" && method.is_static));
    assert!(integer
        .fields
        .iter()
        .any(|field| field.name == "MAX_VALUE" && field.is_static));
    let empty = mixed.types.get(2).expect("Cloneable type");
    assert!(empty.available);
    assert!(empty.methods.is_empty());
    assert!(empty.fields.is_empty());
}

#[test]
fn reflects_public_inherited_generic_members_without_initializing_classes() {
    let java = crate::runner::discover_metadata_java().expect("metadata JDK");
    let workspace = tempfile::tempdir().expect("fixture workspace");
    let source_dir = workspace.path().join("src/fixture");
    let classes = workspace.path().join("compiled classes");
    fs::create_dir_all(&source_dir).expect("fixture source directory");
    fs::create_dir_all(&classes).expect("class output directory");
    let parent = source_dir.join("Parent.java");
    let child = source_dir.join("Child.java");
    fs::write(
        &parent,
        r#"package fixture;
public class Parent<T> {
    static { if (Boolean.parseBoolean("true")) throw new AssertionError("initialized"); }
    public static Object explosive = failIfInitialized();
    public static Object failIfInitialized() { throw new AssertionError("initialized"); }
    public static int inheritedStatic;
    public T inheritedField;
    public T inherited(T value) { return value; }
}"#,
    )
    .expect("Parent source");
    fs::write(
        &child,
        r#"package fixture;
import java.util.List;
public class Child extends Parent<String> {
    static { if (Boolean.parseBoolean("true")) throw new AssertionError("initialized"); }
    public static int CODE;
    public String own(String value) { return value; }
    public <X extends CharSequence> List<X> convert(List<X> values) { return values; }
}"#,
    )
    .expect("Child source");
    let javac = java.home.join("bin").join(executable_name("javac"));
    let mut compile = Command::new(javac);
    compile
        .arg("-parameters")
        .arg("-d")
        .arg(&classes)
        .arg(&parent)
        .arg(&child);
    run_test_command(&mut compile, "compile generic member fixture");

    let members = inspect_type_members_on_classpath(
        &java.home,
        std::slice::from_ref(&classes),
        &["fixture.Child".to_string()],
    )
    .expect("fixture metadata");
    let child = members.first().expect("Child result");
    assert!(child.available, "class initialization must not run");
    assert!(child
        .methods
        .iter()
        .any(|method| { method.name == "inherited" && method.return_type == "T" }));
    let convert = child
        .methods
        .iter()
        .find(|method| method.name == "convert")
        .expect("generic method");
    assert_eq!(convert.return_type, "java.util.List<X>");
    assert_eq!(convert.parameters[0].type_name, "java.util.List<X>");
    assert!(child
        .methods
        .iter()
        .any(|method| method.name == "own" && !method.is_static));
    assert!(child
        .fields
        .iter()
        .any(|field| field.name == "CODE" && field.is_static));
    assert!(child
        .fields
        .iter()
        .any(|field| field.name == "inheritedStatic" && field.is_static));
    assert!(child
        .fields
        .iter()
        .any(|field| field.name == "inheritedField" && !field.is_static));
}

#[test]
fn missing_java_type_returns_a_negative_result() {
    let project = tempfile::tempdir().expect("project without Gradle wrapper");
    let metadata = inspect_java_type_members(
        project.path().to_string_lossy().into_owned(),
        vec!["example.missing.NeverThere".to_string()],
    )
    .expect("missing class is metadata, not an error");
    let missing = metadata.types.first().expect("missing result");
    assert!(!missing.available);
    assert!(missing.methods.is_empty());
    assert!(missing.fields.is_empty());
}

#[test]
fn classpath_fingerprint_tracks_jar_and_inherited_class_content() {
    let workspace = tempfile::tempdir().expect("workspace");
    let jar = workspace.path().join("dependency with spaces.jar");
    fs::write(&jar, b"version one").expect("write jar");
    let jar_path = fs::canonicalize(&jar).expect("canonical jar");
    let root = workspace.path();
    let first =
        classpath_fingerprint(root, std::slice::from_ref(&jar_path)).expect("first fingerprint");
    fs::write(&jar, b"version two").expect("replace jar content");
    let second =
        classpath_fingerprint(root, std::slice::from_ref(&jar_path)).expect("second fingerprint");
    assert_ne!(first, second);

    let classes = workspace.path().join("classes");
    let ps_class = classes.join(PS_CLASS_RESOURCE);
    let base_class = classes.join("io/github/shanepark/Base.class");
    fs::create_dir_all(ps_class.parent().expect("Ps parent")).expect("Ps directory");
    fs::write(&ps_class, b"Ps bytecode v1").expect("write Ps class");
    fs::write(&base_class, b"Base bytecode v1").expect("write Base class");
    let first =
        classpath_fingerprint(root, std::slice::from_ref(&classes)).expect("directory fingerprint");
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
        std::os::unix::fs::symlink(&classes, classes.join("cycle")).expect("create directory loop");
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
    let updated_methods =
        inspect_classpath(&java.home, std::slice::from_ref(&jar)).expect("updated jar metadata");
    assert_eq!(updated_methods.len(), 1);
    assert_eq!(updated_methods[0].name, "added");
    assert_eq!(updated_methods[0].parameters.len(), 2);
    let second_fingerprint = classpath_fingerprint(workspace.path(), std::slice::from_ref(&jar))
        .expect("second fingerprint");
    assert_ne!(first_fingerprint, second_fingerprint);
}

#[test]
fn absence_of_ps_returns_empty_metadata() {
    let java = discover_compatible_java().expect("compatible JDK");
    let workspace = tempfile::tempdir().expect("workspace");
    let classes = workspace.path().join("classes");
    fs::create_dir(&classes).expect("classes dir");
    let methods =
        inspect_classpath(&java.home, std::slice::from_ref(&classes)).expect("missing Ps metadata");
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

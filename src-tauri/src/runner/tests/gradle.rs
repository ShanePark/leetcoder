use crate::models::RunProblemTestArgs;
use crate::runner::{
    build_gradle_init_script, create_compile_cache, create_init_script, run_problem_test,
    validate_gradle_wrapper, JavaInstallation, TEST_EVENT_MARKER,
};
use std::fs;
use std::path::PathBuf;

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
    assert!(script.contains("leetcoderClassesDir"));
    assert!(script.contains("leetcoderSharedClassesDir"));
    assert!(script.contains("leetcoderSharedCompile"));
    assert!(script.contains("leetcoderSourceFile"));
    assert!(script.contains("project.file(sourceOverride)"));
    assert!(script.contains("dependsOn sharedCompileTask"));
    assert!(!script.contains("options.sourcepath"));
    assert!(script.contains("sourceSets.main.resources.srcDirs"));
    assert!(script.contains("file.isFile() && file.name.toLowerCase().endsWith('.jar')"));
    assert!(script.contains("useJUnitPlatform()"));
    assert!(script.contains("testLogging.showStandardStreams = true"));
    assert!(script.contains("junitXml.outputLocation"));
    assert!(script.contains("junitXml.outputPerTestCase = true"));
    assert!(script.contains("outputs.upToDateWhen { false }"));
    let compile_section = script
        .split("def compileTask")
        .nth(1)
        .expect("problem compile task");
    assert!(!compile_section
        .split("tasks.register('leetcoderProblemTest'")
        .next()
        .expect("compile task body")
        .contains("outputs.upToDateWhen { false }"));
    assert!(script.contains("leetcoderResultDir"));
    assert!(script.contains(TEST_EVENT_MARKER));
    assert!(script.contains("beforeTest"));
    assert!(script.contains("afterTest"));
    assert!(script.contains("descriptor.composite"));
    assert!(script.contains("JsonOutput.toJson"));
}

#[test]
fn temporary_script_and_results_are_private_unique_and_removed_on_drop() {
    let root = tempfile::tempdir().expect("cache root");
    let java = JavaInstallation {
        home: PathBuf::from("/jdk-17"),
        major_version: 17,
    };
    let canonical_root = fs::canonicalize(root.path()).expect("canonical cache root");
    let cache = create_compile_cache(&canonical_root, &java, "sample.Q1").expect("compile cache");
    let first = create_init_script(&cache).expect("first init script");
    let second = create_init_script(&cache).expect("second init script");
    assert_ne!(first.path, second.path);
    assert_ne!(first.result_dir, second.result_dir);
    assert_eq!(first.classes_dir, second.classes_dir);
    assert_eq!(first.shared_classes_dir, second.shared_classes_dir);
    assert!(first.path.is_file());
    assert!(first.result_dir.is_dir());
    assert!(first.classes_dir.is_dir());
    assert!(first.shared_classes_dir.is_dir());
    assert!(second.path.is_file());
    assert!(second.result_dir.is_dir());
    assert!(second.classes_dir.is_dir());
    assert!(second.shared_classes_dir.is_dir());

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
    assert!(first_classes.exists());
    assert!(second.path.exists());
    drop(second);
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
        test_method: None,
    });
    assert!(result.unwrap_err().contains("valid ps repository"));
}

#[cfg(unix)]
#[test]
fn problem_test_invokes_a_reusable_daemon_and_preserves_the_method_filter() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("test repository");
    let root = directory.path();
    for package in crate::security::PACKAGE_SEGMENTS {
        fs::create_dir_all(root.join(crate::security::SOURCE_ROOT).join(package))
            .expect("problem package");
    }
    for file in ["build.gradle", "settings.gradle"] {
        fs::write(root.join(file), "").expect("repository build file");
    }
    let wrapper = root.join("gradlew");
    fs::write(
        &wrapper,
        r#"#!/bin/sh
printf '%s\n' "$@" > arguments.txt
printf '%s' "$JAVA_HOME" > java-home.txt
for argument do
    case "$argument" in
        -DleetcoderResultDir=*) result_dir=${argument#*=} ;;
    esac
done
cat > "$result_dir/TEST-Q1.xml" <<'REPORT'
<testsuite name="shane.leetcode.problems.easy.Q1" tests="1" time="0.001">
  <testcase classname="shane.leetcode.problems.easy.Q1" name="selectedTest" time="0.001"/>
</testsuite>
REPORT
"#,
    )
    .expect("fake wrapper");
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).expect("executable wrapper");

    let result = run_problem_test(RunProblemTestArgs {
        project_root: root.to_string_lossy().into_owned(),
        fully_qualified_class_name: "shane.leetcode.problems.easy.Q1".to_string(),
        test_method: Some("selectedTest".to_string()),
    })
    .expect("run selected problem test");

    assert!(result.success, "{result:?}");
    assert_eq!(result.summary.passed, 1);
    let arguments = fs::read_to_string(root.join("arguments.txt")).expect("wrapper arguments");
    let arguments: Vec<_> = arguments.lines().collect();
    assert!(arguments.contains(&"--daemon"));
    assert!(arguments.contains(&"--console=plain"));
    assert!(!arguments.contains(&"--no-daemon"));
    assert!(arguments.contains(&"leetcoderProblemTest"));
    assert!(arguments
        .windows(2)
        .any(|pair| { pair == ["--tests", "shane.leetcode.problems.easy.Q1.selectedTest"] }));
    let java_home = fs::read_to_string(root.join("java-home.txt")).expect("selected Java home");
    assert!(PathBuf::from(java_home).join("bin/java").is_file());
}

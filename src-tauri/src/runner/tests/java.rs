use crate::runner::{
    discover_compatible_java, discover_compatible_java_baseline, discover_macos_java_homes_with,
    parse_java_major_version, select_compatible_java, select_metadata_java, JavaInstallation,
};
use std::fs;
use std::path::{Path, PathBuf};

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
fn metadata_java_prefers_gradle_compatible_jdk_then_accepts_newer_jdk() {
    let candidates = vec![
        JavaInstallation {
            home: PathBuf::from("/jdk-21"),
            major_version: 21,
        },
        JavaInstallation {
            home: PathBuf::from("/jdk-17"),
            major_version: 17,
        },
    ];
    assert_eq!(
        select_metadata_java(&candidates),
        Some(candidates[1].clone())
    );
    assert_eq!(
        select_metadata_java(&candidates[..1]),
        Some(candidates[0].clone())
    );
    assert!(select_metadata_java(&candidates[1..]).is_some());
    assert!(select_metadata_java(&[JavaInstallation {
        home: PathBuf::from("/jdk-8"),
        major_version: 8,
    }])
    .is_none());
}

#[cfg(unix)]
fn fake_macos_java_home_helper(root: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let helper = root.join("java-home-helper");
    fs::write(
        &helper,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  11) sleep 0.07; printf '%s\\n' \"{}/java-11\" ;;\n  12) sleep 0.06; exit 1 ;;\n  13) sleep 0.05; printf '%s\\n' \"{}/java-13\" ;;\n  14) sleep 0.04; printf '%s\\n' \"{}/java-14\" ;;\n  15) sleep 0.03; printf '%s\\n' \"{}/java-15\" ;;\n  16) sleep 0.02; printf '%s\\n' \"{}/java-16\" ;;\n  17) sleep 0.01; printf '%s\\n' \"{}/java-17\" ;;\nesac\n",
            root.display(),
            root.display(),
            root.display(),
            root.display(),
            root.display(),
            root.display(),
        ),
    )
    .expect("fake java_home helper");
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).expect("helper executable");
    helper
}

#[cfg(unix)]
#[test]
fn macos_java_home_queries_preserve_version_order_and_skip_failures() {
    let root = tempfile::tempdir().expect("fake java_home root");
    let helper = fake_macos_java_home_helper(root.path());
    let expected = [11, 13, 14, 15, 16, 17]
        .into_iter()
        .map(|version| root.path().join(format!("java-{version}")))
        .collect::<Vec<_>>();

    let parallel = discover_macos_java_homes_with(&helper, true);
    let sequential = discover_macos_java_homes_with(&helper, false);

    assert_eq!(parallel, expected);
    assert_eq!(parallel, sequential);
}

#[test]
#[ignore = "manual native Java discovery benchmark"]
fn benchmark_java_discovery() {
    let mut selected = None;
    for _ in 0..4 {
        let baseline = discover_compatible_java_baseline().expect("baseline JDK");
        let optimized = discover_compatible_java().expect("optimized JDK");
        assert_eq!(baseline, optimized);
        selected = Some(optimized);
    }
    let selected = selected.expect("warmup JDK");

    let mut baseline_durations = Vec::with_capacity(20);
    let mut optimized_durations = Vec::with_capacity(20);
    for iteration in 0..20 {
        if iteration % 2 == 0 {
            let started = std::time::Instant::now();
            let baseline = discover_compatible_java_baseline().expect("baseline JDK");
            baseline_durations.push(started.elapsed());
            let started = std::time::Instant::now();
            let optimized = discover_compatible_java().expect("optimized JDK");
            optimized_durations.push(started.elapsed());
            assert_eq!(baseline, optimized);
        } else {
            let started = std::time::Instant::now();
            let optimized = discover_compatible_java().expect("optimized JDK");
            optimized_durations.push(started.elapsed());
            let started = std::time::Instant::now();
            let baseline = discover_compatible_java_baseline().expect("baseline JDK");
            baseline_durations.push(started.elapsed());
            assert_eq!(baseline, optimized);
        }
    }
    eprintln!(
        "Java discovery benchmark: warmup_pairs=4, measured_pairs=20, selected={selected:?}, baseline={baseline_durations:?}, optimized={optimized_durations:?}"
    );
}

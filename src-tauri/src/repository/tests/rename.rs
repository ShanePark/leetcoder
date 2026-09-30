use std::fs;

use crate::models::RenameProblemFileArgs;
use crate::security::SOURCE_ROOT;

use super::super::rename_problem_file;
use super::super::source_names::replace_source_identifiers;
use super::fixture;

#[test]
fn rename_updates_type_references_and_preserves_literals_and_comments() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let package = directory.path().join(SOURCE_ROOT).join("easy");
    let source_path = package.join("Q1.java");
    fs::write(
            &source_path,
            "package shane.leetcode.problems.easy;\n// Q1 should remain in this comment\npublic class Q1 {\n    String label = \"Q1\";\n    Q1() {}\n    Q1 copy() { return new Q1(); }\n}\n",
        )
        .unwrap();

    let renamed = rename_problem_file(RenameProblemFileArgs {
        project_root: root,
        relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
        new_relative_path: "Q1Renamed".to_string(),
    })
    .unwrap();
    assert_eq!(
        renamed.relative_path,
        format!("{SOURCE_ROOT}/easy/Q1Renamed.java")
    );
    assert!(!source_path.exists());
    assert!(package.join("Q1Renamed.java").exists());
    assert!(renamed.content.contains("public class Q1Renamed"));
    assert!(renamed.content.contains("Q1Renamed()"));
    assert!(renamed.content.contains("new Q1Renamed()"));
    assert!(renamed
        .content
        .contains("// Q1 should remain in this comment"));
    assert!(renamed.content.contains("= \"Q1\""));
}

#[test]
fn rename_rejects_collisions_and_cross_directory_moves_without_mutating_source() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let easy = directory.path().join(SOURCE_ROOT).join("easy");
    let medium = directory.path().join(SOURCE_ROOT).join("medium");
    fs::write(easy.join("Q1.java"), "public class Q1 {}\n").unwrap();
    fs::write(easy.join("Q2.java"), "public class Q2 {}\n").unwrap();

    let collision = rename_problem_file(RenameProblemFileArgs {
        project_root: root.clone(),
        relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
        new_relative_path: "Q2.java".to_string(),
    })
    .unwrap_err();
    assert!(collision.contains("already exists"));
    assert!(easy.join("Q1.java").exists());

    let outside_package = rename_problem_file(RenameProblemFileArgs {
        project_root: root,
        relative_path: format!("{SOURCE_ROOT}/easy/Q1.java"),
        new_relative_path: format!("{SOURCE_ROOT}/medium/Q1.java"),
    })
    .unwrap_err();
    assert!(outside_package.contains("existing directory"));
    assert_eq!(
        fs::read_to_string(easy.join("Q1.java")).unwrap(),
        "public class Q1 {}\n"
    );
    assert!(!medium.join("Q1.java").exists());
}

#[test]
fn identifier_replacement_ignores_comments_strings_and_character_literals() {
    let source =
        "class Old { String text = \"Old\"; char c = 'O'; /* Old */ Old value; }\n// Old\n";
    let replaced = replace_source_identifiers(source, "Old", "New");
    assert_eq!(
        replaced,
        "class New { String text = \"Old\"; char c = 'O'; /* Old */ New value; }\n// Old\n"
    );
}

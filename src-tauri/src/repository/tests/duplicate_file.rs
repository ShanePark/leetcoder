use std::fs;
use std::os::unix::fs as unix_fs;

use crate::models::ProblemFileArgs;
use crate::security::SOURCE_ROOT;

use super::super::duplicate_problem_file;
use super::fixture;

#[test]
fn duplicate_ignores_non_sources_and_symlink_collisions_in_nested_directory() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().into_owned();
    let nested = directory
        .path()
        .join(SOURCE_ROOT)
        .join("easy")
        .join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("Nested.java"), "class Nested {}\n").unwrap();
    fs::write(nested.join("Nested2.kt"), "class Nested2\n").unwrap();
    fs::write(nested.join("Nested3.txt"), "ignored\n").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("Nested4.java"), "outside\n").unwrap();
    unix_fs::symlink(
        outside.path().join("Nested4.java"),
        nested.join("Nested4.java"),
    )
    .unwrap();

    let duplicate = duplicate_problem_file(ProblemFileArgs {
        project_root: root,
        relative_path: format!("{SOURCE_ROOT}/easy/nested/Nested.java"),
    })
    .unwrap();

    assert_eq!(
        duplicate.relative_path,
        format!("{SOURCE_ROOT}/easy/nested/Nested3.java")
    );
    assert!(nested.join("Nested3.java").is_file());
    assert!(duplicate.content.contains("class Nested3"));
}

#[test]
fn duplicate_uses_next_available_suffix_and_updates_java_type_name() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let package = directory.path().join(SOURCE_ROOT).join("easy");
    let stem = "Q2904ShortestAndLexicographicallySmallestBeautifulString";
    let source_path = package.join(format!("{stem}.java"));
    let source = format!(
            "package shane.leetcode.problems.easy;\n\n// {stem}\npublic class {stem} {{\n    private final String label = \"{stem}\";\n    {stem}() {{}}\n    {stem} copy() {{ return new {stem}(); }}\n}}\n"
        );
    fs::write(&source_path, &source).unwrap();
    fs::write(
        package.join(format!("{stem}2.java")),
        "class Existing2 {}\n",
    )
    .unwrap();
    fs::write(
        package.join(format!("{stem}3.java")),
        "class Existing3 {}\n",
    )
    .unwrap();
    // Kotlin names participate in collision detection too.
    fs::write(package.join(format!("{stem}5.kt")), "class Existing5\n").unwrap();

    let duplicate = duplicate_problem_file(ProblemFileArgs {
        project_root: root.clone(),
        relative_path: format!("{SOURCE_ROOT}/easy/{stem}.java"),
    })
    .unwrap();
    let expected_path = format!("{SOURCE_ROOT}/easy/{stem}4.java");
    let expected_stem = format!("{stem}4");
    assert_eq!(duplicate.relative_path, expected_path);
    assert_eq!(
        duplicate.content,
        fs::read_to_string(directory.path().join(&expected_path)).unwrap()
    );
    assert!(duplicate
        .content
        .contains(&format!("public class {expected_stem}")));
    assert!(duplicate
        .content
        .contains(&format!("{expected_stem}() {{\n    }}")));
    assert!(duplicate
        .content
        .contains("copy() {\n        return null;\n    }"));
    assert!(duplicate.content.contains(&format!("// {stem}")));
    assert!(!duplicate.content.contains("private final String label"));
    assert_eq!(fs::read_to_string(&source_path).unwrap(), source);

    // Duplicating an already suffixed copy continues the same family,
    // rather than producing a surprising `...4...4.java` name.
    let second = duplicate_problem_file(ProblemFileArgs {
        project_root: root,
        relative_path: expected_path,
    })
    .unwrap();
    assert_eq!(
        second.relative_path,
        format!("{SOURCE_ROOT}/easy/{stem}6.java")
    );
    assert!(second.content.contains(&format!("public class {stem}6")));
}

#[test]
fn duplicate_java_keeps_tests_and_creates_a_reset_template() {
    let directory = fixture();
    let root = directory.path().to_string_lossy().to_string();
    let package = directory.path().join(SOURCE_ROOT).join("medium");
    let base = "Q1162AsFarFromLandAsPossible";
    fs::write(
        package.join(format!("{base}.java")),
        format!("class {base} {{}}\n"),
    )
    .unwrap();
    let source_path = package.join(format!("{base}2.java"));
    let source = r#"package shane.leetcode.problems.medium;

import io.github.shanepark.Ps;
import org.junit.jupiter.api.Test;

import java.util.LinkedList;
import java.util.Queue;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Runtime 15 ms Beats 72.46%
 * Memory 43.1 MB Beats 85.67%
 */
public class Q1162AsFarFromLandAsPossible2 {

    @Test
    public void test() {
        assertThat(maxDistance(Ps.intArray("[[1,0,1],[0,0,0],[1,0,1]]"))).isEqualTo(2);
        assertThat(maxDistance(Ps.intArray("[[1,0,0],[0,0,0],[0,0,0]]"))).isEqualTo(4);
    }

    int[][] DIRS = new int[][]{{0, -1}, {0, 1}, {1, 0}, {-1, 0}};

    public int maxDistance(int[][] grid) {
        int width = grid[0].length;
        int height = grid.length;
        return Math.max(width, height);
    }

}
"#;
    fs::write(&source_path, source).unwrap();

    let duplicate = duplicate_problem_file(ProblemFileArgs {
        project_root: root,
        relative_path: format!("{SOURCE_ROOT}/medium/{base}2.java"),
    })
    .unwrap();

    assert_eq!(
        duplicate.relative_path,
        format!("{SOURCE_ROOT}/medium/{base}3.java")
    );
    assert_eq!(fs::read_to_string(source_path).unwrap(), source);
    assert!(duplicate.content.contains(&format!("public class {base}3")));
    assert!(duplicate
        .content
        .contains("    @Test\n    public void test() {"));
    assert!(duplicate.content.contains(
        "assertThat(maxDistance(Ps.intArray(\"[[1,0,1],[0,0,0],[1,0,1]]\"))).isEqualTo(2);"
    ));
    assert!(!duplicate.content.contains("Runtime"));
    assert!(!duplicate.content.contains("Memory"));
    assert!(!duplicate.content.contains("DIRS"));
    assert!(duplicate
        .content
        .contains("public int maxDistance(int[][] grid) {\n        return -1;\n    }"));
}

use crate::runner::{
    java_source_relative_path, validate_fully_qualified_class_name, validate_test_method,
};
use std::path::PathBuf;

#[test]
fn class_name_validation_rejects_command_like_input() {
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q1").is_ok());
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q$1").is_ok());
    assert!(validate_fully_qualified_class_name("shane.leetcode.Q1 --info").is_err());
    assert!(validate_fully_qualified_class_name("../Q1").is_err());
    assert!(validate_fully_qualified_class_name("").is_err());
}

#[test]
fn test_method_validation_rejects_command_like_input() {
    assert!(validate_test_method(None).is_ok());
    assert!(validate_test_method(Some("test2")).is_ok());
    assert!(validate_test_method(Some("test2()")).is_err());
    assert!(validate_test_method(Some("test two")).is_err());
    assert!(validate_test_method(Some("test.*")).is_err());
    assert!(validate_test_method(Some("test.two")).is_err());
    assert!(validate_test_method(Some(" test2")).is_err());
    assert!(validate_test_method(Some("")).is_err());
}

#[test]
fn derives_the_java_source_path_from_a_fully_qualified_class_name() {
    assert_eq!(
        java_source_relative_path("shane.leetcode.problems.medium.Q3904SmallestStableIndexII"),
        PathBuf::from(
            "src/main/java/shane/leetcode/problems/medium/Q3904SmallestStableIndexII.java"
        )
    );
}

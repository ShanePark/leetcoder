use super::reset_java_implementation;

#[test]
fn preserves_tests_and_nested_signatures_while_resetting_implementations() {
    let source = r#"package sample;
import org.junit.jupiter.api.Test;
/** Runtime 15 ms Beats 72.46%
 * Memory 43.1 MB Beats 85.67%
 */
class Q1 {
    int[] field = new int[][]{{1}};

    @Test
    void test() {
        String content = """
                first


                second
                """;
        assertEquals(1, solve(content));
    }

    public int solve(String input) { return 1; }
    private void helper() { System.out.println("{not code}"); }

    class Nested {
        Nested(int value) { this.value = value; }
        private int value;
        public boolean check() { return true; }
        public String text() { return "ok"; }
    }
}
"#;
    let result = reset_java_implementation(source);
    assert!(result.contains("first\n\n\n                second"));
    assert!(result.contains("import org.junit.jupiter.api.Test;"));
    assert!(result.contains("void test() {"));
    assert!(result.contains("public int solve(String input) {\n        return -1;\n    }"));
    assert!(result.contains("private void helper() {\n    }"));
    assert!(result.contains("Nested(int value) {\n        }"));
    assert!(result.contains("public boolean check() {\n            return false;\n        }"));
    assert!(result.contains("public String text() {\n            return null;\n        }"));
    assert!(!result.contains("int[] field"));
    assert!(!result.contains("Runtime"));
    assert!(!result.contains("Memory"));
}

#[test]
fn keeps_main_interfaces_and_enum_constants() {
    let source = r#"interface Reader { int read(); }
enum State {
    READY(1), DONE(2);
    State(int value) {}
    int code() { return 1; }
}
class Q2 { public static void main(String[] args) { System.out.println("ok"); }
    private char marker() { return 'x'; }
    private long total() { return 3; }
}
"#;
    let result = reset_java_implementation(source);
    assert!(result.contains("int read();"));
    assert!(result.contains("READY(1), DONE(2);"));
    assert!(result.contains("State(int value) {\n    }"));
    assert!(
        result.contains("public static void main(String[] args) { System.out.println(\"ok\"); }")
    );
    assert!(result.contains("private char marker() {\n        return '\\0';\n    }"));
    assert!(result.contains("private long total() {\n        return -1;\n    }"));
}

#[test]
fn keeps_test_used_fields_and_stubs_primitive_arrays_correctly() {
    let source = r#"import org.junit.jupiter.api.Test;
import java.util.ArrayList;
class Q3 {
    @Test void test() {
        Node node = new Node();
        node.children = new ArrayList<>();
        assertThat(read()).isEqualTo("Runtime 5 ms");
    }
    String read() { return "Runtime 5 ms"; }
    int[] values() { return new int[]{1}; }
    int count() { return 5; }
}
class Node {
    public int val;
    public List<Node> children;
    public int unused;
}
"#;
    let source = format!("/** Runtime: 5 ms */\n{source}");
    let result = reset_java_implementation(&source);
    assert!(result.contains("Node node = new Node();"));
    assert!(result.contains("node.children = new ArrayList<>();"));
    assert!(result.contains("@Test void test() {"));
    assert!(result.contains("String read() {\n        return null;\n    }"));
    assert!(result.contains("int[] values() {\n        return null;\n    }"));
    assert!(result.contains("int count() {\n        return -1;\n    }"));
    assert!(result.contains("public List<Node> children;"));
    assert!(!result.contains("public int val;"));
    assert!(!result.contains("public int unused;"));
    assert!(!result.contains("Runtime: 5 ms"));
    assert!(result.contains("Runtime 5 ms"));
}

#[test]
fn removes_metric_comments_without_touching_literal_text() {
    let source = r#"class Q4 {
    String value() { return "Runtime 5 ms"; }
    // Memory Usage 2 MB
    int run() { return 4; }
}
"#;
    let result = reset_java_implementation(source);
    assert!(result.contains("String value() {\n        return null;\n    }"));
    assert!(!result.contains("Memory Usage"));
    assert!(result.contains("int run() {\n        return -1;\n    }"));
}

#[test]
fn removes_inline_metric_comments_without_joining_signature_tokens() {
    let source = "class Q4 { int /* Runtime 1 ms */ solve() { return 4; } }";
    let result = reset_java_implementation(source);
    assert!(result.contains("int   solve() {\n    return -1;\n}"));
    assert!(!result.contains("Runtime 1 ms"));
}

#[test]
fn preserves_qualified_lifecycle_methods_and_their_fixture_fields() {
    let source = r#"class Q4 {
    int fixture;
    int implementationState = 3;

    @org.junit.jupiter.api.BeforeEach
    void setup() { fixture = 1; }

    @org.junit.jupiter.api.AfterAll
    static void teardown() { System.clearProperty("fixture"); }

    @org.junit.BeforeClass
    static void classSetup() { System.setProperty("fixture", "ready"); }

    int solve() { return implementationState; }
}
"#;
    let result = reset_java_implementation(source);
    assert!(result.contains("@org.junit.jupiter.api.BeforeEach\n    void setup() { fixture = 1; }"));
    assert!(result.contains(
            "@org.junit.jupiter.api.AfterAll\n    static void teardown() { System.clearProperty(\"fixture\"); }"
        ));
    assert!(result.contains(
            "@org.junit.BeforeClass\n    static void classSetup() { System.setProperty(\"fixture\", \"ready\"); }"
        ));
    assert!(result.contains("int fixture;"));
    assert!(!result.contains("implementationState"));
    assert!(result.contains("int solve() {\n        return -1;\n    }"));
}

#[test]
fn methods_named_like_the_class_are_not_treated_as_constructors() {
    let source = "class Same { int Same() { return 2; } }";
    let result = reset_java_implementation(source);
    assert!(result.contains("int Same() {\n    return -1;\n}"));
}

#[test]
fn ignores_method_calls_and_array_length_when_preserving_test_fields() {
    let source = r#"import org.junit.jupiter.api.Test;
class Q5 {
    @Test void test() {
        Stack stack = new Stack();
        stack.increment(1, 1);
        int[] arr = new int[0];
        Holder holder = new Holder();
        holder.arr = arr;
        assertEquals(0, arr.length);
    }
}
class Stack { final int[] increment = new int[1]; }
class SortedArray { final int length; }
class Holder { int[] arr; }
"#;
    let result = reset_java_implementation(source);
    assert!(!result.contains("final int[] increment"));
    assert!(!result.contains("final int length"));
    assert!(result.contains("stack.increment(1, 1);"));
    assert!(result.contains("holder.arr = arr;"));
    assert!(result.contains("int[] arr;"));
    assert!(result.contains("assertEquals(0, arr.length);"));
}

#[test]
fn removes_failed_result_comments_and_keeps_main_harness() {
    let source = r#"/** Wrong Answer
 * Input
 * "01"
 * Expected
 * "1"
 */
class Q6 {
    public static void main(String[] args) { System.out.println("try again"); }
    int solve() { return 1; }
}
"#;
    let result = reset_java_implementation(source);
    assert!(!result.contains("Wrong Answer"));
    assert!(!result.contains("Expected"));
    assert!(result
        .contains("public static void main(String[] args) { System.out.println(\"try again\"); }"));
    assert!(result.contains("int solve() {\n        return -1;\n    }"));
}

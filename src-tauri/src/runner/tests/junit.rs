use crate::models::ProblemTestStatus;
use crate::runner::{extract_expected_actual, parse_junit_xml, summarize_tests};
use serde_json::Value;

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
fn parses_assertj_boolean_comparisons_without_matching_arbitrary_prose() {
    assert_eq!(
        extract_expected_actual("Expecting value to be true but was false"),
        (Some("true".to_string()), Some("false".to_string()))
    );
    assert_eq!(
        extract_expected_actual("Expecting value to be false but was true"),
        (Some("false".to_string()), Some("true".to_string()))
    );
    assert_eq!(
        extract_expected_actual("Expecting value to be ready but was false"),
        (None, None)
    );
    // An exact AssertJ comparison wins over unrelated labels elsewhere in
    // the combined failure description.
    assert_eq!(
        extract_expected_actual(
            "expected: <5> but was: <4>\nExpecting value to be true but was false"
        ),
        (Some("true".to_string()), Some("false".to_string()))
    );
    assert_eq!(
        extract_expected_actual(concat!(
            "Description: expected: <5> and actual: <4>\n",
            "Expecting value to be false but was true\n",
            "Additional prose: expected: <8> and actual: <9>"
        )),
        (Some("false".to_string()), Some("true".to_string()))
    );
}

#[test]
fn parses_assertj_contains_exactly_expected_and_actual_values() {
    let xml = r#"
<testsuites><testsuite name="Q1"><testcase classname="sample.Q1" name="containsExactly">
  <failure><![CDATA[
java.lang.AssertionError:
Expecting actual:
 [0, 1, 0, 1, 0, 1]
to contain exactly (and in same order):
 [0, 1, 1, 1, 1, 0]
but some elements were not found:
 [1]
and others were not expected:
 [0]
at sample.Q1.containsExactly(Q1.java:12)
]]></failure>
</testcase></testsuite></testsuites>
"#;

    let parsed = parse_junit_xml(xml).expect("fixture parses");
    assert_eq!(parsed.tests.len(), 1);
    assert_eq!(
        parsed.tests[0].expected.as_deref(),
        Some("[0, 1, 1, 1, 1, 0]")
    );
    assert_eq!(
        parsed.tests[0].actual.as_deref(),
        Some("[0, 1, 0, 1, 0, 1]")
    );
}

#[test]
fn parses_per_testcase_output_without_attributing_suite_output() {
    let xml = r#"
<testsuites>
  <testsuite name="Q1" time="0.010">
    <testcase classname="sample.Q1" name="prints">
      <system-out>hello &amp; goodbye
</system-out>
      <system-err><![CDATA[warning <detail>]]></system-err>
      <failure message="expected: &lt;1&gt; but was: &lt;2&gt;"><![CDATA[at sample.Q1.prints(Q1.java:11)]]></failure>
    </testcase>
    <system-out><![CDATA[suite output must stay global]]></system-out>
    <system-err>suite error must stay global</system-err>
  </testsuite>
</testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    assert_eq!(parsed.tests.len(), 1);
    let test = &parsed.tests[0];
    assert_eq!(test.stdout.as_deref(), Some("hello & goodbye\n"));
    assert_eq!(test.stderr.as_deref(), Some("warning <detail>"));
    assert_eq!(test.message.as_deref(), Some("expected: <1> but was: <2>"));
    assert!(test
        .details
        .as_deref()
        .is_some_and(|details| details.contains("Q1.java:11")));
}

#[test]
fn prefers_the_active_test_frame_over_junit_and_jdk_frames() {
    let xml = r#"
<testsuites>
  <testsuite name="Q1" tests="1">
    <testcase classname="sample.Q1" name="fails">
      <failure message="boom"><![CDATA[
at sample.Q1.test(Q1.java:19)
at org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:12)
at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
]]></failure>
    </testcase>
  </testsuite>
</testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    assert_eq!(parsed.tests.len(), 1);
    assert_eq!(parsed.tests[0].source_file.as_deref(), Some("Q1.java"));
    assert_eq!(parsed.tests[0].source_line, Some(19));
}

#[test]
fn serializes_per_testcase_output_as_optional_camel_case_fields() {
    let xml = r#"
<testsuites><testsuite><testcase classname="sample.Q1" name="prints">
  <system-out><![CDATA[hello]]></system-out>
  <system-err><![CDATA[warning]]></system-err>
</testcase></testsuite></testsuites>
"#;
    let parsed = parse_junit_xml(xml).expect("fixture parses");
    let value: Value = serde_json::to_value(&parsed.tests[0]).expect("test serializes");
    assert_eq!(value["stdout"], Value::String("hello".to_string()));
    assert_eq!(value["stderr"], Value::String("warning".to_string()));
}

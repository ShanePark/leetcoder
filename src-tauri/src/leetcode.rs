use reqwest::header::{ACCEPT, CONTENT_TYPE, ORIGIN, REFERER};
use serde_json::{json, Map, Value};

use crate::models::DailyProblem;

const LEETCODE_GRAPHQL_URL: &str = "https://leetcode.com/graphql";
const LEETCODE_PROBLEM_INDEX_URL: &str = "https://leetcode.com/api/problems/all/";
const DAILY_PROBLEM_QUERY: &str = r#"
query dailyProblem {
  activeDailyCodingChallengeQuestion {
    date
    link
    question {
      questionFrontendId
      title
      titleSlug
      difficulty
      content
      codeSnippets {
        lang
        langSlug
        code
      }
    }
  }
}
"#;

const PROBLEM_DETAIL_QUERY: &str = r#"
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    title
    titleSlug
    difficulty
    content
    codeSnippets {
      lang
      langSlug
      code
    }
  }
}
"#;

pub(crate) async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    let client = leetcode_client()?;
    let body = post_graphql(&client, "dailyProblem", DAILY_PROBLEM_QUERY, json!({})).await?;
    parse_daily_problem(&body)
}

/// Fetch one problem by its public frontend number.
///
/// LeetCode's current problemset GraphQL query requires authentication, while
/// the public problem index still exposes the number-to-slug mapping. Resolve
/// the slug from that index first, then use the same unauthenticated question
/// detail query that powers the daily card.
pub(crate) async fn fetch_problem_by_number(frontend_id: &str) -> Result<DailyProblem, String> {
    let frontend_id = normalize_frontend_id(frontend_id)?;
    let client = leetcode_client()?;
    let index_response = client
        .get(LEETCODE_PROBLEM_INDEX_URL)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Unable to reach LeetCode: {error}"))?;
    let index_status = index_response.status();
    let index_body = index_response
        .text()
        .await
        .map_err(|error| format!("Unable to read LeetCode problem index: {error}"))?;
    if !index_status.is_success() {
        return Err(format!(
            "LeetCode problem index returned HTTP {index_status}: {}",
            truncate(&index_body)
        ));
    }

    let title_slug = parse_problem_index(&index_body, &frontend_id)?;
    let detail_body = post_graphql(
        &client,
        "questionData",
        PROBLEM_DETAIL_QUERY,
        json!({ "titleSlug": title_slug }),
    )
    .await?;
    parse_problem_detail(&detail_body, &frontend_id)
}

fn leetcode_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("leetcoder/0.1 (+https://github.com/ShanePark/leetcoder)")
        .build()
        .map_err(|error| format!("Unable to create LeetCode HTTP client: {error}"))
}

async fn post_graphql(
    client: &reqwest::Client,
    operation_name: &str,
    query: &str,
    variables: Value,
) -> Result<String, String> {
    let response = client
        .post(LEETCODE_GRAPHQL_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, "https://leetcode.com")
        .header(REFERER, "https://leetcode.com/")
        .json(&json!({
            "operationName": operation_name,
            "query": query,
            "variables": variables
        }))
        .send()
        .await
        .map_err(|error| format!("Unable to reach LeetCode: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Unable to read LeetCode response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "LeetCode returned HTTP {status}: {}",
            truncate(&body)
        ));
    }
    Ok(body)
}

pub(crate) fn parse_daily_problem(body: &str) -> Result<DailyProblem, String> {
    let response: Value = serde_json::from_str(body)
        .map_err(|error| format!("LeetCode returned invalid JSON: {error}"))?;
    if let Some(errors) = response.get("errors") {
        if errors.as_array().is_some_and(|items| !items.is_empty()) {
            return Err(format!(
                "LeetCode GraphQL error: {}",
                truncate(&errors.to_string())
            ));
        }
    }

    let challenge = response
        .pointer("/data/activeDailyCodingChallengeQuestion")
        .and_then(Value::as_object)
        .ok_or_else(|| "LeetCode did not return an active daily challenge".to_string())?;
    let question = challenge
        .get("question")
        .and_then(Value::as_object)
        .ok_or_else(|| "LeetCode daily challenge has no question metadata".to_string())?;

    let date = required_string(challenge.get("date"), "date")?;
    let title_slug = required_string(question.get("titleSlug"), "titleSlug")?;
    let link = challenge
        .get("link")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(normalize_link)
        .unwrap_or_else(|| format!("https://leetcode.com/problems/{title_slug}/"));
    parse_question_metadata(question, date, link)
}

pub(crate) fn parse_problem_index(body: &str, frontend_id: &str) -> Result<String, String> {
    let response: Value = serde_json::from_str(body)
        .map_err(|error| format!("LeetCode returned invalid problem index JSON: {error}"))?;
    let problems = response
        .get("stat_status_pairs")
        .and_then(Value::as_array)
        .ok_or_else(|| "LeetCode problem index is missing stat_status_pairs".to_string())?;

    problems
        .iter()
        .filter_map(|entry| entry.get("stat").and_then(Value::as_object))
        .find_map(|stat| {
            let number = stat
                .get("frontend_question_id")
                .or_else(|| stat.get("questionFrontendId"))
                .and_then(value_to_string)?;
            if normalize_frontend_id(&number).ok().as_deref() != Some(frontend_id) {
                return None;
            }
            stat.get("question__title_slug")
                .or_else(|| stat.get("titleSlug"))
                .and_then(Value::as_str)
                .filter(|slug| !slug.trim().is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| format!("LeetCode problem #{frontend_id} was not found"))
}

pub(crate) fn parse_problem_detail(
    body: &str,
    expected_frontend_id: &str,
) -> Result<DailyProblem, String> {
    let response: Value = serde_json::from_str(body)
        .map_err(|error| format!("LeetCode returned invalid JSON: {error}"))?;
    if let Some(errors) = response.get("errors") {
        if errors.as_array().is_some_and(|items| !items.is_empty()) {
            return Err(format!(
                "LeetCode GraphQL error: {}",
                truncate(&errors.to_string())
            ));
        }
    }
    let question = response
        .pointer("/data/question")
        .and_then(Value::as_object)
        .ok_or_else(|| "LeetCode did not return that problem".to_string())?;
    let number = question
        .get("questionFrontendId")
        .or_else(|| question.get("frontendQuestionId"))
        .and_then(value_to_string)
        .ok_or_else(|| "LeetCode response is missing questionFrontendId".to_string())?;
    let normalized_number = normalize_frontend_id(&number)?;
    if normalized_number != expected_frontend_id {
        return Err(format!(
            "LeetCode returned problem #{normalized_number} while looking up #{expected_frontend_id}"
        ));
    }
    let title_slug = required_string(question.get("titleSlug"), "titleSlug")?;
    let url = format!("https://leetcode.com/problems/{title_slug}/");
    parse_question_metadata(question, String::new(), url)
}

fn parse_question_metadata(
    question: &Map<String, Value>,
    date: String,
    url: String,
) -> Result<DailyProblem, String> {
    let number = question
        .get("questionFrontendId")
        .or_else(|| question.get("frontendQuestionId"))
        .and_then(value_to_string)
        .ok_or_else(|| "LeetCode response is missing questionFrontendId".to_string())?;
    let title = required_string(question.get("title"), "title")?;
    let difficulty = required_string(question.get("difficulty"), "difficulty")?;
    let title_slug = required_string(question.get("titleSlug"), "titleSlug")?;
    let content = question
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let java_code_snippet = question
        .get("codeSnippets")
        .and_then(Value::as_array)
        .and_then(|snippets| {
            snippets.iter().find_map(|snippet| {
                let language = snippet
                    .get("langSlug")
                    .or_else(|| snippet.get("lang"))
                    .and_then(Value::as_str)?;
                if language.eq_ignore_ascii_case("java") {
                    snippet
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        });

    Ok(DailyProblem {
        date,
        frontend_id: number,
        title,
        difficulty,
        title_slug,
        url,
        java_snippet: java_code_snippet,
        content,
    })
}

fn normalize_frontend_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|character| character.is_ascii_digit()) {
        return Err("The LeetCode problem number must contain only digits.".to_string());
    }
    let normalized = trimmed.trim_start_matches('0');
    if normalized.is_empty() {
        return Err("The LeetCode problem number must be greater than zero.".to_string());
    }
    Ok(normalized.to_string())
}

fn required_string(value: Option<&Value>, field: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("LeetCode response is missing {field}"))
}

fn value_to_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|number| number.to_string()))
}

fn normalize_link(link: &str) -> String {
    if link.starts_with("https://") || link.starts_with("http://") {
        link.to_string()
    } else if link.starts_with('/') {
        format!("https://leetcode.com{link}")
    } else {
        format!("https://leetcode.com/{link}")
    }
}

fn truncate(value: &str) -> String {
    const MAX_CHARS: usize = 1_000;
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_metadata_and_java_snippet() {
        let body = r#"{
          "data": {
            "activeDailyCodingChallengeQuestion": {
              "date": "2026-08-22",
              "link": "/problems/check-divisibility-by-digit-sum-and-product/",
              "question": {
                "questionFrontendId": "3622",
                "title": "Check Divisibility by Digit Sum and Product",
                "titleSlug": "check-divisibility-by-digit-sum-and-product",
                "difficulty": "Easy",
                "content": "<p>You are given a positive integer <code>n</code>.</p>",
                "codeSnippets": [
                  {"lang": "C++", "langSlug": "cpp", "code": "class Solution {};"},
                  {"lang": "Java", "langSlug": "java", "code": "class Solution { public boolean check(int n) { return true; } }"}
                ]
              }
            }
          }
        }"#;
        let problem = parse_daily_problem(body).unwrap();
        assert_eq!(problem.frontend_id, "3622");
        assert_eq!(problem.title, "Check Divisibility by Digit Sum and Product");
        assert_eq!(problem.difficulty, "Easy");
        assert_eq!(
            problem.java_snippet.as_deref(),
            Some("class Solution { public boolean check(int n) { return true; } }")
        );
        assert_eq!(
            problem.content.as_deref(),
            Some("<p>You are given a positive integer <code>n</code>.</p>")
        );
    }

    #[test]
    fn missing_java_snippet_is_not_an_error() {
        let body = r#"{
          "data": {
            "activeDailyCodingChallengeQuestion": {
              "date": "2026-08-22",
              "question": {
                "questionFrontendId": 1,
                "title": "One",
                "titleSlug": "one",
                "difficulty": "Easy",
                "codeSnippets": [{"langSlug": "python3", "code": "class Solution: pass"}]
              }
            }
          }
        }"#;
        let problem = parse_daily_problem(body).unwrap();
        assert!(problem.java_snippet.is_none());
        assert!(problem.content.is_none());
        assert_eq!(problem.url, "https://leetcode.com/problems/one/");
    }

    #[test]
    fn null_or_blank_content_is_none() {
        let template = |content: &str| {
            format!(
                r#"{{
                  "data": {{
                    "activeDailyCodingChallengeQuestion": {{
                      "date": "2026-08-22",
                      "question": {{
                        "questionFrontendId": "1",
                        "title": "One",
                        "titleSlug": "one",
                        "difficulty": "Easy",
                        "content": {content}
                      }}
                    }}
                  }}
                }}"#
            )
        };
        assert!(parse_daily_problem(&template("null"))
            .unwrap()
            .content
            .is_none());
        assert!(parse_daily_problem(&template(r#""  \n  ""#))
            .unwrap()
            .content
            .is_none());
    }

    #[test]
    fn graphql_errors_and_missing_data_are_reported() {
        let errors = r#"{"errors":[{"message":"Unauthenticated"}]}"#;
        assert!(parse_daily_problem(errors)
            .unwrap_err()
            .contains("GraphQL error"));
        assert!(
            parse_daily_problem(r#"{"data":{"activeDailyCodingChallengeQuestion":null}}"#)
                .unwrap_err()
                .contains("active daily challenge")
        );
    }

    #[test]
    fn resolves_a_problem_slug_from_the_public_index_by_exact_number() {
        let body = r#"{
          "stat_status_pairs": [
            {"stat": {"frontend_question_id": 11, "question__title_slug": "container-with-most-water"}},
            {"stat": {"frontend_question_id": 1, "question__title_slug": "two-sum"}}
          ]
        }"#;
        assert_eq!(parse_problem_index(body, "1").unwrap(), "two-sum");
        assert!(parse_problem_index(body, "10").unwrap_err().contains("#10"));
    }

    #[test]
    fn parses_a_manual_problem_detail_without_a_daily_date() {
        let body = r#"{
          "data": {
            "question": {
              "questionFrontendId": "1",
              "title": "Two Sum",
              "titleSlug": "two-sum",
              "difficulty": "Easy",
              "content": "<p>Find two numbers.</p>",
              "codeSnippets": [
                {"langSlug": "python3", "code": "class Solution: pass"},
                {"langSlug": "java", "code": "class Solution { public int[] twoSum(int[] nums, int target) { return null; } }"}
              ]
            }
          }
        }"#;
        let problem = parse_problem_detail(body, "1").unwrap();
        assert_eq!(problem.date, "");
        assert_eq!(problem.frontend_id, "1");
        assert_eq!(problem.title, "Two Sum");
        assert_eq!(problem.url, "https://leetcode.com/problems/two-sum/");
        assert!(problem.java_snippet.is_some());
    }

    #[test]
    fn rejects_a_manual_detail_when_the_returned_number_does_not_match() {
        let body = r#"{
          "data": {"question": {
            "questionFrontendId": "2",
            "title": "Add Two Numbers",
            "titleSlug": "add-two-numbers",
            "difficulty": "Medium"
          }}
        }"#;
        assert!(parse_problem_detail(body, "1")
            .unwrap_err()
            .contains("returned problem #2"));
    }

    #[test]
    fn rejects_missing_or_graphql_error_manual_details() {
        assert!(parse_problem_detail(r#"{"data":{"question":null}}"#, "1")
            .unwrap_err()
            .contains("did not return that problem"));
        assert!(
            parse_problem_detail(r#"{"errors":[{"message":"Unauthenticated"}]}"#, "1")
                .unwrap_err()
                .contains("GraphQL error")
        );
    }

    #[test]
    fn rejects_invalid_manual_problem_numbers() {
        assert!(normalize_frontend_id("abc").is_err());
        assert!(normalize_frontend_id("0").is_err());
        assert_eq!(normalize_frontend_id("001").unwrap(), "1");
    }
}

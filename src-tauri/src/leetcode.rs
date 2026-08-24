use reqwest::header::{ACCEPT, CONTENT_TYPE, ORIGIN, REFERER};
use serde_json::{json, Value};

use crate::models::DailyProblem;

const LEETCODE_GRAPHQL_URL: &str = "https://leetcode.com/graphql";
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

pub(crate) async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("leetcoder/0.1 (+https://github.com/ShanePark/leetcoder)")
        .build()
        .map_err(|error| format!("Unable to create LeetCode HTTP client: {error}"))?;
    let response = client
        .post(LEETCODE_GRAPHQL_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(ORIGIN, "https://leetcode.com")
        .header(REFERER, "https://leetcode.com/")
        .json(&json!({
            "operationName": "dailyProblem",
            "query": DAILY_PROBLEM_QUERY,
            "variables": {}
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

    parse_daily_problem(&body)
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
    let number = question
        .get("questionFrontendId")
        .or_else(|| question.get("frontendQuestionId"))
        .and_then(value_to_string)
        .ok_or_else(|| "LeetCode response is missing questionFrontendId".to_string())?;
    let title = required_string(question.get("title"), "title")?;
    let difficulty = required_string(question.get("difficulty"), "difficulty")?;
    let title_slug = required_string(question.get("titleSlug"), "titleSlug")?;
    let link = challenge
        .get("link")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(normalize_link)
        .unwrap_or_else(|| format!("https://leetcode.com/problems/{title_slug}/"));

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
        url: link,
        java_snippet: java_code_snippet,
        content,
    })
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
}

use serde_json::{Map, Value};

use crate::models::DailyProblem;

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

pub(super) fn normalize_frontend_id(value: &str) -> Result<String, String> {
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

pub(super) fn truncate(value: &str) -> String {
    const MAX_CHARS: usize = 1_000;
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

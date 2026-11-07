use reqwest::header::{ACCEPT, CONTENT_TYPE, ORIGIN, REFERER};
use serde_json::{json, Value};
use std::error::Error;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use crate::models::DailyProblem;

use super::request_log::{self, RequestAttempt, RequestOutcome};
use super::{parse_daily_problem, parse_problem_detail};

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

static LEETCODE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static REQUEST_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_request_log_dir(dir: PathBuf) {
    let _ = REQUEST_LOG_DIR.set(dir);
}

pub(crate) async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    let client = leetcode_client()?;
    send_logged(
        "daily",
        graphql_request(&client, "dailyProblem", DAILY_PROBLEM_QUERY, json!({})),
        parse_daily_problem,
    )
    .await
}

/// Fetch one problem by the title slug from its URL. A slug that could not be one
/// is refused before anything is sent.
pub(crate) async fn fetch_problem_by_slug(title_slug: &str) -> Result<DailyProblem, String> {
    validate_title_slug(title_slug)?;
    let client = leetcode_client()?;
    send_logged(
        &format!("detail {title_slug}"),
        graphql_request(
            &client,
            "questionData",
            PROBLEM_DETAIL_QUERY,
            json!({ "titleSlug": title_slug }),
        ),
        parse_problem_detail,
    )
    .await
}

pub(super) fn validate_title_slug(title_slug: &str) -> Result<(), String> {
    let valid = !title_slug.is_empty()
        && title_slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(
            "The LeetCode problem slug may contain only lowercase letters, digits, and hyphens."
                .to_string(),
        )
    }
}

pub(super) fn leetcode_client() -> Result<reqwest::Client, String> {
    if let Some(client) = LEETCODE_CLIENT.get() {
        return Ok(client.clone());
    }

    let candidate = build_leetcode_client()?;
    if LEETCODE_CLIENT.set(candidate.clone()).is_ok() {
        Ok(candidate)
    } else {
        // Another caller initialized the client while this one was building.
        Ok(LEETCODE_CLIENT
            .get()
            .expect("client set after a competing initialization")
            .clone())
    }
}

pub(super) fn build_leetcode_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("leetcoder/0.1 (+https://github.com/ShanePark/leetcoder)")
        .build()
        .map_err(|error| format!("Unable to create LeetCode HTTP client: {error}"))
}

fn graphql_request(
    client: &reqwest::Client,
    operation_name: &str,
    query: &str,
    variables: Value,
) -> reqwest::RequestBuilder {
    client
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
}

async fn send_logged<T>(
    operation: &str,
    request: reqwest::RequestBuilder,
    parse: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    let (result, attempt) = attempt_request(request, parse).await;
    request_log::record(
        REQUEST_LOG_DIR.get().map(PathBuf::as_path),
        operation,
        &attempt,
    );
    result
}

pub(super) async fn attempt_request<T>(
    request: reqwest::RequestBuilder,
    parse: impl FnOnce(&str) -> Result<T, String>,
) -> (Result<T, String>, RequestAttempt) {
    let started = Instant::now();
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Unable to reach LeetCode: {error}");
            let attempt = RequestAttempt {
                status: None,
                challenge: None,
                elapsed_ms: started.elapsed().as_millis(),
                outcome: RequestOutcome::Failed(failure_cause(error)),
            };
            return (Err(message), attempt);
        }
    };

    let status = response.status();
    let challenge = response
        .headers()
        .get("cf-mitigated")
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
    let body = response.text().await;
    let elapsed_ms = started.elapsed().as_millis();
    let (result, outcome) = match body {
        Err(error) => (
            Err(format!("Unable to read LeetCode response: {error}")),
            RequestOutcome::Failed(failure_cause(error)),
        ),
        // The body can be a whole HTML page, so it goes to the log and not the UI.
        Ok(body) if !status.is_success() => {
            let bot_check = if challenge.is_some() {
                " (bot check)"
            } else {
                ""
            };
            (
                Err(format!("LeetCode returned HTTP {status}{bot_check}")),
                RequestOutcome::Failed(body),
            )
        }
        Ok(body) => match parse(&body) {
            Ok(value) => (Ok(value), RequestOutcome::Ok),
            Err(error) => (Err(error.clone()), RequestOutcome::ParseError(error)),
        },
    };
    let attempt = RequestAttempt {
        status: Some(status.as_u16()),
        challenge,
        elapsed_ms,
        outcome,
    };
    (result, attempt)
}

/// The top-level error only names the kind of failure. What separates a timeout from
/// a DNS or connection failure is in its sources, and the operation implies the URL.
fn failure_cause(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut cause = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        cause.push_str(&format!(": {inner}"));
        source = inner.source();
    }
    cause
}

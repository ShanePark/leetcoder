use reqwest::header::{ACCEPT, CONTENT_TYPE, ORIGIN, REFERER};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use crate::models::DailyProblem;

use super::parsing::{normalize_frontend_id, truncate};
use super::request_log::{self, RequestAttempt, RequestOutcome};
use super::slug_cache::SlugResolver;
use super::{parse_daily_problem, parse_problem_detail, parse_problem_index};

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

/// How the error returned to the UI starts when a response cannot be used.
pub(super) struct ResponseErrors {
    unreadable: &'static str,
    rejected: &'static str,
}

pub(super) const GRAPHQL_ERRORS: ResponseErrors = ResponseErrors {
    unreadable: "Unable to read LeetCode response",
    rejected: "LeetCode returned",
};
const INDEX_ERRORS: ResponseErrors = ResponseErrors {
    unreadable: "Unable to read LeetCode problem index",
    rejected: "LeetCode problem index returned",
};

static LEETCODE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SLUG_RESOLVER: SlugResolver = SlugResolver::new();
static REQUEST_LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_request_log_dir(dir: PathBuf) {
    let _ = REQUEST_LOG_DIR.set(dir);
}

pub(crate) async fn fetch_daily_problem() -> Result<DailyProblem, String> {
    let client = leetcode_client()?;
    send_logged(
        "daily",
        graphql_request(&client, "dailyProblem", DAILY_PROBLEM_QUERY, json!({})),
        &GRAPHQL_ERRORS,
        parse_daily_problem,
    )
    .await
}

/// Fetch one problem by its public frontend number.
///
/// LeetCode's current problemset GraphQL query requires authentication, while
/// the public problem index still exposes the number-to-slug mapping. Resolve
/// the slug through a cache of that index, then use the same unauthenticated
/// question detail query that powers the daily card.
pub(crate) async fn fetch_problem_by_number(
    frontend_id: &str,
    cache_dir: &Path,
) -> Result<DailyProblem, String> {
    let frontend_id = normalize_frontend_id(frontend_id)?;
    let client = leetcode_client()?;
    let title_slug = SLUG_RESOLVER
        .resolve(cache_dir, &frontend_id, Instant::now(), || {
            fetch_problem_index(&client)
        })
        .await?;
    send_logged(
        &format!("detail {title_slug}"),
        graphql_request(
            &client,
            "questionData",
            PROBLEM_DETAIL_QUERY,
            json!({ "titleSlug": title_slug }),
        ),
        &GRAPHQL_ERRORS,
        |body| parse_problem_detail(body, &frontend_id),
    )
    .await
}

async fn fetch_problem_index(client: &reqwest::Client) -> Result<BTreeMap<String, String>, String> {
    send_logged(
        "index",
        client
            .get(LEETCODE_PROBLEM_INDEX_URL)
            .header(ACCEPT, "application/json"),
        &INDEX_ERRORS,
        parse_problem_index,
    )
    .await
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
    errors: &ResponseErrors,
    parse: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    let (result, attempt) = attempt_request(request, errors, parse).await;
    request_log::record(
        REQUEST_LOG_DIR.get().map(PathBuf::as_path),
        operation,
        &attempt,
    );
    result
}

pub(super) async fn attempt_request<T>(
    request: reqwest::RequestBuilder,
    errors: &ResponseErrors,
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
            Err(format!("{}: {error}", errors.unreadable)),
            RequestOutcome::Failed(failure_cause(error)),
        ),
        Ok(body) if !status.is_success() => (
            Err(format!(
                "{} HTTP {status}: {}",
                errors.rejected,
                truncate(&body)
            )),
            RequestOutcome::Failed(body),
        ),
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

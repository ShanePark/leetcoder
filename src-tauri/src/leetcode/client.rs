use reqwest::header::{ACCEPT, CONTENT_TYPE, ORIGIN, REFERER};
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::models::DailyProblem;

use super::parsing::{normalize_frontend_id, truncate};
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

static LEETCODE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

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

use super::client::{attempt_request, build_leetcode_client, leetcode_client, validate_title_slug};
use super::parsing::normalize_frontend_id;
use super::request_log::{self, format_line, utc_timestamp, RequestAttempt, RequestOutcome};
use super::*;
use serde_json::Value;
use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::thread;
use std::time::Instant;

#[test]
#[ignore = "manual performance benchmark"]
fn benchmark_client_creation() {
    fn median_ns<F>(mut operation: F) -> u128
    where
        F: FnMut(),
    {
        for _ in 0..10 {
            operation();
        }
        let mut samples = Vec::with_capacity(30);
        for _ in 0..30 {
            let start = Instant::now();
            operation();
            samples.push(start.elapsed().as_nanos());
        }
        samples.sort_unstable();
        samples[samples.len() / 2]
    }

    let uncached_ns = median_ns(|| {
        black_box(build_leetcode_client().unwrap());
    });
    let client_ns = median_ns(|| {
        black_box(leetcode_client().unwrap());
    });
    eprintln!(
        "leetcode benchmark median_ns uncached_client={uncached_ns} cached_client={client_ns}"
    );
}

#[test]
#[ignore = "manual performance benchmark"]
fn benchmark_client_connection_reuse() {
    const REQUESTS: usize = 12;

    fn spawn_server(requests: usize) -> (String, thread::JoinHandle<usize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut accepted_connections = 0;
            let mut served_requests = 0;
            while served_requests < requests {
                let (mut stream, _) = listener.accept().unwrap();
                accepted_connections += 1;
                stream
                    .set_read_timeout(Some(std::time::Duration::from_millis(100)))
                    .unwrap();
                while served_requests < requests {
                    if !read_request(&mut stream) {
                        break;
                    }
                    stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
                            )
                            .unwrap();
                    stream.flush().unwrap();
                    served_requests += 1;
                }
            }
            accepted_connections
        });
        (address, handle)
    }

    fn read_request(stream: &mut TcpStream) -> bool {
        let mut request = Vec::with_capacity(512);
        let mut chunk = [0_u8; 256];
        loop {
            let read = match stream.read(&mut chunk) {
                Ok(read) => read,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return false
                }
                Err(_) => return false,
            };
            if read == 0 {
                return false;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return true;
            }
        }
    }

    async fn request(client: &reqwest::Client, url: &str) {
        client.get(url).send().await.unwrap().text().await.unwrap();
    }

    let (fresh_url, fresh_server) = spawn_server(REQUESTS);
    let fresh_start = Instant::now();
    tauri::async_runtime::block_on(async {
        for _ in 0..REQUESTS {
            let client = build_leetcode_client().unwrap();
            request(&client, &fresh_url).await;
        }
    });
    let fresh_elapsed = fresh_start.elapsed().as_nanos();
    let fresh_connections = fresh_server.join().unwrap();

    let (shared_url, shared_server) = spawn_server(REQUESTS);
    let shared_client = leetcode_client().unwrap();
    let shared_start = Instant::now();
    tauri::async_runtime::block_on(async {
        for _ in 0..REQUESTS {
            request(&shared_client, &shared_url).await;
        }
    });
    let shared_elapsed = shared_start.elapsed().as_nanos();
    let shared_connections = shared_server.join().unwrap();

    eprintln!(
            "leetcode benchmark requests={REQUESTS} fresh_connections={fresh_connections} shared_connections={shared_connections} fresh_ns={fresh_elapsed} shared_ns={shared_elapsed}"
        );
    assert_eq!(fresh_connections, REQUESTS);
    assert_eq!(shared_connections, 1);
}

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
    let problem = parse_problem_detail(body).unwrap();
    assert_eq!(problem.date, "");
    assert_eq!(problem.frontend_id, "1");
    assert_eq!(problem.title, "Two Sum");
    assert_eq!(problem.url, "https://leetcode.com/problems/two-sum/");
    assert!(problem.java_snippet.is_some());
}

#[test]
fn takes_the_number_of_a_manual_detail_from_the_response() {
    let body = r#"{
          "data": {"question": {
            "questionFrontendId": "2",
            "title": "Add Two Numbers",
            "titleSlug": "add-two-numbers",
            "difficulty": "Medium"
          }}
        }"#;
    assert_eq!(parse_problem_detail(body).unwrap().frontend_id, "2");
}

#[test]
fn rejects_missing_or_graphql_error_manual_details() {
    assert!(parse_problem_detail(r#"{"data":{"question":null}}"#)
        .unwrap_err()
        .contains("did not return that problem"));
    assert!(
        parse_problem_detail(r#"{"errors":[{"message":"Unauthenticated"}]}"#)
            .unwrap_err()
            .contains("GraphQL error")
    );
}

#[test]
fn rejects_a_manual_detail_with_an_unusable_number() {
    let body = r#"{
          "data": {"question": {
            "questionFrontendId": "abc",
            "title": "Odd",
            "titleSlug": "odd",
            "difficulty": "Easy"
          }}
        }"#;
    assert!(parse_problem_detail(body)
        .unwrap_err()
        .contains("only digits"));
}

#[test]
fn rejects_invalid_manual_problem_numbers() {
    assert!(normalize_frontend_id("abc").is_err());
    assert!(normalize_frontend_id("0").is_err());
    assert_eq!(normalize_frontend_id("001").unwrap(), "1");
}

#[test]
fn accepts_only_a_title_slug_pattern() {
    for slug in [
        "two-sum",
        "3sum",
        "a",
        "minimum-moves-to-equal-array-elements-iii",
    ] {
        assert_eq!(validate_title_slug(slug), Ok(()), "{slug}");
    }
    for slug in [
        "",
        " ",
        "1 ",
        "Two-Sum",
        "two_sum",
        "two/sum",
        "../two-sum",
        "two-sum\n",
        "two-sum?x=1",
        "\u{e9}",
        "https://leetcode.com/problems/two-sum/",
    ] {
        assert!(validate_title_slug(slug).is_err(), "{slug:?}");
    }
}

const LOG_TIME: u64 = 1_793_681_052;

fn attempt(status: Option<u16>, outcome: RequestOutcome) -> RequestAttempt {
    RequestAttempt {
        status,
        challenge: None,
        elapsed_ms: 312,
        outcome,
    }
}

fn read_log(directory: &Path) -> String {
    std::fs::read_to_string(directory.join("leetcode-requests.log")).unwrap()
}

#[test]
fn formats_a_request_log_line_for_each_outcome() {
    assert_eq!(
        format_line(LOG_TIME, "daily", &attempt(Some(200), RequestOutcome::Ok)),
        "2026-11-03T04:44:12Z daily http=200 ok 312ms"
    );
    assert_eq!(
        format_line(
            LOG_TIME,
            "detail two-sum",
            &attempt(Some(200), RequestOutcome::Ok)
        ),
        "2026-11-03T04:44:12Z detail two-sum http=200 ok 312ms"
    );
    assert_eq!(
        format_line(
            LOG_TIME,
            "detail two-sum",
            &RequestAttempt {
                challenge: Some("challenge".to_string()),
                ..attempt(
                    Some(403),
                    RequestOutcome::Failed("Just a moment...".to_string())
                )
            }
        ),
        "2026-11-03T04:44:12Z detail two-sum http=403 failed 312ms challenge=challenge Just a moment..."
    );
    assert_eq!(
        format_line(
            LOG_TIME,
            "daily",
            &attempt(None, RequestOutcome::Failed("error sending".to_string()))
        ),
        "2026-11-03T04:44:12Z daily network-error failed 312ms error sending"
    );
    assert_eq!(
        format_line(
            LOG_TIME,
            "daily",
            &attempt(
                Some(200),
                RequestOutcome::ParseError("no daily".to_string())
            )
        ),
        "2026-11-03T04:44:12Z daily http=200 parse-error 312ms no daily"
    );
    assert_eq!(
        format_line(
            LOG_TIME,
            "daily",
            &attempt(Some(502), RequestOutcome::Failed(" \n".to_string()))
        ),
        "2026-11-03T04:44:12Z daily http=502 failed 312ms"
    );
}

#[test]
fn formats_known_utc_timestamps() {
    for (seconds, expected) in [
        (0, "1970-01-01T00:00:00Z"),
        (951_782_400, "2000-02-29T00:00:00Z"),
        (1_709_164_800, "2024-02-29T00:00:00Z"),
        (1_709_251_199, "2024-02-29T23:59:59Z"),
        (1_709_251_200, "2024-03-01T00:00:00Z"),
        (1_767_225_599, "2025-12-31T23:59:59Z"),
        (4_107_542_400, "2100-03-01T00:00:00Z"),
        (LOG_TIME, "2026-11-03T04:44:12Z"),
    ] {
        assert_eq!(utc_timestamp(seconds), expected);
    }
}

#[test]
fn a_cause_is_collapsed_to_one_line_and_truncated() {
    let collapsed = format_line(
        LOG_TIME,
        "detail two\nsum",
        &RequestAttempt {
            challenge: Some("chal\r\nlenge".to_string()),
            ..attempt(
                Some(500),
                RequestOutcome::Failed("Bad\r\n  gateway\t\u{2028}\0here".to_string()),
            )
        },
    );
    assert_eq!(
        collapsed,
        "2026-11-03T04:44:12Z detail two sum http=500 failed 312ms challenge=chal lenge Bad gateway here"
    );

    let long = format_line(
        LOG_TIME,
        "daily",
        &attempt(Some(500), RequestOutcome::Failed("é".repeat(500))),
    );
    let cause = long.rsplit(' ').next().unwrap();
    assert_eq!(cause, format!("{}…", "é".repeat(120)));
    assert_eq!(long.lines().count(), 1);
}

#[test]
fn concurrent_appends_keep_whole_lines() {
    let directory = tempfile::tempdir().unwrap();
    let writers: Vec<_> = (0..8)
        .map(|writer| {
            let path = directory.path().to_path_buf();
            thread::spawn(move || {
                let entry = attempt(Some(500), RequestOutcome::Failed("x".repeat(100)));
                for _ in 0..25 {
                    request_log::record(Some(&path), &format!("detail w{writer}"), &entry);
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }

    let log = read_log(directory.path());
    assert!(log.ends_with('\n'));
    assert_eq!(log.lines().count(), 200);
    let cause = "x".repeat(100);
    for line in log.lines() {
        assert!(line.contains(" detail w"), "{line}");
        assert!(
            line.ends_with(&format!(" http=500 failed 312ms {cause}")),
            "{line}"
        );
    }
}

#[test]
fn recording_creates_the_log_directory() {
    let directory = tempfile::tempdir().unwrap();
    let nested = directory.path().join("logs").join("deeper");
    request_log::record(
        Some(&nested),
        "daily",
        &attempt(Some(200), RequestOutcome::Ok),
    );
    assert!(read_log(&nested).ends_with(" daily http=200 ok 312ms\n"));
}

#[test]
fn recording_without_a_directory_does_nothing() {
    request_log::record(None, "daily", &attempt(Some(200), RequestOutcome::Ok));
}

#[test]
fn an_unwritable_log_directory_is_ignored() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("a-file");
    std::fs::write(&file, "").unwrap();
    request_log::record(
        Some(&file.join("logs")),
        "daily",
        &attempt(Some(200), RequestOutcome::Ok),
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "");
}

/// Answers one request on a local port with a fixed raw response.
fn serve_once(response: &'static str) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 256];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                return;
            }
            request.extend_from_slice(&chunk[..read]);
        }
        stream.write_all(response.as_bytes()).unwrap();
    });
    url
}

fn attempt_against(url: &str) -> (Result<String, String>, String) {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (result, mut attempt) =
        tauri::async_runtime::block_on(attempt_request(client.get(url), |body| {
            let value: Value = serde_json::from_str(body).map_err(|error| error.to_string())?;
            match value.get("errors") {
                Some(errors) => Err(format!("LeetCode GraphQL error: {errors}")),
                None => Ok(body.to_string()),
            }
        }));
    attempt.elapsed_ms = 7;
    (result, format_line(LOG_TIME, "daily", &attempt))
}

#[test]
fn a_successful_response_logs_no_body() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"data\":\"a\"}",
    ));
    assert_eq!(result.unwrap(), "{\"data\":\"a\"}");
    assert_eq!(line, "2026-11-03T04:44:12Z daily http=200 ok 7ms");
}

#[test]
fn a_refused_response_logs_its_status_challenge_and_cause() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 403 Forbidden\r\ncf-mitigated: challenge\r\nContent-Length: 17\r\nConnection: close\r\n\r\nJust a\nmoment...\n",
    ));
    assert_eq!(
        result.unwrap_err(),
        "LeetCode returned HTTP 403 Forbidden (bot check)"
    );
    assert_eq!(
        line,
        "2026-11-03T04:44:12Z daily http=403 failed 7ms challenge=challenge Just a moment..."
    );
}

#[test]
fn a_refused_response_without_a_challenge_shows_only_its_status() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<html></html>",
    ));
    assert_eq!(
        result.unwrap_err(),
        "LeetCode returned HTTP 429 Too Many Requests"
    );
    assert_eq!(
        line,
        "2026-11-03T04:44:12Z daily http=429 failed 7ms <html></html>"
    );
}

#[test]
fn a_refused_html_page_stays_out_of_the_ui_error() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 403 Forbidden\r\ncf-mitigated: challenge\r\nContent-Length: 35\r\nConnection: close\r\n\r\n<html><title>Just a</title></html>\n",
    ));
    let error = result.unwrap_err();
    assert!(!error.contains('<'), "{error}");
    assert!(!error.contains("Just a"), "{error}");
    assert!(
        line.contains("<html><title>Just a</title></html>"),
        "{line}"
    );
}

#[test]
fn a_success_status_with_graphql_errors_logs_a_parse_error() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"errors\":1}",
    ));
    assert_eq!(result.unwrap_err(), "LeetCode GraphQL error: 1");
    assert_eq!(
        line,
        "2026-11-03T04:44:12Z daily http=200 parse-error 7ms LeetCode GraphQL error: 1"
    );
}

#[test]
fn a_cut_off_body_logs_the_status_with_a_failure() {
    let (result, line) = attempt_against(&serve_once(
        "HTTP/1.1 200 OK\r\nContent-Length: 50\r\nConnection: close\r\n\r\nshort",
    ));
    assert!(result
        .unwrap_err()
        .starts_with("Unable to read LeetCode response: "));
    assert!(
        line.starts_with("2026-11-03T04:44:12Z daily http=200 failed 7ms error decoding"),
        "{line}"
    );
}

#[test]
fn a_connection_failure_logs_a_network_error_with_its_cause() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);

    let (result, line) = attempt_against(&url);
    let error = result.unwrap_err();
    assert!(error.starts_with("Unable to reach LeetCode: error sending request for url"));
    assert!(
        line.starts_with(
            "2026-11-03T04:44:12Z daily network-error failed 7ms error sending request: "
        ),
        "{line}"
    );
    assert!(!line.contains(&url), "{line}");
    assert!(line.contains("onnect"), "{line}");
}

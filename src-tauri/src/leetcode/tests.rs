use super::client::{build_leetcode_client, leetcode_client};
use super::parsing::normalize_frontend_id;
use super::*;
use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
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

use super::claude::{self, ApiError, Capabilities, CatalogModel, ReplyOutcome, ResolvedModel};
use super::key_store::{self, ApiKey};
use super::ledger::{self, UsageRecord};
use super::prices::{self, CachedPrice, PriceCache, Prices};
use super::*;
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};
use tauri::async_runtime::block_on;
use tempfile::TempDir;

const SECRET: &str = "sk-test-secret-value";

fn fixture() -> (TempDir, AiPaths) {
    let root = tempfile::tempdir().unwrap();
    let paths = AiPaths {
        config: root.path().join("config"),
        data: root.path().join("data"),
        cache: root.path().join("cache"),
    };
    (root, paths)
}

fn keyed_fixture() -> (TempDir, AiPaths) {
    let (root, paths) = fixture();
    key_store::save(&paths.config, &ApiKey::new(SECRET).unwrap()).unwrap();
    (root, paths)
}

fn http(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).unwrap_or(0);
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&request);
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if request.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

/// Serves one canned response per connection and returns the captured requests.
fn serve(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        for response in responses {
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        requests.push(read_request(&mut stream));
                        // A client that stops reading early, as the size cap does, is fine.
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                        break;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        if Instant::now() > deadline {
                            return requests;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept failed: {error}"),
                }
            }
        }
        requests
    });
    (base_url, handle)
}

/// A listener that is never accepted from, so a test can prove nothing connected.
fn silent_server() -> (String, TcpListener) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    (
        format!("http://{}", listener.local_addr().unwrap()),
        listener,
    )
}

fn assert_no_connection(listener: &TcpListener) {
    let error = listener.accept().err().expect("nothing should connect");
    assert_eq!(error.kind(), ErrorKind::WouldBlock);
}

fn unreachable_url() -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

fn request_body(request: &str) -> Value {
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn api_model(id: &str, line: Option<&str>, created_at: &str) -> Value {
    json!({
        "id": id,
        "display_name": id.to_uppercase(),
        "created_at": created_at,
        "lifecycle": "active",
        "line": line,
        "capabilities": {
            "structured_outputs": { "supported": true },
            "effort": { "supported": true, "low": { "supported": true } },
        },
    })
}

fn models_page(models: &[Value], has_more: bool, last_id: Option<&str>) -> String {
    http(
        200,
        &json!({ "data": models, "has_more": has_more, "last_id": last_id }).to_string(),
    )
}

fn sonnet_catalog() -> String {
    models_page(
        &[api_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z")],
        false,
        Some("model-a"),
    )
}

fn catalog_model(id: &str, line: Option<&str>, created_at: &str) -> CatalogModel {
    CatalogModel {
        id: id.to_string(),
        display_name: id.to_string(),
        created_at: created_at.to_string(),
        lifecycle: "active".to_string(),
        line: line.map(str::to_string),
        capabilities: Some(Capabilities {
            structured_outputs: true,
            effort_low: true,
        }),
    }
}

fn store_models(paths: &AiPaths, models: Vec<CatalogModel>) {
    claude::store_catalog(&paths.cache, models).unwrap();
}

fn generate_request(selected: Option<&str>) -> AiGenerateRequest {
    AiGenerateRequest {
        selected_model_id: selected.map(str::to_string),
        problem_title: "Two Sum".to_string(),
        problem_content: "<p>Example 1</p>".to_string(),
        entry_point: Some("int[] twoSum(int[] nums, int target)".to_string()),
        method_headers: vec!["int[] twoSum(int[] nums, int target)".to_string()],
        java_snippet: None,
        ps_signatures: vec!["int[][] Ps.intArray(String)".to_string()],
    }
}

fn message_reply(stop_reason: &str, text: &str) -> String {
    http(
        200,
        &json!({
            "model": "model-a",
            "stop_reason": stop_reason,
            "content": [{ "type": "text", "text": text }],
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 500,
                "cache_read_input_tokens": 20,
                "cache_creation_input_tokens": 10,
                "inference_geo": "global",
                "speed": "standard",
                "service_tier": "standard",
            },
        })
        .to_string(),
    )
}

fn refusal_reply(stop_details: Value) -> String {
    http(
        200,
        &json!({
            "model": "model-a",
            "stop_reason": "refusal",
            "stop_details": stop_details,
            "usage": { "input_tokens": 1000, "output_tokens": 500 },
        })
        .to_string(),
    )
}

/// Promises more body than it sends, so the read fails once the connection closes.
const CUT_OFF_SUCCESS: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"model\":";

fn record(model: &str, ts: i64, outcome: &str, prices: Option<Prices>) -> UsageRecord {
    UsageRecord {
        v: ledger::current_version(),
        ts,
        provider: "anthropic".to_string(),
        model: model.to_string(),
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        outcome: outcome.to_string(),
        inference_geo: Some("global".to_string()),
        speed: Some("standard".to_string()),
        service_tier: Some("standard".to_string()),
        stop_category: None,
        prices,
        prices_fetched_at: prices.map(|_| 1),
    }
}

const PRICE_2_10: Prices = Prices {
    input: 2.0,
    output: 10.0,
    cache_read: Some(0.2),
    cache_write: Some(2.5),
};

// Key store

#[test]
fn api_key_debug_is_redacted() {
    let key = ApiKey::new(SECRET).unwrap();
    assert!(!format!("{key:?}").contains(SECRET));
}

#[test]
fn api_key_rejects_blank_and_unsendable_values_without_echoing_them() {
    assert!(ApiKey::new("   ").is_err());
    let error = ApiKey::new("sk-bad\u{7f}value").unwrap_err();
    assert!(!error.contains("sk-bad"));
    assert_eq!(ApiKey::new("  sk-x \n").unwrap().expose(), "sk-x");
    assert_eq!(ApiKey::new("\tsk-a\r\nb c ").unwrap().expose(), "sk-abc");
}

#[test]
fn key_file_uses_the_documented_format_and_replaces_atomically() {
    let (_root, paths) = fixture();
    key_store::save(&paths.config, &ApiKey::new("sk-one").unwrap()).unwrap();
    key_store::save(&paths.config, &ApiKey::new("sk-two").unwrap()).unwrap();
    let file = paths.config.join("ai-credentials.json");
    let stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        stored,
        json!({ "anthropic": { "kind": "apiKey", "apiKey": "sk-two" } })
    );
    assert_eq!(fs::read_dir(&paths.config).unwrap().count(), 1);
    let loaded = key_store::load(&paths.config).unwrap().unwrap();
    assert_eq!(loaded.expose(), "sk-two");
}

#[cfg(unix)]
#[test]
fn key_file_is_0600_even_when_replacing_a_loose_file() {
    use std::os::unix::fs::PermissionsExt;
    let (_root, paths) = fixture();
    fs::create_dir_all(&paths.config).unwrap();
    let file = paths.config.join("ai-credentials.json");
    fs::write(&file, "{}").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    key_store::save(&paths.config, &ApiKey::new(SECRET).unwrap()).unwrap();
    let mode = fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn corrupt_key_file_reads_as_unconfigured_and_never_quotes_its_contents() {
    let (_root, paths) = fixture();
    fs::create_dir_all(&paths.config).unwrap();
    fs::write(
        paths.config.join("ai-credentials.json"),
        format!("{{\"anthropic\":\"{SECRET}\"}}"),
    )
    .unwrap();
    let error = key_store::load(&paths.config).unwrap_err();
    assert!(!error.contains(SECRET));
    assert!(!status(&paths).configured);
}

#[test]
fn clearing_the_key_keeps_the_ledger_and_tolerates_a_missing_file() {
    let (_root, paths) = keyed_fixture();
    ledger::append(&paths.data, &record("model-a", 1, "ok", None)).unwrap();
    assert!(status(&paths).configured);
    key_store::clear(&paths.config).unwrap();
    key_store::clear(&paths.config).unwrap();
    assert!(!status(&paths).configured);
    assert_eq!(ledger::read(&paths.data).unwrap().0.len(), 1);
}

// Key-bearing client

#[test]
fn key_is_a_sensitive_per_request_header() {
    let client = claude::build_key_client(false).unwrap();
    let key = ApiKey::new(SECRET).unwrap();
    let request = claude::authorized(client.get("http://127.0.0.1/"), &key)
        .unwrap()
        .build()
        .unwrap();
    let value = request.headers().get("x-api-key").unwrap();
    assert!(value.is_sensitive());
    assert_eq!(value.to_str().unwrap(), SECRET);
    assert_eq!(
        request.headers().get("anthropic-version").unwrap(),
        "2026-10-21"
    );
    assert!(client
        .get("http://127.0.0.1/")
        .build()
        .unwrap()
        .headers()
        .get("x-api-key")
        .is_none());
}

#[test]
fn production_client_settings_refuse_plain_http_without_connecting() {
    let (base_url, listener) = silent_server();
    let client = claude::build_key_client(true).unwrap();
    let key = ApiKey::new(SECRET).unwrap();
    let result = block_on(
        claude::authorized(client.get(&base_url), &key)
            .unwrap()
            .send(),
    );
    assert!(result.is_err());
    assert_no_connection(&listener);
}

#[test]
fn redirects_are_errors_and_are_not_followed() {
    let (target_url, target) = silent_server();
    let (base_url, server) = serve(vec![format!(
        "HTTP/1.1 302 Found\r\nLocation: {target_url}/v1/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )]);
    let key = ApiKey::new(SECRET).unwrap();
    let error = block_on(claude::fetch_models(&base_url, &key)).unwrap_err();
    assert_eq!(
        error,
        ApiError::Status {
            status: 302,
            error_type: None
        }
    );
    assert_eq!(server.join().unwrap().len(), 1);
    assert_no_connection(&target);
}

#[test]
fn errors_expose_only_status_and_a_clean_error_type() {
    let body = json!({
        "error": { "type": "authentication_error", "message": format!("bad key {SECRET}") }
    });
    let (base_url, server) = serve(vec![http(401, &body.to_string())]);
    let key = ApiKey::new(SECRET).unwrap();
    let error = block_on(claude::fetch_models(&base_url, &key)).unwrap_err();
    server.join().unwrap();
    let text = error.to_string();
    assert!(text.contains("401") && text.contains("authentication_error"));
    assert!(!text.contains(SECRET) && !text.contains("bad key"));

    let smuggled = json!({ "error": { "type": format!("oops {SECRET}") } });
    let (base_url, server) = serve(vec![http(500, &smuggled.to_string())]);
    let error = block_on(claude::fetch_models(&base_url, &key)).unwrap_err();
    server.join().unwrap();
    assert_eq!(
        error,
        ApiError::Status {
            status: 500,
            error_type: None
        }
    );
    assert!(!error.to_string().contains(SECRET));
}

// No key, no traffic

#[test]
fn without_a_key_nothing_touches_the_network() {
    let (_root, paths) = fixture();
    let (base_url, listener) = silent_server();

    assert!(!status(&paths).configured);
    assert!(block_on(generate_tests(&base_url, &paths, &generate_request(None))).is_err());
    let list = block_on(list_models(&base_url, &paths, true));
    assert!(list.models.is_empty() && list.error.is_none());
    assert!(!block_on(refresh_prices_if_keyed(&base_url, &paths)).unwrap());
    usage(&paths, &[]).unwrap();

    assert_no_connection(&listener);
}

// Catalog

#[test]
fn catalog_paginates_to_the_end_with_the_key_on_every_page() {
    let (_root, paths) = keyed_fixture();
    let (base_url, server) = serve(vec![
        models_page(
            &[api_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z")],
            true,
            Some("model-a"),
        ),
        models_page(
            &[api_model("model-b", Some("opus"), "2026-08-01T00:00:00Z")],
            false,
            Some("model-b"),
        ),
    ]);
    let list = block_on(list_models(&base_url, &paths, true));
    let requests = server.join().unwrap();

    assert!(requests[0].starts_with("GET /v1/models?limit=1000 "));
    assert!(requests[1].starts_with("GET /v1/models?limit=1000&after_id=model-a "));
    for request in &requests {
        assert_eq!(header(request, "x-api-key"), Some(SECRET));
        assert_eq!(header(request, "anthropic-version"), Some("2026-10-21"));
    }
    assert_eq!(list.error, None);
    assert_eq!(list.default_model_id.as_deref(), Some("model-a"));
    let ids: Vec<_> = list.models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(ids, ["model-a", "model-b"]);
    assert_eq!(list.models[0].display_name, "MODEL-A");
    assert!(list.fetched_at.is_some());
}

#[test]
fn only_structured_output_models_are_listed_and_deprecated_ones_are_marked() {
    let (_root, paths) = keyed_fixture();
    let mut unsupported = api_model("model-plain", Some("sonnet"), "2026-10-01T00:00:00Z");
    unsupported["capabilities"]["structured_outputs"]["supported"] = json!(false);
    let mut no_capabilities = api_model("model-null", Some("sonnet"), "2026-10-02T00:00:00Z");
    no_capabilities["capabilities"] = Value::Null;
    let mut deprecated = api_model("model-old", Some("sonnet"), "2026-10-03T00:00:00Z");
    deprecated["lifecycle"] = json!("deprecated");
    let (base_url, server) = serve(vec![models_page(
        &[
            unsupported,
            no_capabilities,
            deprecated,
            api_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z"),
        ],
        false,
        None,
    )]);
    let list = block_on(list_models(&base_url, &paths, true));
    server.join().unwrap();
    let listed: Vec<_> = list
        .models
        .iter()
        .map(|model| (model.id.as_str(), model.deprecated))
        .collect();
    assert_eq!(listed, [("model-old", true), ("model-a", false)]);
    assert_eq!(list.default_model_id.as_deref(), Some("model-a"));
}

#[test]
fn failed_empty_and_truncated_refreshes_keep_the_cache() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-kept",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let responses = [
        vec![http(500, "{}")],
        vec![models_page(&[], false, None)],
        vec![
            models_page(
                &[api_model(
                    "model-new",
                    Some("sonnet"),
                    "2026-10-01T00:00:00Z",
                )],
                true,
                Some("model-new"),
            ),
            http(503, "{}"),
        ],
        vec![models_page(
            &[api_model(
                "model-new",
                Some("sonnet"),
                "2026-10-01T00:00:00Z",
            )],
            true,
            None,
        )],
    ];
    for response in responses {
        let (base_url, server) = serve(response);
        let list = block_on(list_models(&base_url, &paths, true));
        server.join().unwrap();
        assert!(list.error.is_some());
        let ids: Vec<_> = list.models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["model-kept"]);
    }
}

#[test]
fn listing_without_refresh_uses_the_cache_and_makes_no_request() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, listener) = silent_server();
    let list = block_on(list_models(&base_url, &paths, false));
    assert_eq!(list.models.len(), 1);
    assert_no_connection(&listener);
}

#[test]
fn only_the_newest_model_of_each_line_is_not_superseded() {
    let mut deprecated = catalog_model("haiku-deprecated", Some("haiku"), "2026-09-01T00:00:00Z");
    deprecated.lifecycle = "deprecated".to_string();
    let mut only_deprecated =
        catalog_model("mini-deprecated", Some("mini"), "2026-09-01T00:00:00Z");
    only_deprecated.lifecycle = "deprecated".to_string();
    let mut retired = catalog_model("opus-retired", Some("opus"), "2026-12-01T00:00:00Z");
    retired.lifecycle = "retired".to_string();
    let mut unlisted = catalog_model("opus-unlisted", Some("opus"), "2026-11-01T00:00:00Z");
    unlisted.capabilities = None;
    let models = vec![
        catalog_model("sonnet-old", Some("sonnet"), "2026-06-01T00:00:00Z"),
        catalog_model("sonnet-new", Some("sonnet"), "2026-09-01T00:00:00Z"),
        catalog_model("opus-new", Some("opus"), "2026-08-01T00:00:00Z"),
        catalog_model("opus-old", Some("opus"), "2026-02-01T00:00:00Z"),
        retired,
        unlisted,
        deprecated,
        catalog_model("haiku-active", Some("haiku"), "2026-01-01T00:00:00Z"),
        only_deprecated,
        catalog_model("no-line-a", None, "2026-01-01T00:00:00Z"),
        catalog_model("no-line-b", None, "2026-02-01T00:00:00Z"),
    ];

    let superseded: Vec<(String, bool)> = claude::listed_models(&models)
        .into_iter()
        .map(|model| (model.id, model.superseded))
        .collect();

    assert_eq!(
        superseded,
        [
            ("sonnet-old", true),
            ("sonnet-new", false),
            ("opus-new", false),
            ("opus-old", true),
            ("haiku-deprecated", true),
            ("haiku-active", false),
            ("mini-deprecated", false),
            ("no-line-a", false),
            ("no-line-b", false),
        ]
        .map(|(id, superseded)| (id.to_string(), superseded))
    );
    // A pin on an older version keeps working after it leaves the picker.
    assert_eq!(
        claude::resolve_model(Some(&models), Some("sonnet-old")),
        Some(ResolvedModel {
            served: "sonnet-old".to_string(),
            fell_back: false,
        })
    );
}

#[test]
fn default_is_the_newest_active_sonnet_with_ties_by_list_order() {
    let mut retired = catalog_model("retired", Some("sonnet"), "2026-12-01T00:00:00Z");
    retired.lifecycle = "retired".to_string();
    let mut deprecated = catalog_model("deprecated", Some("sonnet"), "2026-11-01T00:00:00Z");
    deprecated.lifecycle = "deprecated".to_string();
    let mut no_capabilities = catalog_model("no-caps", Some("sonnet"), "2026-11-01T00:00:00Z");
    no_capabilities.capabilities = None;
    let models = vec![
        retired,
        deprecated,
        no_capabilities,
        catalog_model("no-line", None, "2026-11-01T00:00:00Z"),
        catalog_model("opus", Some("opus"), "2026-11-01T00:00:00Z"),
        catalog_model("older", Some("sonnet"), "2026-01-01T00:00:00Z"),
        catalog_model("newest", Some("sonnet"), "2026-09-01T00:00:00Z"),
    ];
    assert_eq!(claude::default_model(&models).unwrap().id, "newest");

    let epoch_ties = vec![
        catalog_model("first", Some("sonnet"), "1970-01-01T00:00:00Z"),
        catalog_model("second", Some("sonnet"), "1970-01-01T00:00:00Z"),
    ];
    assert_eq!(claude::default_model(&epoch_ties).unwrap().id, "first");
    assert!(claude::default_model(&[catalog_model("opus", Some("opus"), "2026")]).is_none());
}

#[test]
fn resolver_keeps_pins_falls_back_only_on_a_known_list_and_reports_it() {
    let models = vec![
        catalog_model("sonnet", Some("sonnet"), "2026-09-01T00:00:00Z"),
        catalog_model("opus", Some("opus"), "2026-09-01T00:00:00Z"),
    ];
    let resolved = |served: &str, fell_back| {
        Some(ResolvedModel {
            served: served.to_string(),
            fell_back,
        })
    };
    assert_eq!(
        claude::resolve_model(Some(&models), Some("opus")),
        resolved("opus", false)
    );
    assert_eq!(
        claude::resolve_model(Some(&models), None),
        resolved("sonnet", false)
    );
    assert_eq!(
        claude::resolve_model(Some(&models), Some("gone")),
        resolved("sonnet", true)
    );
    assert_eq!(
        claude::resolve_model(None, Some("opus")),
        resolved("opus", false)
    );
    assert_eq!(claude::resolve_model(None, None), None);
    let opus_only = vec![catalog_model("opus", Some("opus"), "2026-09-01T00:00:00Z")];
    assert_eq!(claude::resolve_model(Some(&opus_only), Some("gone")), None);
    assert_eq!(claude::resolve_model(Some(&opus_only), None), None);
}

// Saving a key

#[test]
fn a_rejected_key_is_not_saved() {
    let (_root, paths) = fixture();
    let (base_url, server) = serve(vec![http(
        401,
        r#"{"error":{"type":"authentication_error","message":"nope"}}"#,
    )]);
    let error = block_on(save_key(&base_url, &paths, SECRET)).unwrap_err();
    server.join().unwrap();
    assert!(error.contains("401") && !error.contains(SECRET));
    assert!(!status(&paths).configured);
}

#[test]
fn a_verified_key_is_saved_and_fills_the_catalog() {
    let (_root, paths) = fixture();
    let (base_url, server) = serve(vec![sonnet_catalog()]);
    let result = block_on(save_key(&base_url, &paths, SECRET)).unwrap();
    server.join().unwrap();
    assert!(result.verified);
    assert!(status(&paths).configured);
    assert!(claude::load_catalog(&paths.cache).is_some());
}

#[test]
fn a_network_failure_saves_the_key_unverified() {
    let (_root, paths) = fixture();
    let result = block_on(save_key(&unreachable_url(), &paths, SECRET)).unwrap();
    assert!(!result.verified);
    assert!(status(&paths).configured);
}

// Generating

#[test]
fn request_carries_the_documented_headers_limits_and_schema() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, server) = serve(vec![message_reply(
        "end_turn",
        r#"{"statements":["assertThat(f(1)).isEqualTo(2);"]}"#,
    )]);
    let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    let requests = server.join().unwrap();

    assert_eq!(result.outcome, "ok");
    assert_eq!(result.statements, ["assertThat(f(1)).isEqualTo(2);"]);
    assert_eq!(result.served_model, "model-a");
    assert!(!result.fell_back);

    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /v1/messages "));
    assert_eq!(header(&requests[0], "x-api-key"), Some(SECRET));
    assert_eq!(
        header(&requests[0], "anthropic-version"),
        Some("2026-10-21")
    );
    let body = request_body(&requests[0]);
    assert_eq!(body["model"], "model-a");
    assert_eq!(body["max_tokens"], 16000);
    assert_eq!(body["output_config"]["effort"], "low");
    assert_eq!(body["output_config"]["format"]["type"], "json_schema");
    assert_eq!(
        body["output_config"]["format"]["schema"],
        json!({
            "type": "object",
            "properties": { "statements": { "type": "array", "items": { "type": "string" } } },
            "required": ["statements"],
            "additionalProperties": false,
        })
    );
    for absent in [
        "thinking",
        "temperature",
        "top_p",
        "top_k",
        "fallbacks",
        "stream",
    ] {
        assert!(body.get(absent).is_none(), "{absent} must not be sent");
    }
    let message = body["messages"][0]["content"].as_str().unwrap();
    assert!(message.contains("<problem>\nTwo Sum\n<p>Example 1</p>\n</problem>"));
    assert!(message.contains("<entry_point>\nint[] twoSum"));
    assert!(message.contains("<method_headers>\nint[] twoSum"));
    assert!(message.contains("<helpers>\nint[][] Ps.intArray(String)\n</helpers>"));
}

#[test]
fn effort_is_omitted_when_the_model_does_not_support_it() {
    let (_root, paths) = keyed_fixture();
    let mut model = catalog_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z");
    model.capabilities = Some(Capabilities {
        structured_outputs: true,
        effort_low: false,
    });
    store_models(&paths, vec![model]);
    let (base_url, server) = serve(vec![message_reply("end_turn", r#"{"statements":[]}"#)]);
    block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    let requests = server.join().unwrap();
    assert!(request_body(&requests[0])["output_config"]
        .get("effort")
        .is_none());
}

#[test]
fn effort_capability_parses_from_the_api_shape() {
    let (_root, paths) = keyed_fixture();
    let mut no_low = api_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z");
    no_low["capabilities"]["effort"]["low"]["supported"] = json!(false);
    let mut no_effort = api_model("model-b", Some("opus"), "2026-09-01T00:00:00Z");
    no_effort["capabilities"]["effort"]["supported"] = json!(false);
    let (base_url, server) = serve(vec![models_page(
        &[
            no_low,
            no_effort,
            api_model("model-c", Some("haiku"), "2026-09-01T00:00:00Z"),
        ],
        false,
        None,
    )]);
    block_on(list_models(&base_url, &paths, true));
    server.join().unwrap();
    let catalog = claude::load_catalog(&paths.cache).unwrap();
    assert!(!catalog.effort_low("model-a"));
    assert!(!catalog.effort_low("model-b"));
    assert!(catalog.effort_low("model-c"));
}

#[test]
fn refusal_is_checked_before_content_and_records_tokens_and_dollars() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    write_price_cache(&paths, "model-a", PRICE_2_10);
    let (base_url, server) = serve(vec![message_reply(
        "refusal",
        r#"{"statements":["assertThat(x).isTrue();"]}"#,
    )]);
    let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    server.join().unwrap();

    assert_eq!(result.outcome, "refused");
    assert!(result.statements.is_empty());
    let (records, _) = ledger::read(&paths.data).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, "refused");
    assert_eq!(records[0].input_tokens, 1000);

    let summary = usage(&paths, &[]).unwrap();
    assert_eq!(summary.all_time.refused_requests, 1);
    assert_eq!(summary.all_time.input_tokens, 1000);
    assert!((summary.all_time.cost_usd - 0.007029).abs() < 1e-9);
    assert_eq!(summary.all_time.unpriced_requests, 0);
}

#[test]
fn the_stop_category_is_stored_and_never_changes_the_outcome() {
    for category in ["cyber", "something_new"] {
        let (_root, paths) = keyed_fixture();
        store_models(
            &paths,
            vec![catalog_model(
                "model-a",
                Some("sonnet"),
                "2026-09-01T00:00:00Z",
            )],
        );
        let (base_url, server) = serve(vec![refusal_reply(json!({ "category": category }))]);
        let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
        server.join().unwrap();
        assert_eq!(result.outcome, "refused");
        let raw = fs::read_to_string(paths.data.join("ai-usage.jsonl")).unwrap();
        let stored: Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(stored["stopCategory"], category);
        assert_eq!(stored["outcome"], "refused");
    }
}

#[test]
fn stop_details_can_be_absent_null_or_any_shape() {
    let parsed = |body: Value| claude::parse_reply(&body, "model-a");
    assert_eq!(
        parsed(json!({ "stop_reason": "refusal" })).stop_category,
        None
    );
    let unusable = [
        Value::Null,
        json!({}),
        json!({ "category": null }),
        json!({ "category": 7 }),
        json!("cyber"),
    ];
    for stop_details in unusable {
        let reply = parsed(json!({ "stop_reason": "refusal", "stop_details": stop_details }));
        assert_eq!(reply.stop_category, None);
        assert_eq!(reply.outcome, ReplyOutcome::Refused);
    }
    let reply = parsed(json!({
        "stop_reason": "refusal",
        "stop_details": { "type": "refusal", "category": "bio" },
    }));
    assert_eq!(reply.stop_category.as_deref(), Some("bio"));
    assert_eq!(reply.outcome, ReplyOutcome::Refused);
}

#[test]
fn max_tokens_maps_to_truncated_and_records_usage() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, server) = serve(vec![message_reply("max_tokens", r#"{"statements":["#)]);
    let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    server.join().unwrap();
    assert_eq!(result.outcome, "truncated");
    assert!(result.statements.is_empty());
    assert_eq!(ledger::read(&paths.data).unwrap().0[0].outcome, "truncated");
}

#[test]
fn unreadable_output_is_an_error_that_still_records_usage() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, server) = serve(vec![message_reply("end_turn", "not json")]);
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    server.join().unwrap();
    assert!(error.contains("model-a"));
    let (records, _) = ledger::read(&paths.data).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].outcome, "invalid");
    assert_eq!(records[0].output_tokens, 500);
}

fn assert_one_zero_token_invalid_entry(paths: &AiPaths, model: &str) {
    let (records, skipped) = ledger::read(&paths.data).unwrap();
    assert_eq!(skipped, 0);
    assert_eq!(records.len(), 1);
    let entry = &records[0];
    assert_eq!(entry.model, model);
    assert_eq!(entry.outcome, "invalid");
    assert_eq!(
        (
            entry.input_tokens,
            entry.output_tokens,
            entry.cache_read_tokens,
            entry.cache_write_tokens,
        ),
        (0, 0, 0, 0)
    );
}

#[test]
fn a_success_body_that_cannot_be_parsed_records_a_zero_token_invalid_entry() {
    // Valid apart from its size, so only the cap can reject it.
    let oversized = json!({
        "model": "model-other",
        "stop_reason": "end_turn",
        "padding": "x".repeat(8 * 1024 * 1024),
    })
    .to_string();
    let responses = [
        http(200, "<html>not json</html>"),
        http(200, ""),
        http(200, "[1, 2, 3]"),
        http(200, "\"text\""),
        http(200, &oversized),
    ];
    for response in responses {
        let (_root, paths) = keyed_fixture();
        store_models(
            &paths,
            vec![
                catalog_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z"),
                catalog_model("model-pin", Some("opus"), "2026-09-01T00:00:00Z"),
            ],
        );
        let (base_url, server) = serve(vec![response]);
        let error = block_on(generate_tests(
            &base_url,
            &paths,
            &generate_request(Some("model-pin")),
        ))
        .unwrap_err();
        assert_eq!(server.join().unwrap().len(), 1);
        assert_eq!(error, ApiError::Malformed.to_string());
        assert_one_zero_token_invalid_entry(&paths, "model-pin");
    }
}

#[test]
fn a_success_body_cut_off_mid_read_records_a_zero_token_invalid_entry() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, server) = serve(vec![CUT_OFF_SUCCESS.to_string()]);
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    server.join().unwrap();
    assert_eq!(error, ApiError::Network { timed_out: false }.to_string());
    assert_one_zero_token_invalid_entry(&paths, "model-a");
}

#[test]
fn a_response_that_is_not_a_success_records_nothing_even_when_unparseable() {
    for status_code in [302, 401, 429, 500, 529] {
        let (_root, paths) = keyed_fixture();
        store_models(
            &paths,
            vec![catalog_model(
                "model-a",
                Some("sonnet"),
                "2026-09-01T00:00:00Z",
            )],
        );
        let (base_url, server) = serve(vec![http(status_code, "<html>not json</html>")]);
        let error =
            block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
        server.join().unwrap();
        assert!(error.contains(&status_code.to_string()));
        assert!(ledger::read(&paths.data).unwrap().0.is_empty());
    }
}

// The generation request's limit

#[test]
fn a_timed_out_generation_says_it_may_have_been_charged() {
    assert_eq!(claude::MESSAGE_TIMEOUT, Duration::from_secs(300));
    let (base_url, _listener) = silent_server();
    let key = ApiKey::new(SECRET).unwrap();
    let error = block_on(claude::send_message_within(
        &base_url,
        &key,
        "model-a",
        false,
        &generate_request(None),
        Duration::from_millis(200),
    ))
    .unwrap_err();
    assert_eq!(error, ApiError::MessageTimedOut);
    let text = error.to_string();
    assert!(text.contains("may still have been charged"));
    assert!(!text.contains(SECRET));
}

#[test]
fn a_generation_timing_out_mid_body_is_an_unreadable_reply_that_may_have_been_charged() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        read_request(&mut stream);
        stream.write_all(CUT_OFF_SUCCESS.as_bytes()).unwrap();
        stream.flush().unwrap();
        // Holds the connection open until the client gives up.
        let _ = stream.read(&mut [0_u8; 1]);
    });
    let key = ApiKey::new(SECRET).unwrap();
    let reply = block_on(claude::send_message_within(
        &base_url,
        &key,
        "model-a",
        false,
        &generate_request(None),
        Duration::from_millis(300),
    ))
    .unwrap();
    server.join().unwrap();
    assert_eq!(reply.model, "model-a");
    assert_eq!(reply.usage, claude::MessageUsage::default());
    assert_eq!(
        reply.outcome,
        ReplyOutcome::Unreadable(ApiError::MessageTimedOut)
    );
}

#[test]
fn a_catalog_timeout_says_nothing_about_charges() {
    let text = ApiError::Network { timed_out: true }.to_string();
    assert!(!text.contains("charged"));
}

#[test]
fn the_ledger_is_written_with_usage_fields_and_cached_prices_before_returning() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    write_price_cache(&paths, "model-a", PRICE_2_10);
    let (base_url, server) = serve(vec![message_reply("end_turn", r#"{"statements":[]}"#)]);
    block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    server.join().unwrap();

    let raw = fs::read_to_string(paths.data.join("ai-usage.jsonl")).unwrap();
    assert!(raw.starts_with('\n'));
    let stored: Value = serde_json::from_str(raw.trim()).unwrap();
    assert_eq!(stored["v"], 1);
    assert!(stored["ts"].as_i64().unwrap() > 0);
    assert_eq!(stored["provider"], "anthropic");
    assert_eq!(stored["model"], "model-a");
    assert_eq!(stored["inputTokens"], 1000);
    assert_eq!(stored["outputTokens"], 500);
    assert_eq!(stored["cacheReadTokens"], 20);
    assert_eq!(stored["cacheWriteTokens"], 10);
    assert_eq!(stored["outcome"], "ok");
    assert_eq!(stored["inferenceGeo"], "global");
    assert_eq!(stored["speed"], "standard");
    assert_eq!(stored["serviceTier"], "standard");
    assert_eq!(stored.get("stopCategory"), Some(&Value::Null));
    assert_eq!(stored["prices"]["input"], 2.0);
    assert_eq!(stored["pricesFetchedAt"], 1);
}

#[test]
fn a_ledger_failure_never_discards_the_result() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    fs::create_dir_all(paths.data.parent().unwrap()).unwrap();
    fs::write(&paths.data, "a file where the data directory belongs").unwrap();
    let (base_url, server) = serve(vec![message_reply(
        "end_turn",
        r#"{"statements":["assertThat(f(1)).isEqualTo(2);"]}"#,
    )]);
    let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    server.join().unwrap();
    assert_eq!(result.statements.len(), 1);
}

#[test]
fn a_rejected_model_refreshes_once_and_is_named_without_switching() {
    for status_code in [400, 403, 404] {
        let (_root, paths) = keyed_fixture();
        store_models(
            &paths,
            vec![
                catalog_model("model-pin", Some("opus"), "2026-09-01T00:00:00Z"),
                catalog_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z"),
            ],
        );
        let (base_url, server) = serve(vec![
            http(status_code, r#"{"error":{"type":"not_found_error"}}"#),
            sonnet_catalog(),
        ]);
        let error = block_on(generate_tests(
            &base_url,
            &paths,
            &generate_request(Some("model-pin")),
        ))
        .unwrap_err();
        let requests = server.join().unwrap();
        assert!(error.contains("model-pin") && error.contains(&status_code.to_string()));
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("POST /v1/messages "));
        assert!(requests[1].starts_with("GET /v1/models"));
        assert!(ledger::read(&paths.data).unwrap().0.is_empty());
    }
}

#[test]
fn other_failures_do_not_refresh_and_never_include_the_key() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let body = json!({ "error": { "type": "rate_limit_error", "message": SECRET } });
    let (base_url, server) = serve(vec![http(429, &body.to_string())]);
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(error.contains("429") && error.contains("rate_limit_error"));
    assert!(!error.contains(SECRET));
}

#[test]
fn a_pin_that_left_the_list_falls_back_and_reports_it() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, server) = serve(vec![message_reply("end_turn", r#"{"statements":[]}"#)]);
    let result = block_on(generate_tests(
        &base_url,
        &paths,
        &generate_request(Some("model-gone")),
    ))
    .unwrap();
    let requests = server.join().unwrap();
    assert!(result.fell_back);
    assert_eq!(result.served_model, "model-a");
    assert_eq!(request_body(&requests[0])["model"], "model-a");
}

#[test]
fn an_ai_call_refreshes_a_stale_catalog_but_not_a_fresh_one() {
    let (_root, paths) = keyed_fixture();
    let stale = claude::Catalog {
        fetched_at: now_ms() - DAY_MS - 1,
        models: vec![catalog_model(
            "model-old",
            Some("sonnet"),
            "2026-01-01T00:00:00Z",
        )],
    };
    write_cache_file(
        &paths.cache.join("ai-models-anthropic.json"),
        &serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    let (base_url, server) = serve(vec![
        sonnet_catalog(),
        message_reply("end_turn", r#"{"statements":[]}"#),
    ]);
    let result = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("GET /v1/models"));
    assert_eq!(request_body(&requests[1])["model"], "model-a");
    assert_eq!(result.served_model, "model-a");

    let (base_url, server) = serve(vec![message_reply("end_turn", r#"{"statements":[]}"#)]);
    block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap();
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn a_failed_stale_refresh_still_serves_from_the_cached_list() {
    let (_root, paths) = keyed_fixture();
    let stale = claude::Catalog {
        fetched_at: now_ms() - DAY_MS - 1,
        models: vec![catalog_model(
            "model-a",
            Some("sonnet"),
            "2026-01-01T00:00:00Z",
        )],
    };
    write_cache_file(
        &paths.cache.join("ai-models-anthropic.json"),
        &serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    let (base_url, server) = serve(vec![
        http(500, "{}"),
        message_reply("end_turn", r#"{"statements":[]}"#),
    ]);
    let result = block_on(generate_tests(
        &base_url,
        &paths,
        &generate_request(Some("model-a")),
    ))
    .unwrap();
    server.join().unwrap();
    assert!(!result.fell_back);
    assert_eq!(result.served_model, "model-a");
}

#[test]
fn no_default_and_no_pin_asks_the_user_to_choose_without_sending() {
    let (_root, paths) = keyed_fixture();
    store_models(
        &paths,
        vec![catalog_model(
            "model-b",
            Some("opus"),
            "2026-09-01T00:00:00Z",
        )],
    );
    let (base_url, listener) = silent_server();
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    assert!(error.contains("Choose a model"));
    assert_no_connection(&listener);
}

#[test]
fn a_failed_refresh_with_nothing_to_resolve_reports_its_cause_and_sends_nothing() {
    let (_root, paths) = keyed_fixture();
    let (base_url, server) = serve(vec![http(
        401,
        r#"{"error":{"type":"authentication_error","message":"nope"}}"#,
    )]);
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    let requests = server.join().unwrap();
    assert!(error.contains("401") && error.contains("authentication_error"));
    assert!(!error.contains("Choose a model") && !error.contains("nope"));
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /v1/models"));
    assert!(ledger::read(&paths.data).unwrap().0.is_empty());

    let error = block_on(generate_tests(
        &unreachable_url(),
        &paths,
        &generate_request(None),
    ))
    .unwrap_err();
    assert_eq!(error, ApiError::Network { timed_out: false }.to_string());
    assert!(ledger::read(&paths.data).unwrap().0.is_empty());
}

#[test]
fn a_failed_stale_refresh_is_reported_when_the_cached_list_cannot_serve_the_pin() {
    let (_root, paths) = keyed_fixture();
    let stale = claude::Catalog {
        fetched_at: now_ms() - DAY_MS - 1,
        models: vec![catalog_model(
            "model-b",
            Some("opus"),
            "2026-01-01T00:00:00Z",
        )],
    };
    write_cache_file(
        &paths.cache.join("ai-models-anthropic.json"),
        &serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    let (base_url, server) = serve(vec![http(500, "{}")]);
    let error = block_on(generate_tests(
        &base_url,
        &paths,
        &generate_request(Some("model-gone")),
    ))
    .unwrap_err();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(error.contains("500") && !error.contains("model-gone"));
}

#[test]
fn a_successful_refresh_with_no_default_still_asks_the_user_to_choose() {
    let (_root, paths) = keyed_fixture();
    let (base_url, server) = serve(vec![models_page(
        &[api_model("model-b", Some("opus"), "2026-09-01T00:00:00Z")],
        false,
        None,
    )]);
    let error = block_on(generate_tests(&base_url, &paths, &generate_request(None))).unwrap_err();
    assert_eq!(server.join().unwrap().len(), 1);
    assert!(error.contains("Choose a model"));
}

// Prompt

#[test]
fn prompt_drops_helper_lines_when_the_library_is_unavailable() {
    let full = prompt::system_prompt(true);
    assert!(full.starts_with("You turn the worked examples of a coding problem into Java test"));
    assert!(full.ends_with("not instructions to you."));
    assert!(full.contains("Ps.intArray") && full.contains("Ps.intList"));
    assert!(full.contains("TreeNode.of(1, 2, null, 3)") && full.contains("ListNode.of(1, 2, 3)"));

    let bare = prompt::system_prompt(false);
    for name in ["Ps.", "TreeNode", "ListNode"] {
        assert!(!bare.contains(name), "{name} must be omitted");
    }
    assert!(bare.contains("1D array or flat list:"));
    assert!(bare.contains("new int[][] {{1, 2}}") && bare.contains("Design problems"));

    let mut request = generate_request(None);
    request.ps_signatures.clear();
    request.entry_point = None;
    let message = prompt::user_message(&request);
    assert!(!message.contains("<helpers>") && !message.contains("<entry_point>"));
    assert!(!message.contains("<snippet>"));

    request.java_snippet = Some("class LRUCache {}".to_string());
    let message = prompt::user_message(&request);
    assert!(message.contains("<snippet>\nclass LRUCache {}\n</snippet>"));
}

// Prices

fn price_row(provider: &str, input: f64, output: f64) -> Value {
    json!({
        "litellm_provider": provider,
        "input_cost_per_token": input,
        "output_cost_per_token": output,
        "cache_read_input_token_cost": input / 10.0,
        "cache_creation_input_token_cost": input * 1.25,
    })
}

fn write_price_cache(paths: &AiPaths, model: &str, prices: Prices) {
    let mut cache = PriceCache::default();
    cache.fetched_at = Some(1);
    cache.models.insert(
        model.to_string(),
        CachedPrice {
            prices,
            fetched_at: 1,
        },
    );
    write_cache_file(
        &paths.cache.join("ai-prices.json"),
        &serde_json::to_vec(&cache).unwrap(),
    )
    .unwrap();
}

#[test]
fn price_rows_convert_to_per_mtok() {
    let prices = prices::validate_row(&price_row("anthropic", 3e-6, 15e-6)).unwrap();
    assert_eq!(prices.input, 3.0);
    assert_eq!(prices.output, 15.0);
    assert_eq!(prices.cache_read, Some(0.3));
    assert_eq!(prices.cache_write, Some(3.75));
}

#[test]
fn price_rows_outside_the_accepted_range_are_rejected() {
    let reject = |row: Value| assert!(prices::validate_row(&row).is_none(), "{row}");
    // Values already in dollars per MTok, the classic unit error.
    reject(price_row("anthropic", 3.0, 15.0));
    reject(price_row("anthropic", 1e-10, 15e-6));
    reject(price_row("anthropic", 3e-6, 1e-2));
    reject(json!({ "input_cost_per_token": "3e-06", "output_cost_per_token": 15e-6 }));
    reject(json!({ "output_cost_per_token": 15e-6 }));
    reject(json!({
        "input_cost_per_token": 3e-6,
        "output_cost_per_token": 15e-6,
        "cache_read_input_token_cost": 4e-6,
    }));
    reject(json!({
        "input_cost_per_token": 3e-6,
        "output_cost_per_token": 15e-6,
        "cache_creation_input_token_cost": "free",
    }));
    let no_cache = json!({ "input_cost_per_token": 3e-6, "output_cost_per_token": 15e-6 });
    assert_eq!(
        prices::validate_row(&no_cache).unwrap().cache_read,
        None,
        "cache prices are optional"
    );
}

#[test]
fn only_exact_rows_for_the_provider_are_kept() {
    let rows = prices::valid_rows(&json!({
        "claude-x": price_row("anthropic", 2e-6, 10e-6),
        "us.anthropic.claude-x": price_row("bedrock_converse", 2.2e-6, 11e-6),
        "claude-bad": price_row("anthropic", 2.0, 10.0),
        "sample_spec": { "litellm_provider": "one of the providers" },
    }))
    .unwrap();
    assert_eq!(rows.keys().collect::<Vec<_>>(), ["claude-x"]);
    assert_eq!(rows["claude-x"].input, 2.0);
}

#[test]
fn price_refresh_merges_keeps_last_good_prices_and_never_evicts() {
    let (_root, paths) = fixture();
    let first = json!({
        "claude-x": price_row("anthropic", 2e-6, 10e-6),
        "claude-y": price_row("anthropic", 1e-6, 5e-6),
    });
    let (url, server) = serve(vec![http(200, &first.to_string())]);
    assert!(block_on(prices::refresh_if_stale(&url, &paths.cache, DAY_MS)).unwrap());
    server.join().unwrap();

    // `claude-x` turns bad and `claude-y` disappears a day later.
    let second = json!({
        "claude-x": price_row("anthropic", 2.0, 10.0),
        "claude-z": price_row("anthropic", 4e-6, 20e-6),
    });
    let (url, server) = serve(vec![http(200, &second.to_string())]);
    assert!(block_on(prices::refresh_if_stale(&url, &paths.cache, DAY_MS * 2)).unwrap());
    server.join().unwrap();

    let cache = prices::load_cache(&paths.cache);
    assert_eq!(cache.fetched_at, Some(DAY_MS * 2));
    assert_eq!(cache.models["claude-x"].prices.input, 2.0);
    assert_eq!(cache.models["claude-x"].fetched_at, DAY_MS);
    assert_eq!(cache.models["claude-y"].prices.input, 1.0);
    assert_eq!(cache.models["claude-z"].fetched_at, DAY_MS * 2);
}

#[test]
fn bad_price_documents_never_replace_the_last_good_copy() {
    // Valid apart from its size, so only the cap can reject it.
    let oversized = json!({
        "claude-new": price_row("anthropic", 3e-6, 15e-6),
        "padding": "x".repeat(17 * 1024 * 1024),
    })
    .to_string();
    let no_usable_rows = json!({ "claude-x": price_row("anthropic", 2.0, 10.0) }).to_string();
    let responses = [
        http(500, "{}"),
        http(200, "<html>not json</html>"),
        http(200, "[1, 2, 3]"),
        http(200, &no_usable_rows),
        http(200, &oversized),
    ];
    for response in responses {
        let (_root, paths) = fixture();
        write_price_cache(&paths, "claude-x", PRICE_2_10);
        let (url, server) = serve(vec![response]);
        assert!(block_on(prices::refresh_if_stale(&url, &paths.cache, DAY_MS * 2)).is_err());
        server.join().unwrap();
        let cache = prices::load_cache(&paths.cache);
        assert_eq!(cache.fetched_at, Some(1));
        assert_eq!(cache.models["claude-x"].prices, PRICE_2_10);
    }
}

#[test]
fn price_refresh_runs_at_most_daily_even_after_a_failure() {
    let (_root, paths) = fixture();
    let (url, server) = serve(vec![http(500, "{}")]);
    assert!(block_on(prices::refresh_if_stale(&url, &paths.cache, DAY_MS)).is_err());
    server.join().unwrap();

    let (url, listener) = silent_server();
    let later = DAY_MS + DAY_MS - 1;
    assert!(!block_on(prices::refresh_if_stale(&url, &paths.cache, later)).unwrap());
    assert_no_connection(&listener);

    let (url, server) = serve(vec![http(
        200,
        &json!({ "claude-x": price_row("anthropic", 2e-6, 10e-6) }).to_string(),
    )]);
    assert!(block_on(prices::refresh_if_stale(&url, &paths.cache, DAY_MS * 2)).unwrap());
    server.join().unwrap();
}

#[test]
fn price_refresh_with_a_key_fetches_and_stores() {
    let (_root, paths) = keyed_fixture();
    let (url, server) = serve(vec![http(
        200,
        &json!({ "claude-x": price_row("anthropic", 2e-6, 10e-6) }).to_string(),
    )]);
    assert!(block_on(refresh_prices_if_keyed(&url, &paths)).unwrap());
    let requests = server.join().unwrap();
    assert_eq!(header(&requests[0], "x-api-key"), None);
    assert!(prices::load_cache(&paths.cache).fetched_at.is_some());
}

// Ledger

#[test]
fn reader_skips_blank_and_malformed_lines_and_counts_only_malformed_ones() {
    let (_root, paths) = fixture();
    ledger::append(&paths.data, &record("model-a", 1, "ok", None)).unwrap();
    let file = paths.data.join("ai-usage.jsonl");
    let mut handle = fs::OpenOptions::new().append(true).open(&file).unwrap();
    // A crash tail, an empty model, and a wrong type, followed by a good record.
    handle.write_all(b"\n{\"v\":1,\"ts\":1,\"mod").unwrap();
    handle
        .write_all(b"\n\n   \n{\"ts\":1,\"model\":\"\"}")
        .unwrap();
    handle
        .write_all(b"\n{\"ts\":\"soon\",\"model\":\"x\"}")
        .unwrap();
    ledger::append(&paths.data, &record("model-b", 2, "ok", None)).unwrap();

    let (records, skipped) = ledger::read(&paths.data).unwrap();
    let models: Vec<_> = records.iter().map(|record| record.model.as_str()).collect();
    assert_eq!(models, ["model-a", "model-b"]);
    assert_eq!(skipped, 3);
    assert_eq!(usage(&paths, &[]).unwrap().skipped_lines, 3);
}

#[test]
fn records_from_a_newer_format_with_unknown_fields_still_read() {
    let (_root, paths) = fixture();
    fs::create_dir_all(&paths.data).unwrap();
    fs::write(
        paths.data.join("ai-usage.jsonl"),
        "\n{\"v\":9,\"ts\":5,\"model\":\"model-a\",\"inputTokens\":3,\"newField\":true}",
    )
    .unwrap();
    let (records, skipped) = ledger::read(&paths.data).unwrap();
    assert_eq!(skipped, 0);
    assert_eq!(records[0].input_tokens, 3);
    assert_eq!(records[0].prices, None);
}

#[test]
fn older_lines_without_a_stop_category_still_read() {
    let (_root, paths) = fixture();
    fs::create_dir_all(&paths.data).unwrap();
    fs::write(
        paths.data.join("ai-usage.jsonl"),
        concat!(
            "\n{\"v\":1,\"ts\":1,\"model\":\"model-a\",\"outcome\":\"refused\"}",
            "\n{\"v\":1,\"ts\":2,\"model\":\"model-a\",\"stopCategory\":null}",
            "\n{\"v\":1,\"ts\":3,\"model\":\"model-a\",\"stopCategory\":\"cyber\"}",
        ),
    )
    .unwrap();
    let (records, skipped) = ledger::read(&paths.data).unwrap();
    assert_eq!(skipped, 0);
    let categories: Vec<_> = records
        .iter()
        .map(|record| record.stop_category.as_deref())
        .collect();
    assert_eq!(categories, [None, None, Some("cyber")]);
}

#[test]
fn concurrent_appends_stay_whole() {
    let (_root, paths) = fixture();
    let writers: Vec<_> = (0..8)
        .map(|writer| {
            let data = paths.data.clone();
            thread::spawn(move || {
                for index in 0..50 {
                    let model = format!("model-{writer}");
                    ledger::append(&data, &record(&model, index, "ok", None)).unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let (records, skipped) = ledger::read(&paths.data).unwrap();
    assert_eq!(records.len(), 400);
    assert_eq!(skipped, 0);
}

#[test]
fn a_missing_ledger_is_an_empty_summary() {
    let (_root, paths) = fixture();
    let summary = usage(&paths, &[]).unwrap();
    assert_eq!(summary.all_time.requests, 0);
    assert!(summary.buckets.is_empty());
}

#[test]
fn stored_prices_stay_stable_and_missing_ones_are_priced_at_read_time() {
    let (_root, paths) = fixture();
    write_price_cache(
        &paths,
        "model-a",
        Prices {
            input: 100.0,
            output: 100.0,
            cache_read: None,
            cache_write: None,
        },
    );
    ledger::append(&paths.data, &record("model-a", 1, "ok", Some(PRICE_2_10))).unwrap();
    ledger::append(&paths.data, &record("model-a", 2, "ok", None)).unwrap();
    ledger::append(&paths.data, &record("model-gone", 3, "ok", None)).unwrap();

    let summary = usage(&paths, &[]).unwrap();
    assert_eq!(summary.all_time.requests, 3);
    assert_eq!(summary.all_time.cost_usd, 12.0 + 200.0);
    assert_eq!(summary.all_time.unpriced_requests, 1);
}

#[test]
fn a_used_token_class_without_a_price_is_unpriced() {
    let (_root, paths) = fixture();
    let prices = Prices {
        cache_read: None,
        ..PRICE_2_10
    };
    let mut cached = record("model-a", 1, "ok", Some(prices));
    cached.cache_read_tokens = 5;
    ledger::append(&paths.data, &cached).unwrap();
    ledger::append(&paths.data, &record("model-a", 2, "ok", Some(prices))).unwrap();
    let summary = usage(&paths, &[]).unwrap();
    assert_eq!(summary.all_time.unpriced_requests, 1);
    assert_eq!(summary.all_time.cost_usd, 12.0);
}

#[test]
fn non_default_routing_is_approximate_at_base_price_and_defaults_are_not() {
    let (_root, paths) = fixture();
    let default_values = [
        (None, None, None),
        (Some("global"), Some("standard"), Some("standard")),
        (Some("not_available"), Some("standard"), Some("standard")),
    ];
    for (geo, speed, tier) in default_values {
        let mut entry = record("model-a", 1, "ok", Some(PRICE_2_10));
        entry.inference_geo = geo.map(str::to_string);
        entry.speed = speed.map(str::to_string);
        entry.service_tier = tier.map(str::to_string);
        ledger::append(&paths.data, &entry).unwrap();
    }
    assert_eq!(usage(&paths, &[]).unwrap().all_time.approximate_requests, 0);

    let mut geo = record("model-a", 1, "ok", Some(PRICE_2_10));
    geo.inference_geo = Some("us".to_string());
    let mut speed = record("model-a", 1, "ok", Some(PRICE_2_10));
    speed.speed = Some("fast".to_string());
    let mut tier = record("model-a", 1, "ok", Some(PRICE_2_10));
    tier.service_tier = Some("priority".to_string());
    for entry in [&geo, &speed, &tier] {
        ledger::append(&paths.data, entry).unwrap();
    }
    let totals = usage(&paths, &[]).unwrap().all_time;
    assert_eq!(totals.approximate_requests, 3);
    assert_eq!(totals.cost_usd, 12.0 * 6.0);
}

#[test]
fn records_fall_in_the_bucket_their_timestamp_starts_and_older_ones_in_all_time_only() {
    let (_root, paths) = fixture();
    for (model, ts, outcome) in [
        ("model-b", 9, "ok"),
        ("model-b", 10, "ok"),
        ("model-a", 19, "ok"),
        ("model-a", 20, "refused"),
        ("model-b", 20, "ok"),
        ("model-a", 500, "ok"),
    ] {
        ledger::append(&paths.data, &record(model, ts, outcome, Some(PRICE_2_10))).unwrap();
    }
    let summary = usage(&paths, &[10, 20]).unwrap();

    assert_eq!(summary.all_time.requests, 6);
    assert_eq!(summary.all_time.cost_usd, 72.0);
    let starts: Vec<_> = summary
        .buckets
        .iter()
        .map(|bucket| bucket.start_ms)
        .collect();
    assert_eq!(starts, [10, 20]);
    assert_eq!(summary.buckets[0].totals.requests, 2);
    assert_eq!(summary.buckets[0].totals.cost_usd, 24.0);
    assert_eq!(summary.buckets[1].totals.requests, 3);
    assert_eq!(summary.buckets[1].totals.refused_requests, 1);
    let per_model = |index: usize| -> Vec<(String, u64)> {
        summary.buckets[index]
            .per_model
            .iter()
            .map(|entry| (entry.model.clone(), entry.totals.requests))
            .collect()
    };
    assert_eq!(
        per_model(0),
        [("model-a".to_string(), 1), ("model-b".to_string(), 1)]
    );
    assert_eq!(
        per_model(1),
        [("model-a".to_string(), 2), ("model-b".to_string(), 1)]
    );
}

#[test]
fn empty_buckets_are_still_returned() {
    let (_root, paths) = fixture();
    ledger::append(&paths.data, &record("model-a", 25, "ok", Some(PRICE_2_10))).unwrap();
    let summary = usage(&paths, &[10, 20, 30]).unwrap();

    let requests: Vec<_> = summary
        .buckets
        .iter()
        .map(|bucket| bucket.totals.requests)
        .collect();
    assert_eq!(requests, [0, 1, 0]);
    assert!(summary.buckets[0].per_model.is_empty());
}

#[test]
fn bucket_starts_must_ascend_and_stay_within_the_limit() {
    let (_root, paths) = fixture();
    for starts in [vec![20, 10], vec![10, 10]] {
        assert_eq!(
            usage(&paths, &starts).unwrap_err(),
            "The usage request was invalid."
        );
    }
    let within: Vec<i64> = (0..64).collect();
    assert_eq!(usage(&paths, &within).unwrap().buckets.len(), 64);
    let beyond: Vec<i64> = (0..65).collect();
    assert_eq!(
        usage(&paths, &beyond).unwrap_err(),
        "The usage request was invalid."
    );
}

#[test]
fn refused_calls_are_priced_like_any_other_and_still_counted_as_refused() {
    let (_root, paths) = fixture();
    write_price_cache(
        &paths,
        "model-a",
        Prices {
            input: 100.0,
            output: 100.0,
            cache_read: None,
            cache_write: None,
        },
    );
    let mut with_category = record("model-a", 1, "refused", Some(PRICE_2_10));
    with_category.stop_category = Some("cyber".to_string());
    ledger::append(&paths.data, &with_category).unwrap();
    ledger::append(&paths.data, &record("model-a", 2, "refused", None)).unwrap();
    ledger::append(&paths.data, &record("model-gone", 3, "refused", None)).unwrap();
    let mut approximate = record("model-a", 4, "refused", Some(PRICE_2_10));
    approximate.speed = Some("fast".to_string());
    ledger::append(&paths.data, &approximate).unwrap();

    let summary = usage(&paths, &[0]).unwrap();
    let bucket = &summary.buckets[0];
    for totals in [&summary.all_time, &bucket.totals] {
        assert_eq!(totals.requests, 4);
        assert_eq!(totals.refused_requests, 4);
        assert_eq!(totals.cost_usd, 12.0 + 200.0 + 12.0);
        assert_eq!(totals.unpriced_requests, 1);
        assert_eq!(totals.approximate_requests, 1);
    }
    let model_a = &bucket.per_model[0];
    assert_eq!(model_a.model, "model-a");
    assert_eq!(model_a.totals.cost_usd, 12.0 + 200.0 + 12.0);
    assert_eq!(bucket.per_model[1].totals.unpriced_requests, 1);
}

#[test]
fn hand_edited_prices_never_produce_an_invalid_cost() {
    let (_root, paths) = fixture();
    let negative = Prices {
        input: -5.0,
        output: 1.0,
        cache_read: None,
        cache_write: None,
    };
    ledger::append(&paths.data, &record("model-a", 1, "ok", Some(negative))).unwrap();
    let huge = Prices {
        input: f64::MAX,
        output: f64::MAX,
        cache_read: None,
        cache_write: None,
    };
    ledger::append(&paths.data, &record("model-a", 2, "ok", Some(huge))).unwrap();
    let totals = usage(&paths, &[]).unwrap().all_time;
    assert!(totals.cost_usd.is_finite() && totals.cost_usd >= 0.0);
    assert_eq!(totals.unpriced_requests, 2);
}

// Wire shapes checked against the frontend normalizers

#[test]
fn dtos_serialize_the_exact_camel_case_shapes_with_explicit_nulls() {
    assert_eq!(
        serde_json::to_value(AiStatus { configured: true }).unwrap(),
        json!({ "configured": true })
    );
    assert_eq!(
        serde_json::to_value(AiKeySaveResult { verified: false }).unwrap(),
        json!({ "verified": false })
    );
    assert_eq!(
        serde_json::to_value(AiModelList {
            models: vec![AiModel {
                id: "a".to_string(),
                display_name: "A".to_string(),
                deprecated: true,
                superseded: true,
            }],
            default_model_id: None,
            fetched_at: None,
            error: None,
        })
        .unwrap(),
        json!({
            "models": [{ "id": "a", "displayName": "A", "deprecated": true, "superseded": true }],
            "defaultModelId": null,
            "fetchedAt": null,
            "error": null,
        })
    );
    assert_eq!(
        serde_json::to_value(AiGenerateResult {
            outcome: "ok".to_string(),
            statements: vec!["x;".to_string()],
            served_model: "a".to_string(),
            fell_back: true,
        })
        .unwrap(),
        json!({ "outcome": "ok", "statements": ["x;"], "servedModel": "a", "fellBack": true })
    );
    let totals = json!({
        "requests": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "costUsd": 0.0,
        "unpricedRequests": 0,
        "approximateRequests": 0,
        "refusedRequests": 0,
    });
    assert_eq!(
        serde_json::to_value(AiUsageSummary {
            buckets: vec![AiUsageBucket {
                start_ms: 5,
                totals: AiUsageTotals::default(),
                per_model: vec![AiModelUsage {
                    model: "a".to_string(),
                    totals: AiUsageTotals::default(),
                }],
            }],
            all_time: AiUsageTotals::default(),
            skipped_lines: 0,
        })
        .unwrap(),
        json!({
            "buckets": [{
                "startMs": 5,
                "totals": totals,
                "perModel": [{ "model": "a", "totals": totals }],
            }],
            "allTime": totals,
            "skippedLines": 0,
        })
    );
}

#[test]
fn generate_request_deserializes_from_camel_case() {
    let request: AiGenerateRequest = serde_json::from_value(json!({
        "selectedModelId": null,
        "problemTitle": "T",
        "problemContent": "C",
        "entryPoint": "E",
        "methodHeaders": ["m"],
        "psSignatures": ["s"],
    }))
    .unwrap();
    assert_eq!(request.selected_model_id, None);
    assert_eq!(request.entry_point.as_deref(), Some("E"));
    assert_eq!(request.method_headers, ["m"]);
    assert_eq!(request.ps_signatures, ["s"]);
}

#[test]
fn empty_names_and_pins_never_reach_the_strict_frontend_shapes() {
    let (_root, paths) = keyed_fixture();
    let mut unnamed = api_model("model-a", Some("sonnet"), "2026-09-01T00:00:00Z");
    unnamed["display_name"] = json!("");
    let (base_url, server) = serve(vec![models_page(&[unnamed], false, None)]);
    let list = block_on(list_models(&base_url, &paths, true));
    server.join().unwrap();
    assert_eq!(list.models[0].display_name, "model-a");

    let (base_url, server) = serve(vec![http(
        200,
        r#"{"model":"","stop_reason":"end_turn","content":[{"type":"text","text":"{\"statements\":[]}"}]}"#,
    )]);
    let result = block_on(generate_tests(
        &base_url,
        &paths,
        &generate_request(Some("")),
    ))
    .unwrap();
    server.join().unwrap();
    assert_eq!(result.served_model, "model-a");
    assert!(!result.fell_back);
}

#[test]
fn a_reply_that_refuses_with_no_usage_or_content_still_parses() {
    let reply = claude::parse_reply(&json!({ "stop_reason": "refusal" }), "model-a");
    assert_eq!(reply.outcome, ReplyOutcome::Refused);
    assert_eq!(reply.model, "model-a");
    assert_eq!(reply.usage, claude::MessageUsage::default());
    assert_eq!(reply.stop_category, None);
}

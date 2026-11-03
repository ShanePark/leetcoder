use reqwest::header::HeaderValue;
use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder, RequestBuilder, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::key_store::ApiKey;
use super::{now_ms, prompt, write_cache_file, AiGenerateRequest, AiModel, DAY_MS};

const API_VERSION: &str = "2026-10-21";
const MAX_OUTPUT_TOKENS: u32 = 16000;
pub(super) const MESSAGE_TIMEOUT: Duration = Duration::from_secs(300);
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);
const MODELS_PAGE_SIZE: &str = "1000";
const MAX_MODEL_PAGES: usize = 100;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_ERROR_TYPE_CHARS: usize = 64;
const CATALOG_FILE: &str = "ai-models-anthropic.json";
const DEFAULT_LINE: &str = "haiku";
const USER_AGENT: &str = "leetcoder/0.1";

/// Carries only what is safe to show: never a response body or the key.
#[derive(Debug, PartialEq)]
pub(super) enum ApiError {
    Network {
        timed_out: bool,
    },
    MessageTimedOut,
    Status {
        status: u16,
        error_type: Option<String>,
    },
    InvalidKey,
    Malformed,
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network { timed_out: true } => {
                formatter.write_str("The AI provider did not respond in time.")
            }
            Self::Network { timed_out: false } => {
                formatter.write_str("Could not reach the AI provider.")
            }
            Self::MessageTimedOut => formatter.write_str(
                "The AI provider did not respond in time. The call may still have been charged.",
            ),
            Self::InvalidKey => formatter.write_str("The API key contains invalid characters."),
            Self::Malformed => formatter.write_str("The AI provider sent an unreadable response."),
            Self::Status { status, error_type } => {
                let summary = match status {
                    300..=399 => "The AI provider sent an unexpected redirect",
                    401 => "The AI provider rejected the API key",
                    429 => "The AI provider rate limit was reached",
                    500.. => "The AI provider is unavailable",
                    _ => "The AI provider returned an error",
                };
                match error_type {
                    Some(error_type) => {
                        write!(formatter, "{summary} (HTTP {status}, {error_type}).")
                    }
                    None => write!(formatter, "{summary} (HTTP {status})."),
                }
            }
        }
    }
}

/// Settings shared by the key-bearing and price clients, which stay separate
/// instances. Local test servers speak plain HTTP, and callers pass
/// `!cfg!(test)` so a production build cannot turn `https_only` off.
pub(super) fn client_builder(https_only: bool) -> ClientBuilder {
    let builder = Client::builder()
        .redirect(Policy::none())
        .https_only(https_only)
        .user_agent(USER_AGENT);
    if cfg!(test) {
        builder.no_proxy()
    } else {
        builder
    }
}

pub(super) fn build_key_client(https_only: bool) -> Result<Client, ApiError> {
    client_builder(https_only)
        .build()
        .map_err(|_| ApiError::Network { timed_out: false })
}

fn key_client() -> Result<Client, ApiError> {
    build_key_client(!cfg!(test))
}

/// The key is attached per request so it can never reach another request through
/// client defaults.
pub(super) fn authorized(
    request: RequestBuilder,
    key: &ApiKey,
) -> Result<RequestBuilder, ApiError> {
    let mut value = HeaderValue::from_str(key.expose()).map_err(|_| ApiError::InvalidKey)?;
    value.set_sensitive(true);
    Ok(request
        .header("x-api-key", value)
        .header("anthropic-version", API_VERSION))
}

fn network_error(error: reqwest::Error) -> ApiError {
    ApiError::Network {
        timed_out: error.is_timeout(),
    }
}

pub(super) async fn read_capped(response: &mut Response, cap: usize) -> Result<Vec<u8>, ApiError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > cap {
            return Err(ApiError::Malformed);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_error_type(body: &[u8]) -> Option<String> {
    let document: Value = serde_json::from_slice(body).ok()?;
    let error_type = document.pointer("/error/type")?.as_str()?;
    let is_identifier = error_type.len() <= MAX_ERROR_TYPE_CHARS
        && !error_type.is_empty()
        && error_type.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        });
    is_identifier.then(|| error_type.to_string())
}

async fn read_success(mut response: Response) -> Result<Value, ApiError> {
    let status = response.status();
    if status.is_success() {
        let body = read_capped(&mut response, MAX_RESPONSE_BYTES).await?;
        return serde_json::from_slice(&body).map_err(|_| ApiError::Malformed);
    }
    let error_type = if status.is_redirection() {
        None
    } else {
        read_capped(&mut response, MAX_ERROR_BYTES)
            .await
            .ok()
            .and_then(|body| parse_error_type(&body))
    };
    Err(ApiError::Status {
        status: status.as_u16(),
        error_type,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Capabilities {
    pub structured_outputs: bool,
    pub effort_low: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub created_at: String,
    pub lifecycle: String,
    pub line: Option<String>,
    pub capabilities: Option<Capabilities>,
}

impl CatalogModel {
    /// Requests always use structured output, so only these models can serve one.
    fn is_listed(&self) -> bool {
        self.lifecycle != "retired"
            && self
                .capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.structured_outputs)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Catalog {
    pub fetched_at: i64,
    pub models: Vec<CatalogModel>,
}

impl Catalog {
    pub(super) fn is_stale(&self, now: i64) -> bool {
        now - self.fetched_at >= DAY_MS
    }

    pub(super) fn effort_low(&self, model_id: &str) -> bool {
        self.models
            .iter()
            .find(|model| model.id == model_id)
            .and_then(|model| model.capabilities.as_ref())
            .is_some_and(|capabilities| capabilities.effort_low)
    }
}

fn is_supported(capability: Option<&Value>) -> bool {
    capability
        .and_then(|capability| capability.get("supported"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_model(row: &Value) -> Option<CatalogModel> {
    let id = row.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let text = |field: &str| {
        row.get(field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let capabilities = row
        .get("capabilities")
        .filter(|capabilities| capabilities.is_object())
        .map(|capabilities| {
            let effort = capabilities.get("effort");
            Capabilities {
                structured_outputs: is_supported(capabilities.get("structured_outputs")),
                effort_low: is_supported(effort)
                    && is_supported(effort.and_then(|effort| effort.get("low"))),
            }
        });
    Some(CatalogModel {
        id: id.to_string(),
        display_name: text("display_name").unwrap_or_else(|| id.to_string()),
        created_at: text("created_at").unwrap_or_default(),
        lifecycle: text("lifecycle").unwrap_or_else(|| "active".to_string()),
        line: text("line"),
        capabilities,
    })
}

/// A partial list could wrongly unpin a model, so anything short of the final
/// page, including a malformed row, fails the whole fetch.
pub(super) async fn fetch_models(
    base_url: &str,
    key: &ApiKey,
) -> Result<Vec<CatalogModel>, ApiError> {
    let client = key_client()?;
    let endpoint = Url::parse(&format!("{}/v1/models", base_url.trim_end_matches('/')))
        .map_err(|_| ApiError::Malformed)?;
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let mut url = endpoint.clone();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", MODELS_PAGE_SIZE);
            if let Some(after_id) = &after_id {
                query.append_pair("after_id", after_id);
            }
        }
        let response = authorized(client.get(url).timeout(MODELS_TIMEOUT), key)?
            .send()
            .await
            .map_err(network_error)?;
        let page = read_success(response).await?;
        let rows = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or(ApiError::Malformed)?;
        for row in rows {
            models.push(parse_model(row).ok_or(ApiError::Malformed)?);
        }
        let has_more = page
            .get("has_more")
            .and_then(Value::as_bool)
            .ok_or(ApiError::Malformed)?;
        if !has_more {
            return Ok(models);
        }
        let next = page
            .get("last_id")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty() && after_id.as_deref() != Some(*next))
            .ok_or(ApiError::Malformed)?;
        after_id = Some(next.to_string());
    }
    Err(ApiError::Malformed)
}

fn catalog_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(CATALOG_FILE)
}

pub(super) fn load_catalog(cache_dir: &Path) -> Option<Catalog> {
    let bytes = fs::read(catalog_path(cache_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// An empty list is kept out of the cache, since it would unpin every model.
pub(super) fn store_catalog(
    cache_dir: &Path,
    models: Vec<CatalogModel>,
) -> Result<Catalog, String> {
    if models.is_empty() {
        return Err("The AI provider returned no models.".to_string());
    }
    let catalog = Catalog {
        fetched_at: now_ms(),
        models,
    };
    let bytes = serde_json::to_vec(&catalog).map_err(|error| error.to_string())?;
    write_cache_file(&catalog_path(cache_dir), &bytes)?;
    Ok(catalog)
}

pub(super) async fn refresh_catalog(
    base_url: &str,
    cache_dir: &Path,
    key: &ApiKey,
) -> Result<Catalog, String> {
    let models = fetch_models(base_url, key)
        .await
        .map_err(|error| error.to_string())?;
    store_catalog(cache_dir, models)
}

pub(super) fn listed_models(models: &[CatalogModel]) -> Vec<AiModel> {
    models
        .iter()
        .filter(|model| model.is_listed())
        .map(|model| AiModel {
            id: model.id.clone(),
            display_name: model.display_name.clone(),
            deprecated: model.lifecycle == "deprecated",
            superseded: is_superseded(model, models),
        })
        .collect()
}

/// A model with no line cannot be compared, so it is never superseded. Active
/// models lead their line first, which keeps the default among the unsuperseded.
fn is_superseded(model: &CatalogModel, models: &[CatalogModel]) -> bool {
    let Some(line) = model.line.as_deref() else {
        return false;
    };
    let same_line = || {
        models
            .iter()
            .filter(|other| other.is_listed() && other.line.as_deref() == Some(line))
    };
    newest(same_line().filter(|other| other.lifecycle == "active"))
        .or_else(|| newest(same_line()))
        .is_some_and(|leader| leader.id != model.id)
}

/// RFC 3339 UTC timestamps order correctly as text, and the strict comparison
/// keeps the earlier list entry on a tie, which matters because `created_at` may
/// be the epoch.
fn newest<'a>(models: impl Iterator<Item = &'a CatalogModel>) -> Option<&'a CatalogModel> {
    models.fold(None, |newest, model| match newest {
        Some(newest) if model.created_at <= newest.created_at => Some(newest),
        _ => Some(model),
    })
}

/// The newest active Haiku.
pub(super) fn default_model(models: &[CatalogModel]) -> Option<&CatalogModel> {
    newest(models.iter().filter(|model| {
        model.is_listed()
            && model.lifecycle == "active"
            && model.line.as_deref() == Some(DEFAULT_LINE)
    }))
}

#[derive(Debug, PartialEq)]
pub(super) struct ResolvedModel {
    pub served: String,
    pub fell_back: bool,
}

/// `models` is `None` when no complete list has ever been fetched. A pin is then
/// used as is, because only a complete list can show that it left.
pub(super) fn resolve_model(
    models: Option<&[CatalogModel]>,
    pinned: Option<&str>,
) -> Option<ResolvedModel> {
    let Some(models) = models else {
        return pinned.map(|pinned| ResolvedModel {
            served: pinned.to_string(),
            fell_back: false,
        });
    };
    if let Some(pinned) = pinned {
        if models
            .iter()
            .any(|model| model.id == pinned && model.is_listed())
        {
            return Some(ResolvedModel {
                served: pinned.to_string(),
                fell_back: false,
            });
        }
    }
    default_model(models).map(|model| ResolvedModel {
        served: model.id.clone(),
        fell_back: pinned.is_some(),
    })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct MessageUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub inference_geo: Option<String>,
    pub speed: Option<String>,
    pub service_tier: Option<String>,
}

#[derive(Debug, PartialEq)]
pub(super) enum ReplyOutcome {
    Statements(Vec<String>),
    Refused,
    Truncated,
    Invalid,
    Unreadable(ApiError),
}

#[derive(Debug, PartialEq)]
pub(super) struct MessageReply {
    pub model: String,
    pub usage: MessageUsage,
    pub stop_category: Option<String>,
    pub outcome: ReplyOutcome,
}

pub(super) fn request_body(model_id: &str, effort_low: bool, request: &AiGenerateRequest) -> Value {
    let mut output_config = json!({
        "format": { "type": "json_schema", "schema": prompt::output_schema() }
    });
    if effort_low {
        output_config["effort"] = json!("low");
    }
    // The breakpoint ends the prefix that every request shares. Per-request text
    // belongs in `messages`, after it: anything earlier would miss the cache.
    json!({
        "model": model_id,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "system": [{
            "type": "text",
            "text": prompt::system_prompt(!request.ps_signatures.is_empty()),
            "cache_control": { "type": "ephemeral" },
        }],
        "messages": [{ "role": "user", "content": prompt::user_message(request) }],
        "output_config": output_config,
    })
}

fn parse_usage(usage: Option<&Value>) -> MessageUsage {
    let count = |field: &str| {
        usage
            .and_then(|usage| usage.get(field))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let text = |field: &str| {
        usage
            .and_then(|usage| usage.get(field))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    MessageUsage {
        input_tokens: count("input_tokens"),
        output_tokens: count("output_tokens"),
        cache_read_tokens: count("cache_read_input_tokens"),
        cache_write_tokens: count("cache_creation_input_tokens"),
        inference_geo: text("inference_geo"),
        speed: text("speed"),
        service_tier: text("service_tier"),
    }
}

fn parse_statements(content: Option<&Value>) -> Option<Vec<String>> {
    let text: String = content?
        .as_array()?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    let document: Value = serde_json::from_str(&text).ok()?;
    document
        .get("statements")?
        .as_array()?
        .iter()
        .map(|statement| statement.as_str().map(str::to_string))
        .collect()
}

/// `stop_reason` decides before any content is read: a refused or cut-off reply
/// may not match the schema.
pub(super) fn parse_reply(body: &Value, requested_model: &str) -> MessageReply {
    let outcome = match body.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => ReplyOutcome::Refused,
        Some("max_tokens" | "model_context_window_exceeded") => ReplyOutcome::Truncated,
        Some("end_turn") => parse_statements(body.get("content"))
            .map_or(ReplyOutcome::Invalid, ReplyOutcome::Statements),
        _ => ReplyOutcome::Invalid,
    };
    MessageReply {
        model: body
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
            .unwrap_or(requested_model)
            .to_string(),
        usage: parse_usage(body.get("usage")),
        stop_category: body
            .get("stop_details")
            .and_then(|details| details.get("category"))
            .and_then(Value::as_str)
            .map(str::to_string),
        outcome,
    }
}

fn unreadable_reply(model_id: &str, error: ApiError) -> MessageReply {
    MessageReply {
        model: model_id.to_string(),
        usage: MessageUsage::default(),
        stop_category: None,
        outcome: ReplyOutcome::Unreadable(error),
    }
}

/// Only a generation can bill for a timed-out call, so the catalog keeps the plain
/// message.
fn generation_error(error: ApiError) -> ApiError {
    match error {
        ApiError::Network { timed_out: true } => ApiError::MessageTimedOut,
        other => other,
    }
}

pub(super) async fn send_message(
    base_url: &str,
    key: &ApiKey,
    model_id: &str,
    effort_low: bool,
    request: &AiGenerateRequest,
) -> Result<MessageReply, ApiError> {
    send_message_within(
        base_url,
        key,
        model_id,
        effort_low,
        request,
        MESSAGE_TIMEOUT,
    )
    .await
}

/// A 2xx may have been charged even when its body is lost, so that case comes back
/// as a reply for the ledger rather than as an error.
pub(super) async fn send_message_within(
    base_url: &str,
    key: &ApiKey,
    model_id: &str,
    effort_low: bool,
    request: &AiGenerateRequest,
    timeout: Duration,
) -> Result<MessageReply, ApiError> {
    let client = key_client()?;
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let response = authorized(client.post(url).timeout(timeout), key)?
        .json(&request_body(model_id, effort_low, request))
        .send()
        .await
        .map_err(|error| generation_error(network_error(error)))?;
    let succeeded = response.status().is_success();
    match read_success(response).await {
        Ok(body) if body.is_object() => Ok(parse_reply(&body, model_id)),
        Ok(_) => Ok(unreadable_reply(model_id, ApiError::Malformed)),
        Err(error) if succeeded => Ok(unreadable_reply(model_id, generation_error(error))),
        Err(error) => Err(error),
    }
}

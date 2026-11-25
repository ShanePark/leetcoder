use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tempfile::NamedTempFile;

mod claude;
mod key_store;
mod ledger;
mod prices;
mod prompt;
mod stream;

#[cfg(test)]
mod eval;
#[cfg(test)]
mod tests;

use claude::{ApiError, MessageReply, MessageUsage, ReplyOutcome, ResolvedModel};
use key_store::ApiKey;
use serde_json::Value;
use stream::{StreamUpdate, ToolUse};

const API_BASE_URL: &str = "https://api.anthropic.com";
const PRICES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_USAGE_BUCKETS: usize = 64;
/// Far above any input that fits in a statement the frontend accepts.
const MAX_FAILING_CASE_CHARS: usize = 32_768;
/// Far above any solution file, so only a pasted blob is rejected.
const MAX_REVIEW_SOURCE_CHARS: usize = 200_000;
/// All text of a test run taken together. The frontend truncates output first.
const MAX_REVIEW_TEST_RUN_CHARS: usize = 64_000;
const MAX_FOLLOW_UP_QUESTION_CHARS: usize = 4_000;
const MAX_FOLLOW_UP_TURNS: usize = 20;
/// Questions and answers of earlier turns taken together.
const MAX_FOLLOW_UP_HISTORY_CHARS: usize = 64_000;
const MAX_PROPOSAL_SUMMARY_CHARS: usize = 1_000;

static PRICE_REFRESH_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub(crate) struct AiPaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiProvider {
    Anthropic,
}

impl AiProvider {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude",
        }
    }

    fn info(self) -> AiProviderInfo {
        AiProviderInfo {
            id: self.id().to_string(),
            display_name: self.display_name().to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProviderInfo {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiStatus {
    pub configured: bool,
    /// The provider in use, reported even without a key.
    pub provider: AiProviderInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub(crate) enum AiProgressEvent {
    /// Sent right before the request, with the model actually requested.
    Requesting { model: String },
    /// Sent once the reply arrived, before it is parsed.
    Received,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiKeySaveResult {
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModel {
    pub id: String,
    pub display_name: String,
    pub deprecated: bool,
    /// A newer model of the same line exists. It stays usable as an existing pin.
    pub superseded: bool,
    /// None when the price cache has no entry for the model.
    pub pricing: Option<AiModelPricing>,
}

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelPricing {
    pub input_per_m_tok: f64,
    pub output_per_m_tok: f64,
    pub cache_read_per_m_tok: Option<f64>,
    pub cache_write_per_m_tok: Option<f64>,
}

impl From<prices::Prices> for AiModelPricing {
    fn from(prices: prices::Prices) -> Self {
        Self {
            input_per_m_tok: prices.input,
            output_per_m_tok: prices.output,
            cache_read_per_m_tok: prices.cache_read,
            cache_write_per_m_tok: prices.cache_write,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelList {
    pub models: Vec<AiModel>,
    pub default_model_id: Option<String>,
    pub fetched_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiGenerateRequest {
    pub selected_model_id: Option<String>,
    pub problem_title: String,
    pub problem_content: String,
    pub entry_point: Option<String>,
    pub java_snippet: Option<String>,
    pub method_headers: Vec<String>,
    pub ps_signatures: Vec<String>,
    /// A failing case pasted from the judge. When present, the statements test
    /// only this case, for a new test method, instead of the examples.
    #[serde(default)]
    pub failing_case: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiGenerateResult {
    pub outcome: String,
    pub statements: Vec<String>,
    pub served_model: String,
    pub fell_back: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiResponseLanguage {
    #[default]
    English,
    Korean,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewTestCase {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub actual: Option<String>,
    #[serde(default)]
    pub stdout: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewTestSummary {
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewTestRun {
    pub success: bool,
    pub phase: String,
    pub summary: AiReviewTestSummary,
    pub tests: Vec<AiReviewTestCase>,
    pub diagnostics: Vec<String>,
}

/// What a review request asks for: a review of a written solution, or help
/// with a problem before a solution exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiReviewMode {
    #[default]
    Review,
    Help,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewRequest {
    pub selected_model_id: Option<String>,
    pub problem_title: String,
    pub problem_content: String,
    pub entry_point: Option<String>,
    /// The whole open solution file.
    pub source: String,
    /// Present only when the last run was made on exactly this source. Help
    /// ignores it.
    pub test_run: Option<AiReviewTestRun>,
    #[serde(default)]
    pub language: AiResponseLanguage,
    #[serde(default)]
    pub mode: AiReviewMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiReviewVerdict {
    Correct,
    Incorrect,
    Unsure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewMissedCase {
    pub input: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewEfficiency {
    pub time: String,
    pub space: String,
    pub assessment: String,
}

/// The model writes this shape directly, through the schema in `prompt.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReview {
    pub verdict: AiReviewVerdict,
    pub summary: String,
    pub failure_cause: Option<String>,
    pub issues: Vec<String>,
    pub missed_cases: Vec<AiReviewMissedCase>,
    pub efficiency: AiReviewEfficiency,
    pub improvements: Vec<String>,
}

/// Help with a problem before a solution exists, through the help schema in
/// `prompt.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProblemHelp {
    pub overview: String,
    pub key_points: Vec<String>,
    /// Gentlest first.
    pub hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewResult {
    pub outcome: String,
    /// Present only when `outcome` is `ok` in review mode.
    pub review: Option<AiReview>,
    /// Present only when `outcome` is `ok` in help mode.
    pub help: Option<AiProblemHelp>,
    pub served_model: String,
    pub fell_back: bool,
    pub usage: AiRequestUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AiCodeProposalOutcome {
    Pending,
    Accepted,
    Rejected,
}

/// A code change an earlier answer proposed, and what the user did with it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProposalRecord {
    pub summary: String,
    pub outcome: AiCodeProposalOutcome,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewFollowUpTurn {
    pub question: String,
    pub answer: String,
    #[serde(default)]
    pub proposal: Option<AiProposalRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewFollowUpRequest {
    /// The model that served the review.
    pub selected_model_id: String,
    /// The request the review was made from, unchanged.
    pub review: AiReviewRequest,
    /// Exactly one answer is present, the one `review.mode` asked for.
    #[serde(default)]
    pub review_answer: Option<AiReview>,
    #[serde(default)]
    pub help_answer: Option<AiProblemHelp>,
    /// Earlier completed turns, oldest first.
    pub history: Vec<AiReviewFollowUpTurn>,
    pub question: String,
    /// The editor's text now. Sent to the model only when it differs from
    /// `review.source`; a proposed change is based on it.
    pub current_code: String,
}

/// One streamed update of a review or a follow-up answer. A review's text is
/// fragments of its JSON document.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum AiStreamEvent {
    Text {
        text: String,
    },
    /// The model is thinking. `chars` counts the thinking text this piece
    /// added, zero when a block starts or the API omits the text.
    Thinking {
        chars: usize,
    },
    /// The model began writing a code change; its input arrives with the result.
    ProposalStarted,
    /// The token counts so far: once when the message starts, with the input
    /// and cache counts, then once with the final counts.
    Usage {
        usage: AiStreamUsage,
        #[serde(rename = "final")]
        last: bool,
    },
}

/// Token counts reported while a message streams. The cost comes with the result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiStreamUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// The event a stream update becomes. A tool call other than a code change
/// has none.
fn stream_event(update: StreamUpdate<'_>) -> Option<AiStreamEvent> {
    match update {
        StreamUpdate::Text(text) => Some(AiStreamEvent::Text {
            text: text.to_string(),
        }),
        StreamUpdate::Thinking(chars) => Some(AiStreamEvent::Thinking { chars }),
        StreamUpdate::ToolUseStarted(name) => {
            (name == prompt::PROPOSE_CODE_CHANGE).then_some(AiStreamEvent::ProposalStarted)
        }
        StreamUpdate::Usage { usage, last } => Some(AiStreamEvent::Usage {
            usage: AiStreamUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_write_tokens: usage.cache_write_tokens,
            },
            last,
        }),
    }
}

/// A whole-file change the user asked for, shown as a diff before anything is applied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiCodeProposal {
    pub summary: String,
    /// The complete new file.
    pub code: String,
    /// The `current_code` the change was made against.
    pub base_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiReviewFollowUpResult {
    pub outcome: String,
    /// Everything streamed, partial when truncated, with a note when a started
    /// code change could not be offered.
    pub answer: String,
    /// Present only when `outcome` is `ok` and the change is usable.
    pub proposal: Option<AiCodeProposal>,
    pub served_model: String,
    pub fell_back: bool,
    pub usage: AiRequestUsage,
}

/// The tokens and cost of one model request.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRequestUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// None when the served model's price is unknown.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageTotals {
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_usd: f64,
    pub unpriced_requests: u64,
    pub approximate_requests: u64,
    pub refused_requests: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelUsage {
    pub model: String,
    pub totals: AiUsageTotals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageBucket {
    pub start_ms: i64,
    pub totals: AiUsageTotals,
    pub per_model: Vec<AiModelUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageSummary {
    pub buckets: Vec<AiUsageBucket>,
    pub all_time: AiUsageTotals,
    pub skipped_lines: u64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn write_cache_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Could not update {}: {error}", path.display());
    let directory = path
        .parent()
        .ok_or_else(|| format!("Could not update {}.", path.display()))?;
    fs::create_dir_all(directory).map_err(failed)?;
    let mut temporary = NamedTempFile::new_in(directory).map_err(failed)?;
    temporary.write_all(bytes).map_err(failed)?;
    temporary.flush().map_err(failed)?;
    temporary
        .persist(path)
        .map_err(|error| failed(error.error))?;
    Ok(())
}

fn status(paths: &AiPaths) -> AiStatus {
    // An unreadable key file reads as no key, so the settings tab offers a save
    // that replaces it.
    AiStatus {
        configured: matches!(key_store::load(&paths.config), Ok(Some(_))),
        provider: AiProvider::Anthropic.info(),
    }
}

/// A rejected key is never stored. Any other failure stores it unverified, since
/// an offline machine or a provider outage says nothing about the key.
async fn save_key(
    base_url: &str,
    paths: &AiPaths,
    api_key: &str,
) -> Result<AiKeySaveResult, String> {
    let key = ApiKey::new(api_key)?;
    let models = match claude::fetch_models(base_url, &key).await {
        Err(error @ ApiError::Status { status: 401, .. }) => return Err(error.to_string()),
        Err(_) => {
            key_store::save(&paths.config, &key)?;
            return Ok(AiKeySaveResult { verified: false });
        }
        Ok(models) => models,
    };
    key_store::save(&paths.config, &key)?;
    // The key is good even if the list is empty or the cache cannot be written.
    let _ = claude::store_catalog(&paths.cache, models);
    Ok(AiKeySaveResult { verified: true })
}

/// Without a key this reports the cached list and makes no request.
async fn list_models(base_url: &str, paths: &AiPaths, refresh: bool) -> AiModelList {
    let mut error = None;
    if refresh {
        match key_store::load(&paths.config) {
            Ok(Some(key)) => {
                if let Err(refresh_error) =
                    claude::refresh_catalog(base_url, &paths.cache, &key).await
                {
                    error = Some(refresh_error);
                }
            }
            Ok(None) => {}
            Err(load_error) => error = Some(load_error),
        }
    }
    let catalog = claude::load_catalog(&paths.cache);
    let models = catalog.as_ref().map_or(&[][..], |catalog| &catalog.models);
    AiModelList {
        models: claude::listed_models(models, &prices::load_cache(&paths.cache)),
        default_model_id: claude::default_model(models).map(|model| model.id.clone()),
        fetched_at: catalog
            .as_ref()
            .map(|catalog| catalog.fetched_at)
            .filter(|fetched_at| *fetched_at >= 0),
        error,
    }
}

/// Returns the request's usage, priced as the ledger prices this record.
fn record_usage(
    paths: &AiPaths,
    model: &str,
    usage: &MessageUsage,
    stop_category: Option<&str>,
    outcome: &str,
    kind: &str,
) -> AiRequestUsage {
    let cached = prices::load_cache(&paths.cache).models.get(model).copied();
    let record = ledger::UsageRecord {
        v: ledger::current_version(),
        ts: now_ms(),
        provider: AiProvider::Anthropic.id().to_string(),
        kind: kind.to_string(),
        model: model.to_string(),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        outcome: outcome.to_string(),
        inference_geo: usage.inference_geo.clone(),
        speed: usage.speed.clone(),
        service_tier: usage.service_tier.clone(),
        stop_category: stop_category.map(str::to_string),
        prices: cached.map(|cached| cached.prices),
        prices_fetched_at: cached.map(|cached| cached.fetched_at),
    };
    // A paid-for result outweighs a missing ledger line.
    if let Err(error) = ledger::append(&paths.data, &record) {
        eprintln!("Could not record AI usage: {error}");
    }
    ledger::request_usage(&record)
}

fn check_failing_case(case: &str) -> Result<(), String> {
    if case.trim().is_empty() {
        return Err("Paste a failing case first.".to_string());
    }
    if case.chars().count() > MAX_FAILING_CASE_CHARS {
        return Err(format!(
            "The failing case is longer than {MAX_FAILING_CASE_CHARS} characters."
        ));
    }
    Ok(())
}

/// The size checks every review passes before anything is sent.
fn check_review_request(request: &AiReviewRequest) -> Result<(), String> {
    if request.source.trim().is_empty() {
        return Err("The solution file is empty.".to_string());
    }
    if request.source.chars().count() > MAX_REVIEW_SOURCE_CHARS {
        return Err(format!(
            "The solution file is longer than {MAX_REVIEW_SOURCE_CHARS} characters."
        ));
    }
    let run = request
        .test_run
        .as_ref()
        .filter(|_| request.mode == AiReviewMode::Review);
    if let Some(run) = run {
        let optional =
            |text: &Option<String>| text.as_deref().map_or(0, |text| text.chars().count());
        let test_chars: usize = run
            .tests
            .iter()
            .map(|test| {
                test.name.chars().count()
                    + test.status.chars().count()
                    + optional(&test.message)
                    + optional(&test.expected)
                    + optional(&test.actual)
                    + optional(&test.stdout)
            })
            .sum();
        let diagnostic_chars: usize = run
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.chars().count())
            .sum();
        if run.phase.chars().count() + test_chars + diagnostic_chars > MAX_REVIEW_TEST_RUN_CHARS {
            return Err(format!(
                "The test results are longer than {MAX_REVIEW_TEST_RUN_CHARS} characters."
            ));
        }
    }
    Ok(())
}

fn check_follow_up_request(request: &AiReviewFollowUpRequest) -> Result<(), String> {
    check_review_request(&request.review)?;
    let answer_matches = match request.review.mode {
        AiReviewMode::Review => request.review_answer.is_some() && request.help_answer.is_none(),
        AiReviewMode::Help => request.review_answer.is_none() && request.help_answer.is_some(),
    };
    if !answer_matches {
        return Err("The follow-up request was invalid.".to_string());
    }
    let question = request.question.trim();
    if question.is_empty() {
        return Err("Type a question first.".to_string());
    }
    if question.chars().count() > MAX_FOLLOW_UP_QUESTION_CHARS {
        return Err(format!(
            "The question is longer than {MAX_FOLLOW_UP_QUESTION_CHARS} characters."
        ));
    }
    if request.current_code.chars().count() > MAX_REVIEW_SOURCE_CHARS {
        return Err(format!(
            "The solution file is longer than {MAX_REVIEW_SOURCE_CHARS} characters."
        ));
    }
    let history_chars: usize = request
        .history
        .iter()
        .map(|turn| {
            turn.question.chars().count()
                + turn.answer.chars().count()
                + turn
                    .proposal
                    .as_ref()
                    .map_or(0, |proposal| proposal.summary.chars().count())
        })
        .sum();
    if request.history.len() > MAX_FOLLOW_UP_TURNS || history_chars > MAX_FOLLOW_UP_HISTORY_CHARS {
        let restart = match request.review.mode {
            AiReviewMode::Review => "Run a new review",
            AiReviewMode::Help => "Ask for help again",
        };
        return Err(format!(
            "This conversation is too long. {restart} to continue."
        ));
    }
    Ok(())
}

/// One model call after its usage is recorded.
struct Completion<T> {
    outcome: &'static str,
    /// Present only when `outcome` is `ok`.
    value: Option<T>,
    served_model: String,
    fell_back: bool,
    usage: AiRequestUsage,
}

/// The key and model one call uses.
struct CallTarget {
    key: ApiKey,
    catalog: Option<claude::Catalog>,
    resolved: ResolvedModel,
}

/// Loads the key, refreshes a stale catalog, and resolves the model.
async fn call_target(
    base_url: &str,
    paths: &AiPaths,
    selected_model_id: Option<&str>,
) -> Result<CallTarget, String> {
    let key = key_store::load(&paths.config)?
        .ok_or_else(|| "Add an API key in the LLM settings first.".to_string())?;

    let mut catalog = claude::load_catalog(&paths.cache);
    let mut refresh_error = None;
    if catalog
        .as_ref()
        .is_none_or(|catalog| catalog.is_stale(now_ms()))
    {
        // A failed refresh keeps the cached list, which can still serve this call.
        match claude::refresh_catalog(base_url, &paths.cache, &key).await {
            Ok(fresh) => catalog = Some(fresh),
            Err(error) => refresh_error = Some(error),
        }
    }

    let pinned = selected_model_id.filter(|pinned| !pinned.is_empty());
    let resolved = claude::resolve_model(
        catalog.as_ref().map(|catalog| catalog.models.as_slice()),
        pinned,
    )
    .ok_or_else(|| match (refresh_error, pinned) {
        (Some(refresh_error), _) => refresh_error,
        (None, Some(pinned)) => format!(
            "Model {pinned} is no longer available and there is no default to use. Choose a model in the LLM settings."
        ),
        (None, None) => {
            "No default model is available. Choose a model in the LLM settings.".to_string()
        }
    })?;
    Ok(CallTarget {
        key,
        catalog,
        resolved,
    })
}

/// The message for a call that failed before any reply arrived.
async fn call_error(
    base_url: &str,
    paths: &AiPaths,
    target: &CallTarget,
    error: ApiError,
) -> String {
    match error {
        ApiError::Status {
            status: 400 | 403 | 404,
            ..
        } => {
            // The refresh corrects the list for next time. This call never
            // moves to another model on its own.
            let _ = claude::refresh_catalog(base_url, &paths.cache, &target.key).await;
            format!("Model {} failed: {error}", target.resolved.served)
        }
        error => error.to_string(),
    }
}

/// Records a reply's usage. An unreadable reply is recorded as invalid and
/// becomes an error.
fn settle<T>(
    paths: &AiPaths,
    kind: &str,
    reply: MessageReply<T>,
    fell_back: bool,
) -> Result<Completion<T>, String> {
    let record = |outcome: &str| {
        record_usage(
            paths,
            &reply.model,
            &reply.usage,
            reply.stop_category.as_deref(),
            outcome,
            kind,
        )
    };
    let (outcome, value) = match reply.outcome {
        ReplyOutcome::Parsed(value) => ("ok", Some(value)),
        ReplyOutcome::Refused => ("refused", None),
        ReplyOutcome::Truncated => ("truncated", None),
        ReplyOutcome::Unreadable(error) => {
            record("invalid");
            return Err(error.to_string());
        }
        ReplyOutcome::Invalid => {
            record("invalid");
            return Err(format!(
                "Model {} returned output that could not be read.",
                reply.model
            ));
        }
    };
    let usage = record(outcome);
    Ok(Completion {
        outcome,
        value,
        served_model: reply.model,
        fell_back,
        usage,
    })
}

/// Resolves the model, sends one request, and records its usage. `body` builds
/// the request for the resolved model and whether it supports low effort.
async fn complete<T>(
    base_url: &str,
    paths: &AiPaths,
    selected_model_id: Option<&str>,
    kind: &str,
    body: impl Fn(&str, bool) -> Value,
    parse: fn(&Value) -> Option<T>,
    progress: &(dyn Fn(AiProgressEvent) + Sync),
) -> Result<Completion<T>, String> {
    let target = call_target(base_url, paths, selected_model_id).await?;
    let served = &target.resolved.served;
    let effort_low = target
        .catalog
        .as_ref()
        .is_some_and(|catalog| catalog.effort_low(served));

    let body = body(served, effort_low);
    progress(AiProgressEvent::Requesting {
        model: served.clone(),
    });
    let reply = match claude::send_message(base_url, &target.key, served, &body, parse).await {
        Ok(reply) => reply,
        Err(error) => return Err(call_error(base_url, paths, &target, error).await),
    };
    progress(AiProgressEvent::Received);
    settle(paths, kind, reply, target.resolved.fell_back)
}

async fn generate_tests(
    base_url: &str,
    paths: &AiPaths,
    request: &AiGenerateRequest,
    progress: &(dyn Fn(AiProgressEvent) + Sync),
) -> Result<AiGenerateResult, String> {
    if let Some(case) = &request.failing_case {
        check_failing_case(case)?;
    }
    let completion = complete(
        base_url,
        paths,
        request.selected_model_id.as_deref(),
        ledger::KIND_TESTS,
        |model, effort_low| claude::request_body(model, effort_low, request),
        claude::parse_statements,
        progress,
    )
    .await?;
    Ok(AiGenerateResult {
        outcome: completion.outcome.to_string(),
        statements: completion.value.unwrap_or_default(),
        served_model: completion.served_model,
        fell_back: completion.fell_back,
    })
}

/// Streams a review, or help in help mode, to `on_event` as it is written. The
/// result is still the whole document, read and checked once the stream ends.
async fn review_code(
    base_url: &str,
    paths: &AiPaths,
    request: &AiReviewRequest,
    progress: &(dyn Fn(AiProgressEvent) + Sync),
    on_event: &(dyn Fn(AiStreamEvent) + Sync),
) -> Result<AiReviewResult, String> {
    Ok(match request.mode {
        AiReviewMode::Review => {
            let completion = stream_document(
                base_url,
                paths,
                request,
                ledger::KIND_REVIEW,
                claude::parse_review,
                progress,
                on_event,
            )
            .await?;
            AiReviewResult {
                outcome: completion.outcome.to_string(),
                review: completion.value,
                help: None,
                served_model: completion.served_model,
                fell_back: completion.fell_back,
                usage: completion.usage,
            }
        }
        AiReviewMode::Help => {
            let completion = stream_document(
                base_url,
                paths,
                request,
                ledger::KIND_HELP,
                claude::parse_help,
                progress,
                on_event,
            )
            .await?;
            AiReviewResult {
                outcome: completion.outcome.to_string(),
                review: None,
                help: completion.value,
                served_model: completion.served_model,
                fell_back: completion.fell_back,
                usage: completion.usage,
            }
        }
    })
}

/// Sends one streamed request for a JSON document and records its usage.
async fn stream_document<T>(
    base_url: &str,
    paths: &AiPaths,
    request: &AiReviewRequest,
    kind: &str,
    parse: fn(&Value) -> Option<T>,
    progress: &(dyn Fn(AiProgressEvent) + Sync),
    on_event: &(dyn Fn(AiStreamEvent) + Sync),
) -> Result<Completion<T>, String> {
    check_review_request(request)?;
    let target = call_target(base_url, paths, request.selected_model_id.as_deref()).await?;
    let served = &target.resolved.served;
    let body = claude::review_request_body(served, request);
    progress(AiProgressEvent::Requesting {
        model: served.clone(),
    });
    let on_update = |update: StreamUpdate<'_>| {
        if let Some(event) = stream_event(update) {
            on_event(event);
        }
    };
    let streamed =
        match claude::stream_message(base_url, &target.key, served, &body, &on_update).await {
            Ok(streamed) => streamed,
            Err(error) => return Err(call_error(base_url, paths, &target, error).await),
        };
    progress(AiProgressEvent::Received);
    let reply = claude::streamed_document(streamed.reply, &streamed.text, parse);
    settle(paths, kind, reply, target.resolved.fell_back)
}

/// Why a code change the model started is not offered.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ProposalProblem {
    CutOff,
    Unreadable,
    Unchanged,
}

/// Told in the answer, in its language, in place of the change.
fn proposal_note(problem: ProposalProblem, language: AiResponseLanguage) -> &'static str {
    use AiResponseLanguage::{English, Korean};
    match (problem, language) {
        (ProposalProblem::CutOff, English) => {
            "The code change was cut off at the output limit, so there is nothing to apply. Ask again for a smaller change."
        }
        (ProposalProblem::CutOff, Korean) => {
            "코드 변경이 출력 한도에서 잘려 적용할 내용이 없습니다. 더 작은 변경으로 다시 요청하세요."
        }
        (ProposalProblem::Unreadable, English) => {
            "The code change could not be read, so there is nothing to apply. Ask again."
        }
        (ProposalProblem::Unreadable, Korean) => {
            "코드 변경을 읽을 수 없어 적용할 내용이 없습니다. 다시 요청하세요."
        }
        (ProposalProblem::Unchanged, English) => {
            "The proposed code is the same as the code in the editor, so there is nothing to apply."
        }
        (ProposalProblem::Unchanged, Korean) => {
            "제안된 코드가 에디터의 코드와 같아 적용할 내용이 없습니다."
        }
    }
}

/// The change a finished tool call proposes against `base_code`. The new file
/// takes the base file's final line breaks, which a model often drops, so they
/// never show up as a change of their own.
fn read_proposal(tool_use: &ToolUse, base_code: &str) -> Result<AiCodeProposal, ProposalProblem> {
    if tool_use.name != prompt::PROPOSE_CODE_CHANGE {
        return Err(ProposalProblem::Unreadable);
    }
    let field = |name: &str| {
        tool_use
            .input
            .as_ref()
            .and_then(|input| input.get(name))
            .and_then(Value::as_str)
    };
    let (Some(summary), Some(code)) = (field("summary"), field("code")) else {
        return Err(ProposalProblem::Unreadable);
    };
    let summary = summary.trim();
    if summary.is_empty()
        || summary.chars().count() > MAX_PROPOSAL_SUMMARY_CHARS
        || code.trim().is_empty()
        || code.chars().count() > MAX_REVIEW_SOURCE_CHARS
    {
        return Err(ProposalProblem::Unreadable);
    }
    let line_breaks = &base_code[base_code.trim_end_matches(['\r', '\n']).len()..];
    let code = format!("{}{line_breaks}", code.trim_end_matches(['\r', '\n']));
    if code == base_code {
        return Err(ProposalProblem::Unchanged);
    }
    Ok(AiCodeProposal {
        summary: summary.to_string(),
        code,
        base_code: base_code.to_string(),
    })
}

/// Streams a free-text answer about a review, with a code change when the user
/// asked for one. Text, thinking, usage, and the start of a change reach
/// `on_event` as they arrive; the result carries all of the text and the
/// checked change. A change that cannot be offered becomes a note at the end
/// of the answer.
async fn review_follow_up(
    base_url: &str,
    paths: &AiPaths,
    request: &AiReviewFollowUpRequest,
    on_event: &(dyn Fn(AiStreamEvent) + Sync),
) -> Result<AiReviewFollowUpResult, String> {
    check_follow_up_request(request)?;
    let target = call_target(base_url, paths, Some(&request.selected_model_id)).await?;
    let served = &target.resolved.served;
    let body = claude::follow_up_request_body(served, request);
    let on_update = |update: StreamUpdate<'_>| {
        if let Some(event) = stream_event(update) {
            on_event(event);
        }
    };
    let streamed =
        match claude::stream_message(base_url, &target.key, served, &body, &on_update).await {
            Ok(streamed) => streamed,
            Err(error) => return Err(call_error(base_url, paths, &target, error).await),
        };
    let kind = match request.review.mode {
        AiReviewMode::Review => ledger::KIND_REVIEW_FOLLOW_UP,
        AiReviewMode::Help => ledger::KIND_HELP_FOLLOW_UP,
    };
    let completion = settle(paths, kind, streamed.reply, target.resolved.fell_back)?;
    let mut answer = streamed.text;
    // A refusal already says that nothing came of the request.
    let proposal = match streamed.tool_use {
        Some(tool_use) if completion.outcome != "refused" => {
            let read = if completion.outcome == "ok" && tool_use.stopped {
                read_proposal(&tool_use, &request.current_code)
            } else {
                Err(ProposalProblem::CutOff)
            };
            read.map_err(|problem| {
                let note = proposal_note(problem, request.review.language);
                answer = if answer.trim().is_empty() {
                    note.to_string()
                } else {
                    format!("{}\n\n{note}", answer.trim_end())
                };
            })
            .ok()
        }
        _ => None,
    };
    Ok(AiReviewFollowUpResult {
        outcome: completion.outcome.to_string(),
        answer,
        proposal,
        served_model: completion.served_model,
        fell_back: completion.fell_back,
        usage: completion.usage,
    })
}

fn usage(paths: &AiPaths, bucket_starts_ms: &[i64]) -> Result<AiUsageSummary, String> {
    let ascending = bucket_starts_ms.windows(2).all(|pair| pair[0] < pair[1]);
    if bucket_starts_ms.len() > MAX_USAGE_BUCKETS || !ascending {
        return Err("The usage request was invalid.".to_string());
    }
    let (records, skipped_lines) = ledger::read(&paths.data)?;
    let cache = prices::load_cache(&paths.cache);
    Ok(ledger::summarize(
        &records,
        skipped_lines,
        &cache,
        bucket_starts_ms,
    ))
}

/// With no key there is no traffic of any kind, including price fetches.
async fn refresh_prices_if_keyed(source_url: &str, paths: &AiPaths) -> Result<bool, String> {
    if !matches!(key_store::load(&paths.config), Ok(Some(_))) {
        return Ok(false);
    }
    prices::refresh_if_stale(source_url, &paths.cache, now_ms()).await
}

fn spawn_price_refresh(paths: AiPaths) {
    if PRICE_REFRESH_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = refresh_prices_if_keyed(PRICES_URL, &paths).await {
            eprintln!("Could not refresh AI prices: {error}");
        }
        PRICE_REFRESH_RUNNING.store(false, Ordering::Release);
    });
}

fn ai_paths(app: &tauri::AppHandle) -> Result<AiPaths, String> {
    let resolver = app.path();
    let failed = |error: tauri::Error| format!("Could not locate the app directories: {error}");
    Ok(AiPaths {
        config: resolver.app_config_dir().map_err(failed)?,
        data: resolver.app_data_dir().map_err(failed)?,
        cache: resolver.app_cache_dir().map_err(failed)?,
    })
}

#[tauri::command]
pub(crate) async fn ai_status(app: tauri::AppHandle) -> Result<AiStatus, String> {
    Ok(status(&ai_paths(&app)?))
}

#[tauri::command]
pub(crate) async fn ai_save_key(
    app: tauri::AppHandle,
    api_key: String,
) -> Result<AiKeySaveResult, String> {
    let paths = ai_paths(&app)?;
    let result = save_key(API_BASE_URL, &paths, &api_key).await?;
    spawn_price_refresh(paths);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn ai_clear_key(app: tauri::AppHandle) -> Result<(), String> {
    key_store::clear(&ai_paths(&app)?.config)
}

#[tauri::command]
pub(crate) async fn ai_list_models(
    app: tauri::AppHandle,
    refresh: bool,
) -> Result<AiModelList, String> {
    let paths = ai_paths(&app)?;
    let list = list_models(API_BASE_URL, &paths, refresh).await;
    spawn_price_refresh(paths);
    Ok(list)
}

/// A webview that went away must not fail a call that was already paid for.
fn send_progress(channel: &tauri::ipc::Channel<AiProgressEvent>, event: AiProgressEvent) {
    let _ = channel.send(event);
}

/// A webview that went away must not fail a call that is being paid for.
fn send_stream_event(channel: &tauri::ipc::Channel<AiStreamEvent>, event: AiStreamEvent) {
    let _ = channel.send(event);
}

#[tauri::command]
pub(crate) async fn ai_generate_tests(
    app: tauri::AppHandle,
    request: AiGenerateRequest,
    on_progress: tauri::ipc::Channel<AiProgressEvent>,
) -> Result<AiGenerateResult, String> {
    let paths = ai_paths(&app)?;
    spawn_price_refresh(paths.clone());
    generate_tests(API_BASE_URL, &paths, &request, &|event| {
        send_progress(&on_progress, event)
    })
    .await
}

#[tauri::command]
pub(crate) async fn ai_review_code(
    app: tauri::AppHandle,
    request: AiReviewRequest,
    on_progress: tauri::ipc::Channel<AiProgressEvent>,
    on_event: tauri::ipc::Channel<AiStreamEvent>,
) -> Result<AiReviewResult, String> {
    let paths = ai_paths(&app)?;
    spawn_price_refresh(paths.clone());
    review_code(
        API_BASE_URL,
        &paths,
        &request,
        &|event| send_progress(&on_progress, event),
        &|event| send_stream_event(&on_event, event),
    )
    .await
}

#[tauri::command]
pub(crate) async fn ai_review_follow_up(
    app: tauri::AppHandle,
    request: AiReviewFollowUpRequest,
    on_event: tauri::ipc::Channel<AiStreamEvent>,
) -> Result<AiReviewFollowUpResult, String> {
    let paths = ai_paths(&app)?;
    spawn_price_refresh(paths.clone());
    review_follow_up(API_BASE_URL, &paths, &request, &|event| {
        send_stream_event(&on_event, event)
    })
    .await
}

#[tauri::command]
pub(crate) async fn ai_usage(
    app: tauri::AppHandle,
    bucket_starts_ms: Vec<i64>,
) -> Result<AiUsageSummary, String> {
    let paths = ai_paths(&app)?;
    spawn_price_refresh(paths.clone());
    tauri::async_runtime::spawn_blocking(move || usage(&paths, &bucket_starts_ms))
        .await
        .map_err(|error| format!("The usage task failed: {error}"))?
}

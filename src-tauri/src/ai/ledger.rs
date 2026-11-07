use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use super::prices::{PriceCache, Prices};
use super::{AiModelUsage, AiUsageBucket, AiUsageSummary, AiUsageTotals};

const LEDGER_FILE: &str = "ai-usage.jsonl";
const RECORD_VERSION: u32 = 1;
const OUTCOME_REFUSED: &str = "refused";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UsageRecord {
    #[serde(default = "record_version")]
    pub v: u32,
    pub ts: i64,
    #[serde(default)]
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub inference_geo: Option<String>,
    #[serde(default)]
    pub speed: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default)]
    pub stop_category: Option<String>,
    #[serde(default)]
    pub prices: Option<Prices>,
    #[serde(default)]
    pub prices_fetched_at: Option<i64>,
}

fn record_version() -> u32 {
    RECORD_VERSION
}

pub(super) fn current_version() -> u32 {
    RECORD_VERSION
}

fn ledger_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LEDGER_FILE)
}

/// Two app processes can append at once, so one record is one `write_all` to an
/// `O_APPEND` handle. The leading newline stops a partial tail left by a crash
/// from corrupting this record.
pub(super) fn append(data_dir: &Path, record: &UsageRecord) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let mut buffer = vec![b'\n'];
    serde_json::to_writer(&mut buffer, record).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_path(data_dir))
        .map_err(|error| error.to_string())?;
    file.write_all(&buffer).map_err(|error| error.to_string())
}

/// Blank lines are the separators every record starts with, so only malformed
/// lines count as skipped.
pub(super) fn read(data_dir: &Path) -> Result<(Vec<UsageRecord>, u64), String> {
    let bytes = match fs::read(ledger_path(data_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(error) => return Err(format!("Could not read the usage ledger: {error}")),
    };
    let mut records = Vec::new();
    let mut skipped = 0;
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<UsageRecord>(line) {
            Ok(record) if !record.model.is_empty() => records.push(record),
            _ => skipped += 1,
        }
    }
    Ok((records, skipped))
}

/// `global` is the standard routing and `not_available` marks models that predate
/// the field. Other regions can carry a surcharge that is not computed here.
fn is_approximate(record: &UsageRecord) -> bool {
    let non_default = |value: &Option<String>, defaults: &[&str]| {
        value
            .as_deref()
            .is_some_and(|value| !defaults.contains(&value))
    };
    non_default(&record.inference_geo, &["global", "not_available"])
        || non_default(&record.speed, &["standard"])
        || non_default(&record.service_tier, &["standard"])
}

fn class_cost(tokens: u64, price: Option<f64>) -> Option<f64> {
    if tokens == 0 {
        return Some(0.0);
    }
    Some(tokens as f64 / 1_000_000.0 * price?)
}

/// The ledger is a user-writable file, so a stored price can be anything. A cost
/// that is not a finite, non-negative amount counts as unpriced.
pub(super) fn cost_usd(record: &UsageRecord, prices: &Prices) -> Option<f64> {
    let cost = class_cost(record.input_tokens, Some(prices.input))?
        + class_cost(record.output_tokens, Some(prices.output))?
        + class_cost(record.cache_read_tokens, prices.cache_read)?
        + class_cost(record.cache_write_tokens, prices.cache_write)?;
    (cost.is_finite() && cost >= 0.0).then_some(cost)
}

fn add_record(totals: &mut AiUsageTotals, record: &UsageRecord, cost: Option<f64>) {
    totals.requests += 1;
    totals.input_tokens = totals.input_tokens.saturating_add(record.input_tokens);
    totals.output_tokens = totals.output_tokens.saturating_add(record.output_tokens);
    totals.cache_read_tokens = totals
        .cache_read_tokens
        .saturating_add(record.cache_read_tokens);
    totals.cache_write_tokens = totals
        .cache_write_tokens
        .saturating_add(record.cache_write_tokens);
    if record.outcome == OUTCOME_REFUSED {
        totals.refused_requests += 1;
    }
    if is_approximate(record) {
        totals.approximate_requests += 1;
    }
    match cost {
        Some(cost) => totals.cost_usd = (totals.cost_usd + cost).min(f64::MAX),
        None => totals.unpriced_requests += 1,
    }
}

/// Stored prices keep past amounts stable. Entries recorded without one are
/// priced from the current cache. A bucket runs up to the next start and the
/// last is open-ended, so entries before the first start count toward all time only.
pub(super) fn summarize(
    records: &[UsageRecord],
    skipped_lines: u64,
    cache: &PriceCache,
    bucket_starts_ms: &[i64],
) -> AiUsageSummary {
    let mut all_time = AiUsageTotals::default();
    let mut buckets: Vec<(AiUsageTotals, BTreeMap<&str, AiUsageTotals>)> =
        vec![Default::default(); bucket_starts_ms.len()];
    for record in records {
        let prices = record
            .prices
            .or_else(|| cache.models.get(&record.model).map(|cached| cached.prices));
        let cost = prices.and_then(|prices| cost_usd(record, &prices));
        add_record(&mut all_time, record, cost);
        let started = bucket_starts_ms.partition_point(|start| *start <= record.ts);
        if let Some(index) = started.checked_sub(1) {
            let (totals, per_model) = &mut buckets[index];
            add_record(totals, record, cost);
            add_record(per_model.entry(&record.model).or_default(), record, cost);
        }
    }
    AiUsageSummary {
        buckets: bucket_starts_ms
            .iter()
            .zip(buckets)
            .map(|(start_ms, (totals, per_model))| AiUsageBucket {
                start_ms: *start_ms,
                totals,
                per_model: per_model
                    .into_iter()
                    .map(|(model, totals)| AiModelUsage {
                        model: model.to_string(),
                        totals,
                    })
                    .collect(),
            })
            .collect(),
        all_time,
        skipped_lines,
    }
}

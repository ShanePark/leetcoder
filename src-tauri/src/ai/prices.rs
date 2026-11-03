use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::claude::{client_builder, read_capped};
use super::{write_cache_file, DAY_MS};

const CACHE_FILE: &str = "ai-prices.json";
const PROVIDER: &str = "anthropic";
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// The source was 3.2 MB when reviewed; this leaves room to grow while bounding a
/// hostile or broken response.
const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MIN_USD_PER_MTOK: f64 = 0.001;
const MAX_USD_PER_MTOK: f64 = 1000.0;

/// Prices in USD per million tokens. A missing cache price only matters when a
/// request used that token class.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Prices {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CachedPrice {
    pub prices: Prices,
    pub fetched_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct PriceCache {
    pub fetched_at: Option<i64>,
    attempted_at: Option<i64>,
    pub models: BTreeMap<String, CachedPrice>,
}

fn cache_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(CACHE_FILE)
}

pub(super) fn load_cache(cache_dir: &Path) -> PriceCache {
    fs::read(cache_path(cache_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store_cache(cache_dir: &Path, cache: &PriceCache) -> Result<(), String> {
    let bytes = serde_json::to_vec(cache).map_err(|error| error.to_string())?;
    write_cache_file(&cache_path(cache_dir), &bytes)
}

fn per_mtok(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    // Rounding removes binary noise such as 3e-06 * 1e6 = 3.0000000000000004.
    let price = (value * 1e12).round() / 1e6;
    (MIN_USD_PER_MTOK..=MAX_USD_PER_MTOK)
        .contains(&price)
        .then_some(price)
}

/// An absent or null optional price is fine. A present one that fails the checks
/// rejects the whole row.
fn optional_price(row: &Value, field: &str) -> Result<Option<f64>, ()> {
    match row.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_f64().and_then(per_mtok).map(Some).ok_or(()),
    }
}

pub(super) fn validate_row(row: &Value) -> Option<Prices> {
    let required = |field: &str| row.get(field).and_then(Value::as_f64).and_then(per_mtok);
    let input = required("input_cost_per_token")?;
    let output = required("output_cost_per_token")?;
    let cache_read = optional_price(row, "cache_read_input_token_cost").ok()?;
    let cache_write = optional_price(row, "cache_creation_input_token_cost").ok()?;
    if cache_read.is_some_and(|price| price > input) {
        return None;
    }
    Some(Prices {
        input,
        output,
        cache_read,
        cache_write,
    })
}

/// Rows under other providers can carry the same model under another key at a
/// different price, so only an exact row for this provider counts.
pub(super) fn valid_rows(document: &Value) -> Option<BTreeMap<String, Prices>> {
    let rows = document.as_object()?;
    Some(
        rows.iter()
            .filter(|(_, row)| {
                row.get("litellm_provider").and_then(Value::as_str) == Some(PROVIDER)
            })
            .filter_map(|(id, row)| validate_row(row).map(|prices| (id.clone(), prices)))
            .collect(),
    )
}

async fn fetch_rows(source_url: &str) -> Result<BTreeMap<String, Prices>, String> {
    let client = client_builder(!cfg!(test))
        .build()
        .map_err(|_| "Could not create the price client.".to_string())?;
    let mut response = client
        .get(source_url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| "Could not reach the price source.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The price source returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body = read_capped(&mut response, MAX_SOURCE_BYTES)
        .await
        .map_err(|_| "The price source could not be read.".to_string())?;
    let document: Value = serde_json::from_slice(&body)
        .map_err(|_| "The price source is not valid JSON.".to_string())?;
    let rows = valid_rows(&document)
        .ok_or_else(|| "The price source has an unexpected shape.".to_string())?;
    if rows.is_empty() {
        return Err("The price source has no usable prices.".to_string());
    }
    Ok(rows)
}

/// Refreshes the cache at most once a day, counting failed attempts. Returns whether
/// new prices were stored. Rows are merged into the cache, so a model that left
/// the source or now has a rejected price keeps its last good copy.
pub(super) async fn refresh_if_stale(
    source_url: &str,
    cache_dir: &Path,
    now: i64,
) -> Result<bool, String> {
    let mut cache = load_cache(cache_dir);
    if cache
        .attempted_at
        .is_some_and(|attempted| now - attempted < DAY_MS)
    {
        return Ok(false);
    }
    cache.attempted_at = Some(now);
    store_cache(cache_dir, &cache)?;

    let rows = fetch_rows(source_url).await?;
    // Another app process may have written while this fetch ran.
    let mut cache = load_cache(cache_dir);
    cache.models.extend(rows.into_iter().map(|(id, prices)| {
        (
            id,
            CachedPrice {
                prices,
                fetched_at: now,
            },
        )
    }));
    cache.fetched_at = Some(now);
    store_cache(cache_dir, &cache)?;
    Ok(true)
}

//! Native steps of the prompt eval, driven by `eval/prompt-eval.ts` through
//! ignored tests. Each step reads its input from `LEETCODER_EVAL_INPUT` and writes
//! to `LEETCODER_EVAL_OUTPUT`. Without those it does nothing, so
//! `cargo test -- --ignored` can never spend money by accident.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use super::{generate_tests, ledger, AiGenerateRequest, AiPaths, API_BASE_URL};

const APP_IDENTIFIER: &str = "com.shane.leetcoder";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchInput {
    numbers: Vec<String>,
    ps_repo: String,
    cache_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchOutput {
    java_home: PathBuf,
    errors: Vec<String>,
}

#[derive(Deserialize)]
struct GenerateCase {
    id: String,
    request: AiGenerateRequest,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    id: String,
    outcome: Option<String>,
    statements: Vec<String>,
    served_model: Option<String>,
    wrong_model: bool,
    error: Option<String>,
    usage: Option<CaseUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cost_usd: Option<f64>,
}

fn io_paths() -> Option<(PathBuf, PathBuf)> {
    let input = std::env::var_os("LEETCODER_EVAL_INPUT")?;
    let output = std::env::var_os("LEETCODER_EVAL_OUTPUT")?;
    Some((PathBuf::from(input), PathBuf::from(output)))
}

fn read_input<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let bytes = fs::read(path).expect("read the eval input");
    serde_json::from_slice(&bytes).expect("parse the eval input")
}

fn write_json(path: &Path, value: &impl Serialize) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create the eval output directory");
    }
    let bytes = serde_json::to_vec_pretty(value).expect("serialize the eval output");
    fs::write(path, bytes).expect("write the eval output");
}

/// Mirrors where Tauri puts the app's directories, so the eval uses the app's own
/// key, model catalog, price cache, and usage ledger.
fn app_paths() -> AiPaths {
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME is set"));
    let (config, data, cache) = platform_dirs(&home);
    AiPaths {
        config: config.join(APP_IDENTIFIER),
        data: data.join(APP_IDENTIFIER),
        cache: cache.join(APP_IDENTIFIER),
    }
}

#[cfg(target_os = "macos")]
fn platform_dirs(home: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let support = home.join("Library/Application Support");
    (support.clone(), support, home.join("Library/Caches"))
}

#[cfg(not(target_os = "macos"))]
fn platform_dirs(home: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let xdg = |variable: &str, fallback: &str| {
        std::env::var_os(variable)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(fallback))
    };
    (
        xdg("XDG_CONFIG_HOME", ".config"),
        xdg("XDG_DATA_HOME", ".local/share"),
        xdg("XDG_CACHE_HOME", ".cache"),
    )
}

/// Free: inspects the Ps library once and finds a JDK. It sends no LeetCode request.
#[test]
#[ignore = "run by the prompt eval driver"]
fn eval_fetch() {
    let Some((input_path, output_path)) = io_paths() else {
        return;
    };
    let input: FetchInput = read_input(&input_path);
    let mut errors = Vec::new();

    let metadata_path = input.cache_dir.join("ps-metadata.json");
    if !metadata_path.exists() {
        let metadata = crate::security::canonical_project_root(&input.ps_repo)
            .and_then(|root| crate::java_library::inspect_ps_library(&root));
        match metadata {
            Ok(metadata) => write_json(&metadata_path, &metadata),
            Err(error) => errors.push(format!("Ps library: {error}")),
        }
    }

    let java_home = crate::runner::discover_compatible_java()
        .expect("find a JDK compatible with the Gradle wrapper")
        .home;
    write_json(&output_path, &FetchOutput { java_home, errors });
}

/// Paid: one real call per case through the app's own path, with no retries.
#[test]
#[ignore = "run by the prompt eval driver; spends money"]
fn eval_generate() {
    let Some((input_path, output_path)) = io_paths() else {
        return;
    };
    let cases: Vec<GenerateCase> = read_input(&input_path);
    let paths = app_paths();
    let mut results = Vec::new();

    for case in &cases {
        let result = generate_case(&paths, case);
        let stop = result.wrong_model;
        results.push(result);
        // Rewritten after each call so a crash keeps what was already paid for.
        write_json(&output_path, &results);
        if stop {
            break;
        }
    }
    write_json(&output_path, &results);
}

fn generate_case(paths: &AiPaths, case: &GenerateCase) -> CaseResult {
    // An empty pin would quietly select the default model.
    let requested = case
        .request
        .selected_model_id
        .as_deref()
        .filter(|model| !model.is_empty())
        .expect("every eval request names its model");
    let before = ledger_len(paths);
    let reply = tauri::async_runtime::block_on(generate_tests(API_BASE_URL, paths, &case.request));
    let usage = last_usage(paths, before);
    match reply {
        Ok(reply) => CaseResult {
            id: case.id.clone(),
            wrong_model: reply.fell_back || !same_model(&reply.served_model, requested),
            outcome: Some(reply.outcome),
            statements: reply.statements,
            served_model: Some(reply.served_model),
            usage,
            ..CaseResult::default()
        },
        Err(error) => CaseResult {
            id: case.id.clone(),
            error: Some(error),
            usage,
            ..CaseResult::default()
        },
    }
}

/// A dated snapshot of the requested model is still that model.
fn same_model(served: &str, requested: &str) -> bool {
    served == requested || served.starts_with(&format!("{requested}-"))
}

fn ledger_len(paths: &AiPaths) -> usize {
    ledger::read(&paths.data).map_or(0, |(records, _)| records.len())
}

fn last_usage(paths: &AiPaths, before: usize) -> Option<CaseUsage> {
    let (records, _) = ledger::read(&paths.data).ok()?;
    if records.len() <= before {
        return None;
    }
    let record = records.last()?;
    Some(CaseUsage {
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
        cost_usd: record
            .prices
            .as_ref()
            .and_then(|prices| ledger::cost_usd(record, prices)),
    })
}

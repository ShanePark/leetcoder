//! Native steps of the prompt eval, driven by `eval/prompt-eval.ts` through
//! ignored tests. Each step reads its input from `LEETCODER_EVAL_INPUT` and writes
//! to `LEETCODER_EVAL_OUTPUT`. Without those it does nothing, so
//! `cargo test -- --ignored` can never spend money by accident.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use super::{generate_tests, ledger, AiGenerateRequest, AiPaths, AiRequestUsage, API_BASE_URL};
use crate::leetcode::parse_problem_detail;
use crate::models::DailyProblem;

const APP_IDENTIFIER: &str = "com.shane.leetcoder";
const MAX_CONCURRENT_CALLS: usize = 5;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareInput {
    fixtures: Vec<Fixture>,
    ps_repo: String,
    cache_dir: PathBuf,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareOutput {
    java_home: PathBuf,
    problems: BTreeMap<String, DailyProblem>,
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
    usage: Option<AiRequestUsage>,
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

/// Free: parses the fixtures as the app parses a real response, inspects the Ps
/// library once, and finds a JDK. It sends no LeetCode request.
#[test]
#[ignore = "run by the prompt eval driver"]
fn eval_prepare() {
    let Some((input_path, output_path)) = io_paths() else {
        return;
    };
    let input: PrepareInput = read_input(&input_path);
    let mut errors = Vec::new();

    let mut problems = BTreeMap::new();
    for fixture in &input.fixtures {
        match parse_fixture(&fixture.path) {
            Ok(problem) => {
                problems.insert(fixture.name.clone(), problem);
            }
            Err(error) => errors.push(format!("{}: {error}", fixture.name)),
        }
    }

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
    write_json(
        &output_path,
        &PrepareOutput {
            java_home,
            problems,
            errors,
        },
    );
}

fn parse_fixture(path: &Path) -> Result<DailyProblem, String> {
    let body = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let problem = parse_problem_detail(&body)?;
    if problem.content.is_none() {
        return Err("The fixture has no content.".to_string());
    }
    Ok(problem)
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
    write_json(&output_path, &Vec::<CaseResult>::new());
    run_calls(
        &cases,
        |case| generate_case(&paths, case),
        // Rewritten after each call so a crash keeps what was already paid for.
        |results| write_json(&output_path, &results),
    );
}

/// A prompt cache entry is only readable once a response has begun, so concurrent
/// first calls would each pay to write it. Calls stay one at a time until one gets a
/// response. A wrong model starts no further call, and the ones in flight finish.
fn run_calls<C: Sync>(
    cases: &[C],
    generate: impl Fn(&C) -> CaseResult + Sync,
    save: impl Fn(Vec<&CaseResult>) + Sync,
) {
    let results = Mutex::new(cases.iter().map(|_| None).collect::<Vec<_>>());
    let stop = AtomicBool::new(false);
    let call = |index: usize| {
        let result = generate(&cases[index]);
        let responded = result.usage.is_some();
        if result.wrong_model {
            stop.store(true, Ordering::SeqCst);
        }
        let mut results = results.lock().expect("no call panicked while saving");
        results[index] = Some(result);
        save(results.iter().flatten().collect());
        responded
    };

    let mut first_concurrent = 0;
    while first_concurrent < cases.len() && !stop.load(Ordering::SeqCst) {
        first_concurrent += 1;
        if call(first_concurrent - 1) {
            break;
        }
    }

    let next = AtomicUsize::new(first_concurrent);
    thread::scope(|scope| {
        for _ in 0..MAX_CONCURRENT_CALLS {
            scope.spawn(|| {
                while !stop.load(Ordering::SeqCst) {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    if index >= cases.len() {
                        break;
                    }
                    call(index);
                }
            });
        }
    });
}

fn generate_case(paths: &AiPaths, case: &GenerateCase) -> CaseResult {
    // An empty pin would quietly select the default model.
    let requested = case
        .request
        .selected_model_id
        .as_deref()
        .filter(|model| !model.is_empty())
        .expect("every eval request names its model");
    // Records from concurrent calls interleave in the app's ledger, so each call
    // writes to its own to tie the usage to this case, then moves the record over.
    let call_data = tempfile::tempdir().expect("create a ledger directory for the call");
    let call_paths = AiPaths {
        data: call_data.path().to_path_buf(),
        ..paths.clone()
    };
    let reply = tauri::async_runtime::block_on(generate_tests(
        API_BASE_URL,
        &call_paths,
        &case.request,
        &|_| {},
    ));
    let usage = move_usage(call_data.path(), &paths.data);
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

fn move_usage(call_data: &Path, app_data: &Path) -> Option<AiRequestUsage> {
    let (records, _) = ledger::read(call_data).ok()?;
    let record = records.last()?;
    // A paid-for result outweighs a missing ledger line, as in the app.
    if let Err(error) = ledger::append(app_data, record) {
        eprintln!("Could not record AI usage: {error}");
    }
    Some(ledger::request_usage(record))
}

/// Records each call's start and end, for checking how calls overlap.
#[derive(Default)]
struct CallLog {
    events: Mutex<Vec<(usize, bool)>>,
}

impl CallLog {
    fn call(&self, case: usize, result: CaseResult) -> CaseResult {
        self.events.lock().unwrap().push((case, true));
        thread::sleep(std::time::Duration::from_millis(20));
        self.events.lock().unwrap().push((case, false));
        result
    }

    fn events(&self) -> Vec<(usize, bool)> {
        self.events.lock().unwrap().clone()
    }

    fn peak(&self) -> usize {
        let mut running = 0usize;
        let mut peak = 0;
        for (_, started) in self.events() {
            running = if started { running + 1 } else { running - 1 };
            peak = peak.max(running);
        }
        peak
    }
}

fn answered(case: usize) -> CaseResult {
    CaseResult {
        id: case.to_string(),
        usage: Some(AiRequestUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: None,
        }),
        ..CaseResult::default()
    }
}

#[test]
fn run_calls_finishes_the_first_call_before_the_rest_and_keeps_case_order() {
    let cases: Vec<usize> = (0..18).collect();
    let log = CallLog::default();
    let saved = Mutex::new(Vec::new());
    run_calls(
        &cases,
        |case| log.call(*case, answered(*case)),
        |results| {
            *saved.lock().unwrap() = results.iter().map(|result| result.id.clone()).collect();
        },
    );

    assert_eq!(log.events()[..2], [(0, true), (0, false)]);
    assert!(log.peak() > 1 && log.peak() <= MAX_CONCURRENT_CALLS);
    let expected: Vec<String> = cases.iter().map(ToString::to_string).collect();
    assert_eq!(*saved.lock().unwrap(), expected);
}

#[test]
fn run_calls_stays_sequential_until_a_call_gets_a_response() {
    let cases: Vec<usize> = (0..8).collect();
    let log = CallLog::default();
    run_calls(
        &cases,
        |case| {
            log.call(
                *case,
                if *case < 2 {
                    CaseResult::default()
                } else {
                    answered(*case)
                },
            )
        },
        |_| {},
    );

    assert_eq!(
        log.events()[..6],
        [
            (0, true),
            (0, false),
            (1, true),
            (1, false),
            (2, true),
            (2, false)
        ]
    );
    assert_eq!(log.events().len(), 16);
}

#[test]
fn run_calls_starts_nothing_after_a_wrong_model() {
    let cases: Vec<usize> = (0..18).collect();
    let log = CallLog::default();
    run_calls(
        &cases,
        |case| {
            log.call(
                *case,
                CaseResult {
                    wrong_model: true,
                    ..answered(*case)
                },
            )
        },
        |_| {},
    );

    assert_eq!(log.events(), [(0, true), (0, false)]);
}

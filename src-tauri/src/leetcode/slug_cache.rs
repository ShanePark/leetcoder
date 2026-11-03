use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::async_runtime::Mutex;
use tempfile::NamedTempFile;

const CACHE_FILE: &str = "leetcode-problem-slugs.json";
const INDEX_REQUEST_GAP: Duration = Duration::from_secs(10 * 60);

type Slugs = BTreeMap<String, String>;

struct ResolverState {
    requested_at: Option<Instant>,
    last_failure: Option<String>,
    /// The last index received, so a failed cache write does not lose it.
    slugs: Slugs,
}

/// Turns a normalized frontend number into a title slug. The cache file outlives
/// the app, while the request limit lasts for one resolver, which is one app run.
pub(super) struct SlugResolver {
    state: Mutex<ResolverState>,
}

impl SlugResolver {
    pub(super) const fn new() -> Self {
        Self {
            state: Mutex::const_new(ResolverState {
                requested_at: None,
                last_failure: None,
                slugs: BTreeMap::new(),
            }),
        }
    }

    pub(super) async fn resolve<F, Fut>(
        &self,
        cache_dir: &Path,
        frontend_id: &str,
        now: Instant,
        fetch_index: F,
    ) -> Result<String, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Slugs, String>>,
    {
        // Read before locking, so a hit never waits on an index request in flight.
        if let Some(slug) = load_slugs(cache_dir).remove(frontend_id) {
            return Ok(slug);
        }

        // Held across the request, so a concurrent miss waits and then reads the outcome.
        let mut state = self.state.lock().await;
        if let Some(slug) = state.slugs.get(frontend_id) {
            return Ok(slug.clone());
        }
        if state
            .requested_at
            .is_some_and(|at| now.saturating_duration_since(at) < INDEX_REQUEST_GAP)
        {
            return Err(match &state.last_failure {
                Some(cause) => {
                    format!("The LeetCode problem lookup failed. Try again later. ({cause})")
                }
                None => not_found(frontend_id),
            });
        }

        // Recorded before the request, so even an abandoned attempt counts.
        state.requested_at = Some(now);
        state.last_failure = None;
        match fetch_index().await {
            Ok(slugs) => {
                if let Err(error) = store_slugs(cache_dir, &slugs) {
                    eprintln!("Could not store the LeetCode problem slugs: {error}");
                }
                state.slugs = slugs;
                state
                    .slugs
                    .get(frontend_id)
                    .cloned()
                    .ok_or_else(|| not_found(frontend_id))
            }
            Err(error) => {
                state.last_failure = Some(error.clone());
                Err(error)
            }
        }
    }
}

fn not_found(frontend_id: &str) -> String {
    format!("LeetCode problem #{frontend_id} was not found")
}

fn cache_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(CACHE_FILE)
}

fn load_slugs(cache_dir: &Path) -> Slugs {
    fs::read(cache_path(cache_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Merged into the file, so a short or broken index cannot remove known numbers.
fn store_slugs(cache_dir: &Path, fetched: &Slugs) -> Result<(), String> {
    let mut slugs = load_slugs(cache_dir);
    slugs.extend(fetched.clone());
    let bytes = serde_json::to_vec(&slugs).map_err(|error| error.to_string())?;

    fs::create_dir_all(cache_dir).map_err(|error| error.to_string())?;
    let mut temporary = NamedTempFile::new_in(cache_dir).map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .persist(cache_path(cache_dir))
        .map_err(|error| error.error.to_string())?;
    Ok(())
}

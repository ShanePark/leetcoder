use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

const PENDING_STOP_TTL: Duration = Duration::from_secs(30);
const MAX_PENDING_STOPS: usize = 64;
const MAX_FINISHED_RUNS: usize = 128;

#[derive(Default)]
struct TestRunRegistry {
    active: HashMap<u64, Arc<TestRunControl>>,
    pending_stops: HashMap<u64, Instant>,
    finished: HashMap<u64, Instant>,
}

static ACTIVE_TEST_RUNS: OnceLock<Mutex<TestRunRegistry>> = OnceLock::new();

fn active_test_runs() -> &'static Mutex<TestRunRegistry> {
    ACTIVE_TEST_RUNS.get_or_init(|| Mutex::new(TestRunRegistry::default()))
}

fn expire_pending_stops(registry: &mut TestRunRegistry) {
    registry
        .pending_stops
        .retain(|_, created_at| created_at.elapsed() < PENDING_STOP_TTL);
    registry
        .finished
        .retain(|_, finished_at| finished_at.elapsed() < PENDING_STOP_TTL);
}

fn prune_finished_runs(registry: &mut TestRunRegistry) {
    while registry.finished.len() > MAX_FINISHED_RUNS {
        let Some(oldest_run_id) = registry
            .finished
            .iter()
            .min_by_key(|(_, finished_at)| **finished_at)
            .map(|(id, _)| *id)
        else {
            break;
        };
        registry.finished.remove(&oldest_run_id);
    }
}

#[derive(Debug)]
pub(crate) struct TestRunControl {
    cancel_requested: AtomicBool,
    timed_out: AtomicBool,
    process_interrupted: AtomicBool,
    process_finished: AtomicBool,
    tests_started_at: Mutex<Option<Instant>>,
}

impl TestRunControl {
    pub(crate) fn new() -> Self {
        Self {
            cancel_requested: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
            process_interrupted: AtomicBool::new(false),
            process_finished: AtomicBool::new(false),
            tests_started_at: Mutex::new(None),
        }
    }

    pub(super) fn mark_tests_started(&self) {
        let mut started_at = self
            .tests_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        started_at.get_or_insert_with(Instant::now);
    }

    pub(super) fn tests_elapsed(&self) -> Option<Duration> {
        self.tests_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(Instant::elapsed)
    }

    fn request_cancel(&self) -> bool {
        if self.process_finished.load(Ordering::Acquire) {
            return false;
        }
        self.cancel_requested.store(true, Ordering::Release);
        !self.process_finished.load(Ordering::Acquire)
    }

    pub(super) fn request_timeout(&self) {
        self.timed_out.store(true, Ordering::Release);
        self.cancel_requested.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub(crate) fn is_timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Acquire)
    }

    pub(super) fn mark_process_interrupted(&self) {
        self.process_interrupted.store(true, Ordering::Release);
    }

    pub(super) fn was_process_interrupted(&self) -> bool {
        self.process_interrupted.load(Ordering::Acquire)
    }

    pub(crate) fn mark_process_finished(&self) {
        self.process_finished.store(true, Ordering::Release);
    }
}

pub(crate) struct TestRunRegistration {
    run_id: u64,
    control: Arc<TestRunControl>,
}

impl TestRunRegistration {
    pub(crate) fn control(&self) -> Arc<TestRunControl> {
        self.control.clone()
    }
}

impl Drop for TestRunRegistration {
    fn drop(&mut self) {
        let mut runs = active_test_runs()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runs
            .active
            .get(&self.run_id)
            .is_some_and(|control| Arc::ptr_eq(control, &self.control))
        {
            runs.active.remove(&self.run_id);
            runs.finished.insert(self.run_id, Instant::now());
            prune_finished_runs(&mut runs);
        }
    }
}

pub(crate) fn register_test_run(run_id: u64) -> Result<TestRunRegistration, String> {
    let mut runs = active_test_runs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    expire_pending_stops(&mut runs);
    if runs.active.contains_key(&run_id) {
        return Err(format!("Test run id {run_id} is already active."));
    }
    runs.finished.remove(&run_id);
    let control = Arc::new(TestRunControl::new());
    if runs.pending_stops.remove(&run_id).is_some() {
        control.request_cancel();
    }
    runs.active.insert(run_id, control.clone());
    Ok(TestRunRegistration { run_id, control })
}

pub(crate) fn stop_test_run(run_id: u64) -> bool {
    let mut runs = active_test_runs()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    expire_pending_stops(&mut runs);
    if let Some(control) = runs.active.get(&run_id) {
        return control.request_cancel();
    }
    if runs.finished.contains_key(&run_id) {
        return false;
    }
    if runs.pending_stops.len() >= MAX_PENDING_STOPS {
        if let Some(oldest_run_id) = runs
            .pending_stops
            .iter()
            .min_by_key(|(_, created_at)| **created_at)
            .map(|(id, _)| *id)
        {
            runs.pending_stops.remove(&oldest_run_id);
        }
    }
    runs.pending_stops.insert(run_id, Instant::now());
    true
}

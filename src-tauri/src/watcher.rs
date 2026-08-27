use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::security::{
    all_package_directories, canonical_project_root, is_source_file, relative_path,
};

/// The event name the webview listens on for external repository changes.
pub(crate) const FILES_CHANGED_EVENT: &str = "repository-files-changed";

/// One editor save usually produces several filesystem events (truncate,
/// write, chmod, rename). Coalescing them into one message keeps the webview
/// from re-reading the same file once per syscall.
const COALESCE_WINDOW: Duration = Duration::from_millis(120);

/// Problem source files that changed outside this application.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryFilesChanged {
    /// Repository-relative POSIX paths, sorted and de-duplicated.
    pub paths: Vec<String>,
    /// True when a source file was created, removed, or renamed. The file
    /// list itself is then stale, not just the content of an open buffer.
    pub structural: bool,
}

/// The watcher for the currently selected repository, if any.
///
/// Only one repository is open at a time, so replacing the stored watcher is
/// what stops the previous one: dropping it releases the OS watch handles and
/// the channel sender, which in turn ends the forwarding thread.
#[derive(Default)]
pub struct RepositoryWatcher {
    active: Mutex<Option<RecommendedWatcher>>,
}

impl RepositoryWatcher {
    fn replace(&self, watcher: Option<RecommendedWatcher>) {
        // A panic in another thread must not permanently disable watching;
        // the guarded value is replaced outright rather than read back.
        let mut active = self.active.lock().unwrap_or_else(|error| error.into_inner());
        *active = watcher;
    }
}

pub(crate) fn watch(
    app: AppHandle,
    state: &RepositoryWatcher,
    project_root: &str,
) -> Result<(), String> {
    let root = canonical_project_root(project_root)?;
    let directories = all_package_directories(&root)?;
    let (sender, receiver) = mpsc::channel::<Event>();

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            // A closed receiver only means the repository changed; the next
            // watcher owns the new channel.
            let _ = sender.send(event);
        }
    })
    .map_err(|error| format!("Unable to watch the repository: {error}"))?;

    for directory in &directories {
        watcher
            .watch(directory, RecursiveMode::Recursive)
            .map_err(|error| {
                format!(
                    "Unable to watch package directory '{}': {error}",
                    directory.display()
                )
            })?;
    }

    thread::spawn(move || forward_changes(&app, &root, &receiver));
    state.replace(Some(watcher));
    Ok(())
}

pub(crate) fn unwatch(state: &RepositoryWatcher) {
    state.replace(None);
}

fn forward_changes(app: &AppHandle, root: &Path, receiver: &Receiver<Event>) {
    while let Ok(first) = receiver.recv() {
        let mut paths = BTreeSet::new();
        let mut structural = false;
        absorb(root, &first, &mut paths, &mut structural);

        let mut disconnected = false;
        loop {
            match receiver.recv_timeout(COALESCE_WINDOW) {
                Ok(event) => absorb(root, &event, &mut paths, &mut structural),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        if !paths.is_empty() {
            let payload = RepositoryFilesChanged {
                paths: paths.into_iter().collect(),
                structural,
            };
            // A closing window is not a watcher failure.
            let _ = app.emit(FILES_CHANGED_EVENT, payload);
        }
        if disconnected {
            return;
        }
    }
}

fn absorb(root: &Path, event: &Event, paths: &mut BTreeSet<String>, structural: &mut bool) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }

    let mut matched = false;
    for path in &event.paths {
        if !is_source_file(path) {
            continue;
        }
        if let Ok(relative) = relative_path(root, path) {
            paths.insert(relative);
            matched = true;
        }
    }

    // Editors that save through a temporary file report the final name as a
    // rename, so renames count as structural alongside create and remove.
    if matched && is_structural(&event.kind) {
        *structural = true;
    }
}

fn is_structural(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RenameMode};
    use std::path::PathBuf;

    fn event(kind: EventKind, paths: &[&str]) -> Event {
        Event {
            kind,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn absorb_collects_relative_source_paths() {
        let root = Path::new("/repo");
        let mut paths = BTreeSet::new();
        let mut structural = false;
        absorb(
            root,
            &event(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                &["/repo/src/main/java/shane/leetcode/problems/easy/Q1.java"],
            ),
            &mut paths,
            &mut structural,
        );
        assert_eq!(
            paths.iter().cloned().collect::<Vec<_>>(),
            vec!["src/main/java/shane/leetcode/problems/easy/Q1.java".to_string()]
        );
        assert!(!structural);
    }

    #[test]
    fn absorb_ignores_non_source_and_outside_paths() {
        let root = Path::new("/repo");
        let mut paths = BTreeSet::new();
        let mut structural = false;
        absorb(
            root,
            &event(
                EventKind::Create(CreateKind::File),
                &["/repo/easy/.Q1.java.swp", "/elsewhere/Q1.java"],
            ),
            &mut paths,
            &mut structural,
        );
        assert!(paths.is_empty());
        assert!(!structural);
    }

    #[test]
    fn absorb_marks_creates_removes_and_renames_structural() {
        let root = Path::new("/repo");
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Remove(notify::event::RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        ] {
            let mut paths = BTreeSet::new();
            let mut structural = false;
            absorb(
                root,
                &event(kind, &["/repo/easy/Q1.java"]),
                &mut paths,
                &mut structural,
            );
            assert!(structural, "expected a structural change");
        }
    }

    #[test]
    fn absorb_skips_access_events() {
        let root = Path::new("/repo");
        let mut paths = BTreeSet::new();
        let mut structural = false;
        absorb(
            root,
            &event(
                EventKind::Access(notify::event::AccessKind::Read),
                &["/repo/easy/Q1.java"],
            ),
            &mut paths,
            &mut structural,
        );
        assert!(paths.is_empty());
    }
}

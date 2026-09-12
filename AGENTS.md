## Implementation

- Read the relevant code, tests, and local instructions before editing.
- Before implementation, ask clarifying questions about any remaining material ambiguity that affects scope, behavior, interfaces, or acceptance criteria. Do not proceed on material assumptions.
- Make the smallest, simplest change that fully satisfies the request.
- Do not invent requirements, broaden scope, or add speculative abstractions or dependencies.
- Follow existing conventions and preserve unrelated behavior and work.
- Write clear code. Comment only non-obvious rationale, invariants, or constraints.
- Keep commit messages, code comments, documentation, and user-facing copy focused on behavior and function; avoid unnecessary references to specific products or brands. Preserve required API identifiers and license attributions.
- Keyboard shortcuts follow the policy in `## Keyboard Shortcuts` below.

## Keyboard Shortcuts

The goal is one set of muscle memory across a MacBook and a Linux machine. On a
Mac keyboard the modifier next to the space bar is `Cmd`; on a Linux keyboard
the key in that same place is `Alt`. So a shortcut is defined by the *physical
key* the thumb lands on, and `Cmd` on macOS pairs with `Alt` on Linux — not
with `Ctrl`.

- Declare every shortcut in `src/shortcuts.ts`. It is the single source of
  truth: the keymap, the in-app list, and every button, tooltip, and gutter
  hint read from it. Never hardcode a shortcut label anywhere else — call
  `shortcutLabel(id, macPlatform)`.
- Bind each shortcut as both `Mod-<key>` and `Alt-<key>`. `Mod` is `Cmd` on
  macOS and `Ctrl` elsewhere, so this registers the Mac chord, its Linux twin,
  and the `Ctrl` form that other editors train.
- `Alt-` is the form Linux advertises and `Mod-` is the form macOS advertises.
  `platformBindings` orders them; the `Ctrl` twin stays bound but is never the
  primary label. Save shows as `Alt+S` on Linux and `⌘S` on macOS; JavaDoc as
  `Alt+Shift+J` and `⇧⌘J`.
- Exceptions are shortcuts that are the same chord on both platforms already —
  `Ctrl-Space`, and platform-independent chords the user asked for verbatim
  such as `Mod-Alt-l` for reformat. These get no `Alt-` twin.
- macOS turns `Option`+letter into a typed glyph, so CodeMirror's key names do
  not match those bindings. Every `Alt-` shortcut also needs a matcher in
  `src/editor.ts` that works from `event.code`, registered in
  `altShortcutCommands`.
- Non-macOS labels print modifiers in the order `Ctrl`, `Alt`, `Shift`; macOS
  labels use the stacked glyphs in the order the binding is written.

## Delegation and Parallel Work

- The main agent's primary role is orchestration: planning, decomposition, delegation, coordination, review, user communication, and handling additional work—not hands-on execution.
- Delegate repository exploration, implementation, testing, and verification to subagents by default. Do not occupy the main agent with substantial work that can be delegated.
- Maximize safe parallelism across independent workstreams.
- The main agent may directly handle only brief, local tasks that do not benefit from delegation, as well as integration, conflict resolution, or work that requires its broader context.
- Give each delegated task a single owner with explicit scope, deliverables, dependencies, and verification criteria.
- Parallelize only independent work. Concurrent writes must not overlap in files, mutable state, or contracts.
- Shared files and cross-cutting contracts must have a single owner.
- The main agent remains accountable for integration, review of the final diff and verification results, and the accuracy of the completion report.

## Completion

- Run verification proportional to the change, starting with focused checks and expanding based on risk and blast radius.
- Never weaken or bypass tests or checks to make a change pass.
- Do not claim completion without relevant verification. State exactly what was not verified and why.
- Distinguish failures caused by the current change from pre-existing failures.
- Report what changed, the checks run and their results, unverified areas, and remaining risks or assumptions.

## Git

- Do not perform version-control operations that change local or remote repository state unless explicitly requested.
- Before any requested version-control write, inspect the working tree and relevant diffs.
- Commit only changes made for the current task.
- Treat pre-existing changes as user-owned. Never discard, overwrite, stage, or commit unrelated work.

## Desktop verification and installation

- Frontend-only checks (`npm run build`) do not update the desktop application launched from the Dock.
- After completing any source change that affects desktop behavior, run the relevant automated checks and then run `npm run rebuild` before reporting the work complete.
- `npm run rebuild` performs the platform-specific Tauri production build, atomically installs the new binary used by the macOS Dock or Ubuntu application launcher, and restarts leetcoder.
- If the rebuild command is unavailable or fails, do not claim that the Dock application was updated. Report the blocker and the build log location instead.
- Preserve unrelated working-tree changes while building and installing.

## Rust/Tauri build artifacts

- The default Rust development profile keeps line tables for this crate and omits debug information from dependencies. Use the opt-in `debugging` profile (`cargo build --profile debugging`, or the equivalent Tauri command) when full debug information is required.
- Agent-run `cargo check`, `cargo test`, `cargo build`, and disposable Tauri verification must use a task-specific temporary `CARGO_TARGET_DIR` and `CARGO_INCREMENTAL=0`. Remove that temporary target directory after verification so checks do not accumulate in `src-tauri/target`.
- Keep the persistent `src-tauri/target` directory for interactive development only. Do not run `cargo clean` after every command; clean persistent artifacts deliberately when they are stale or no longer needed.
- Production rebuilds that must install the desktop app are an intentional exception: run `npm run rebuild` with its persistent target path because the rebuild script installs the bundle from `src-tauri/target/release/bundle`. Preserve that path for the required rebuild/install workflow.

## Architecture and work ownership

- Use [docs/architecture.md](docs/architecture.md) as the source of truth for current module responsibilities, dependency direction, public facades, and parallel ownership.
- Before editing, claim a concrete path set, its dependencies, and focused checks. Do not assign two agents the same source path or existing test file.
- Shared contracts and wiring have one owner at a time: `src/backend/contracts.ts`, `src/app/types.ts`, `src-tauri/src/models.rs`, Tauri command registration, public barrels, and the ordered `src/styles.css` imports. Agents may read these files in parallel; contract changes are integrated sequentially with their consumers and tests.
- Prefer parallel work on independent leaf modules and their owned tests. Keep `src/app.ts`, `src/editor.ts`, `src/backend.ts`, native command wiring, and native facade modules as integration boundaries unless the assigned owner is explicitly changing that boundary.
- Preserve frontend public facades, native command names, serialized DTO shapes, event names, and the shortcut policy while moving implementation code. Shortcut definitions remain owned by `src/shortcuts.ts` with matching editor event handling.
- After leaf checks, the integrator runs `npm run typecheck`, `npm test`, `npm run build`, and the Rust format/test/check commands. Source changes also require `npm run rebuild` before reporting desktop behavior as verified.

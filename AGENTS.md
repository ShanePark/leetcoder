## Implementation

- Read the relevant code, tests, and local instructions before editing.
- Before implementation, ask clarifying questions about any remaining material ambiguity that affects scope, behavior, interfaces, or acceptance criteria. Do not proceed on material assumptions.
- Make the smallest, simplest change that fully satisfies the request.
- Do not invent requirements, broaden scope, or add speculative abstractions or dependencies.
- Follow existing conventions and preserve unrelated behavior and work.
- Write clear code. Comment only non-obvious rationale, invariants, or constraints.
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
  `Ctrl-Space`, and IntelliJ chords the user asked for verbatim such as
  `Mod-Alt-l` for reformat. These get no `Alt-` twin.
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

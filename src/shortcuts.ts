/**
 * The single source of truth for leetcoder's keyboard shortcuts.
 *
 * Bindings are written in CodeMirror's notation, where `Mod` is `Cmd` on macOS
 * and `Ctrl` elsewhere. The policy is that a shortcut is the *same physical
 * chord* on both platforms: macOS `Cmd` sits where Linux has `Alt`, so every
 * plain `Mod-` binding also gets an `Alt-` twin, and `Alt-` is the form Linux
 * advertises. The `Mod-` twin stays registered on Linux as `Ctrl-` so muscle
 * memory from other editors still works, but it is never the primary label.
 * The explicit Ctrl bindings and IntelliJ-style `Mod-Alt-*` chords are the
 * platform-independent exceptions.
 *
 * Both forms are listed here so the in-app list matches what is registered.
 */

export interface ShortcutEntry {
  /** Stable key for the labels rendered outside the shortcut list. */
  id: string
  /** Equivalent bindings, most idiomatic first. */
  bindings: readonly string[]
  description: string
  /** Show this entry in the compact hint strip on the empty editor. */
  hint?: boolean
}

export interface ShortcutSection {
  title: string
  entries: readonly ShortcutEntry[]
}

/** Keyboard fields used when matching a shortcut outside CodeMirror. */
export interface ShortcutKeyEvent {
  key: string
  /** Physical key code for punctuation bindings whose Alt form may compose. */
  code?: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

export type RunShortcutId = 'run-test-at-cursor' | 'run-test'

export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    title: 'Editing',
    entries: [
      { id: 'duplicate-line', bindings: ['Mod-d', 'Alt-d'], description: 'Duplicate line', hint: true },
      { id: 'delete-line', bindings: ['Mod-Backspace', 'Alt-Backspace'], description: 'Delete line' },
      { id: 'cut-line', bindings: ['Mod-x', 'Alt-x'], description: 'Cut line or selection' },
      { id: 'copy', bindings: ['Mod-c', 'Alt-c'], description: 'Copy line or selection' },
      { id: 'paste', bindings: ['Mod-v', 'Alt-v'], description: 'Paste' },
      { id: 'select-all', bindings: ['Mod-a', 'Alt-a'], description: 'Select all' },
      { id: 'insert-javadoc', bindings: ['Shift-Mod-j', 'Shift-Alt-j'], description: 'Insert JavaDoc', hint: true },
      { id: 'complete-statement', bindings: ['Shift-Mod-Enter', 'Shift-Alt-Enter'], description: 'Complete current statement' },
      { id: 'complete', bindings: ['Ctrl-Space'], description: 'Complete', hint: true },
      { id: 'toggle-comment', bindings: ['Mod-/', 'Alt-/'], description: 'Toggle line comment' },
      { id: 'undo', bindings: ['Mod-z', 'Alt-z'], description: 'Undo' },
      { id: 'redo', bindings: ['Shift-Mod-z', 'Shift-Alt-z'], description: 'Redo' },
      { id: 'move-line-up', bindings: ['Shift-Mod-ArrowUp', 'Shift-Alt-ArrowUp'], description: 'Move line up' },
      { id: 'move-line-down', bindings: ['Shift-Mod-ArrowDown', 'Shift-Alt-ArrowDown'], description: 'Move line down' },
      { id: 'reformat', bindings: ['Mod-Alt-l'], description: 'Reformat code' },
      { id: 'introduce-variable', bindings: ['Mod-Alt-v'], description: 'Introduce variable' },
    ],
  },
  {
    title: 'File',
    entries: [
      { id: 'save', bindings: ['Mod-s', 'Alt-s'], description: 'Save', hint: true },
      { id: 'close-tab', bindings: ['Mod-w', 'Alt-w'], description: 'Close tab' },
      { id: 'close-all-tabs', bindings: ['Shift-Mod-w', 'Shift-Alt-w'], description: 'Close all tabs' },
    ],
  },
  {
    title: 'Run',
    entries: [
      // Ctrl is intentional here: these IntelliJ-style run chords are the
      // same on macOS and Linux, so they have no Mod/Alt platform twin.
      { id: 'run-test', bindings: ['Ctrl-r'], description: 'Run all tests', hint: true },
      { id: 'run-test-at-cursor', bindings: ['Ctrl-Shift-r'], description: 'Run test at cursor', hint: true },
    ],
  },
  {
    title: 'Navigation',
    entries: [
      { id: 'move-to-line-end', bindings: ['Mod-ArrowRight', 'Alt-ArrowRight'], description: 'Move to line end' },
      { id: 'goto-definition', bindings: ['Mod-Click', 'Alt-Click'], description: 'Go to definition', hint: true },
      { id: 'open-settings', bindings: ['Mod-,', 'Alt-,'], description: 'Open settings' },
      // Alt+/ is the physical Linux twin of Cmd+/ (toggle comment). Keep the
      // shortcut list on a shifted chord so the two actions remain distinct.
      { id: 'show-shortcuts', bindings: ['Shift-Mod-/', 'Shift-Alt-/'], description: 'Show this shortcut list' },
    ],
  },
]

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Shift: '⇧',
  Mod: '⌘',
  Cmd: '⌘',
  Alt: '⌥',
  Ctrl: '⌃',
}

const OTHER_NAMES: Readonly<Record<string, string>> = {
  Shift: 'Shift',
  Mod: 'Ctrl',
  Cmd: 'Ctrl',
  Alt: 'Alt',
  Ctrl: 'Ctrl',
}

/** How non-macOS platforms conventionally order modifier names. */
const OTHER_ORDER: readonly string[] = ['Ctrl', 'Alt', 'Shift']

/**
 * Render one CodeMirror binding for display. macOS uses the stacked modifier
 * glyphs; every other platform uses `+`-joined names.
 */
export function formatShortcut(binding: string, macPlatform: boolean): string {
  const parts = binding.split('-')
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  const label = key.length === 1 ? key.toUpperCase() : key
  if (macPlatform) {
    // The bindings are already authored in Apple's reading order.
    return `${modifiers.map((modifier) => MAC_SYMBOLS[modifier] ?? modifier).join('')}${label}`
  }
  const names = modifiers.map((modifier) => OTHER_NAMES[modifier] ?? modifier)
  names.sort((left, right) => OTHER_ORDER.indexOf(left) - OTHER_ORDER.indexOf(right))
  return [...names, label].join('+')
}

/**
 * An entry's bindings with the one this platform advertises first: the `Cmd`
 * form on macOS, its `Alt` twin everywhere else. Shortcuts with only one
 * binding, or with no twin to choose between, are returned unchanged.
 */
export function platformBindings(
  entry: ShortcutEntry,
  macPlatform: boolean,
): readonly string[] {
  const platformIndependent = entry.bindings.filter((binding) => (
    binding.includes('Mod-Alt-')
    || (!binding.includes('Mod-') && !binding.includes('Alt-'))
  ))
  const wanted = macPlatform ? 'Mod-' : 'Alt-'
  const platformSpecific = entry.bindings.filter((binding) => (
    binding.includes(wanted) && !binding.includes('Mod-Alt-')
  ))
  const bindings = [...platformSpecific, ...platformIndependent]
  if (bindings.length === 0) {
    return entry.bindings
  }
  return bindings
}

/** The single binding this platform advertises for an entry. */
export function primaryShortcut(entry: ShortcutEntry, macPlatform: boolean): string {
  return formatShortcut(platformBindings(entry, macPlatform)[0], macPlatform)
}

const ENTRIES_BY_ID: ReadonlyMap<string, ShortcutEntry> = new Map(
  SHORTCUT_SECTIONS.flatMap((section) => section.entries).map((entry) => [entry.id, entry]),
)

/** Return the bindings registered for a shortcut, for keymaps and matchers. */
export function shortcutBindings(id: string): readonly string[] {
  const entry = ENTRIES_BY_ID.get(id)
  if (!entry) {
    throw new Error(`Unknown shortcut id: ${id}`)
  }
  return entry.bindings
}

/** Bind only the shortcut form intended for the current operating system. */
export function platformShortcutBindings(id: string, macPlatform: boolean): readonly string[] {
  const entry = ENTRIES_BY_ID.get(id)
  if (!entry) {
    throw new Error(`Unknown shortcut id: ${id}`)
  }
  return platformBindings(entry, macPlatform)
}

function matchesShortcutBinding(event: ShortcutKeyEvent, binding: string): boolean {
  const parts = binding.split('-')
  const key = parts.pop()
  const keyMatches = key && (
    event.key.toLowerCase() === key.toLowerCase()
    || (key === ',' && event.code === 'Comma')
  )
  if (!keyMatches) {
    return false
  }
  const modifiers = new Set(parts)
  return event.shiftKey === modifiers.has('Shift')
    && event.altKey === modifiers.has('Alt')
    && event.metaKey === (modifiers.has('Mod') || modifiers.has('Cmd'))
    && event.ctrlKey === modifiers.has('Ctrl')
}

/** Match the platform-specific settings shortcut for app-level key handlers. */
export function isSettingsShortcut(event: ShortcutKeyEvent, macPlatform: boolean): boolean {
  return platformShortcutBindings('open-settings', macPlatform)
    .some((binding) => matchesShortcutBinding(event, binding))
}

/** Identify one of the fixed Ctrl run chords from a keyboard event. */
export function runShortcutAction(event: ShortcutKeyEvent): RunShortcutId | null {
  const runShortcuts: readonly RunShortcutId[] = ['run-test-at-cursor', 'run-test']
  return runShortcuts.find((id) => (
    shortcutBindings(id).some((binding) => matchesShortcutBinding(event, binding))
  )) ?? null
}

/**
 * The label to print for a shortcut mentioned outside the shortcut list, so
 * buttons, tooltips, and gutter hints never drift from what is bound.
 */
export function shortcutLabel(id: string, macPlatform: boolean): string {
  const entry = ENTRIES_BY_ID.get(id)
  if (!entry) {
    throw new Error(`Unknown shortcut id: ${id}`)
  }
  return primaryShortcut(entry, macPlatform)
}

/** The compact `keys → label` pairs shown on the empty editor. */
export function shortcutHints(macPlatform: boolean): Array<[string, string]> {
  return SHORTCUT_SECTIONS.flatMap((section) => section.entries)
    .filter((entry) => entry.hint)
    .map((entry) => [primaryShortcut(entry, macPlatform), entry.description])
}

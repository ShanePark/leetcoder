import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import {
  bracketMatching,
  codeFolding,
  foldEffect,
  foldGutter,
  foldService,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language'
import {
  copyLineDown,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  toggleComment,
  undo,
} from '@codemirror/commands'
import {
  EditorState,
  Prec,
  Transaction,
} from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view'
import {
  addJavaTypeImports,
  JAVA_TYPE_IMPORTS,
  javaCompletions,
  finishJavaIterTemplate,
  javaIdentifierAt,
  javaIterTemplateExtension,
} from './completions'
import type { ClipboardBridge } from './clipboard'
import { createClipboardBridge } from './clipboard'
import { platformShortcutBindings, shortcutLabel } from './shortcuts'
import {
  importBlockRange,
  removeUnusedJavaTypeImports,
} from './java-format'
import { leetcoderHighlight, leetcoderTheme } from './editor/theme'
import {
  findJavaTestMethodAt,
  findJavaTestMethodMarkers,
} from './editor/test-markers'
import {
  buildTestRunMarkers,
  failureDecorations,
  failureMarkers,
  setEditorIssues,
  testMethodMarkers,
  type EditorIssue,
} from './editor/gutters'
import {
  copySelectedText,
  expandJavaTemplateOnTab,
  extractJavaMethod,
  formatJavaDocClipboard,
  introduceJavaVariable,
  minimalDocumentChange,
  planJavaDocInsertion,
  reformatJavaDocument,
  selectedLineBlocks,
} from './editor/editing'
import {
  completeJavaStatement,
  moveToJavaLineEnd,
} from './editor/statement-completion'
import {
  definitionHover,
  javaDefinitionAt,
  javaDefinitionHoverRange,
  setDefinitionHover,
} from './editor/definition-navigation'

export {
  expandJavaTemplateOnTab,
  extractJavaMethod,
  formatJavaDocClipboard,
  introduceJavaVariable,
  planJavaDocInsertion,
  planJavaVariableInsertion,
  reformatJavaDocument,
  selectedLineBlocks,
  copySelectedText,
} from './editor/editing'
export type { JavaDocInsertion, JavaVariableInsertion } from './editor/editing'
export {
  completeJavaStatement,
  moveToJavaLineEnd,
  planJavaStatementCompletion,
} from './editor/statement-completion'
export type { JavaStatementCompletion } from './editor/statement-completion'

export { findJavaTestMethodAt, findJavaTestMethodMarkers }
export type { JavaTestMethodMarker } from './editor/test-markers'
export type { EditorIssue } from './editor/gutters'
export { buildTestRunMarkers } from './editor/gutters'

export interface EditorCallbacks {
  onChange?: (source: string) => void
  onSave?: () => boolean | void
  onRun?: () => boolean | void
  onRunTestAtCursor?: (methodName: string | null) => boolean | void
  onShowShortcuts?: () => void
  onShowSettings?: () => void
  onRefactorError?: (message: string) => void
  /** Overridable so tests can drive clipboard shortcuts without a system clipboard. */
  clipboard?: ClipboardBridge
}

export type TestRunShortcutPlatform = 'mac' | 'other'

/** The platform-specific shortcut shown on each source-level test action. */
export function testRunShortcutLabel(platform: TestRunShortcutPlatform): string {
  return shortcutLabel('run-test-at-cursor', platform === 'mac')
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
}

const JAVA_IDENTIFIER_START = /^(?:[$_]|\p{ID_Start})$/u
const JAVA_IDENTIFIER_PART = /^(?:[$\p{ID_Continue}])$/u

function isJavaIdentifier(value: string): boolean {
  const characters = [...value]
  return characters.length > 0
    && JAVA_IDENTIFIER_START.test(characters[0])
    && characters.slice(1).every((character) => JAVA_IDENTIFIER_PART.test(character))
}

function previousNonWhitespace(source: string, position: number): string {
  let cursor = position - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  return cursor >= 0 ? source[cursor] : ''
}

function nextNonWhitespace(source: string, position: number): string {
  let cursor = position
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor < source.length ? source[cursor] : ''
}

function referencedJavaImportTypes(state: EditorState): Set<string> {
  const source = state.doc.toString()
  const definitions = new Set<string>()
  const tree = syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name === 'Definition') definitions.add(source.slice(node.from, node.to))
    },
  })

  const typeNames = new Set<string>()
  tree.iterate({
    enter(node) {
      const name = source.slice(node.from, node.to)
      if (!JAVA_TYPE_IMPORTS[name]) return

      if (node.name === 'TypeName') {
        // The final component of a fully qualified type is also a TypeName.
        // Only an unqualified first component should request an import.
        if (previousNonWhitespace(source, node.from) !== '.') typeNames.add(name)
        return
      }

      // Static factories and utilities such as List.of() and Arrays.sort()
      // are parsed as Identifier receivers rather than TypeName nodes.
      if (node.name === 'Identifier'
        && !definitions.has(name)
        && previousNonWhitespace(source, node.from) !== '.'
        && nextNonWhitespace(source, node.to) === '.') {
        typeNames.add(name)
      }
    },
  })
  return typeNames
}

export const javaAutoImports = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !transaction.isUserEvent('input')) return transaction

  const source = transaction.newDoc.toString()
  const updated = addJavaTypeImports(source, referencedJavaImportTypes(transaction.state))
  if (updated === source) return transaction

  return [
    transaction,
    { changes: minimalDocumentChange(source, updated), sequential: true },
  ]
})

/**
 * Imports this editor added stop being useful once their last reference is
 * gone. Pruning waits for a short pause instead of running on every keystroke
 * so an import does not vanish and come back while its type name is retyped,
 * and it leaves the type currently under the cursor alone for the same reason.
 */
const IMPORT_PRUNE_DELAY_MS = 700

const javaImportPruning = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged) {
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.prune()
    }, IMPORT_PRUNE_DELAY_MS)
  }

  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
  }

  private prune(): void {
    const state = this.view.state
    if (completionStatus(state) === 'active') {
      return
    }
    const source = state.doc.toString()
    const typing = javaIdentifierAt(source, state.selection.main.head)?.name ?? null
    const updated = removeUnusedJavaTypeImports(source, typing)
    if (updated === source) {
      return
    }
    this.view.dispatch({
      changes: minimalDocumentChange(source, updated),
      userEvent: 'delete.import',
    })
  }
})

/**
 * Fold the leading `import` block as one unit. Only its first line reports a
 * range, which is the shape CodeMirror's fold gutter and `foldable` expect.
 */
const javaImportFolding = foldService.of((state, lineStart) => {
  const block = importBlockRange(state.doc.toString())
  if (!block || block.count < 2 || block.from !== lineStart || block.to <= block.from) {
    return null
  }
  return { from: block.from, to: block.to }
})

const javaFolding = codeFolding({
  preparePlaceholder: (state, range) => (
    state.doc.sliceString(range.from, range.from + 6) === 'import' ? 'import \u2026' : '\u2026'
  ),
  placeholderDOM: (_view, onclick, prepared) => {
    const element = document.createElement('span')
    element.className = 'cm-foldPlaceholder'
    element.textContent = typeof prepared === 'string' ? prepared : '\u2026'
    element.title = 'Expand'
    element.setAttribute('aria-label', 'Expand folded lines')
    element.addEventListener('click', onclick)
    return element
  },
})

export interface JavaDocAltShortcutEvent {
  code: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/** Match the macOS Option form without consuming unrelated modified keystrokes. */
export function isJavaDocAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyJ'
    && event.shiftKey
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Option+D form, including macOS layouts that report a typed glyph. */
export function isLineDuplicateAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyD'
    && event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Option+Backspace form when the keymap cannot consume it. */
export function isLineDeleteAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'Backspace'
    && event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/**
 * macOS turns Option+letter into a typed glyph, so CodeMirror's key names
 * never match those bindings. These matchers work from `event.code`, which
 * stays on the physical key.
 */
function isPlainAltShortcut(event: JavaDocAltShortcutEvent, code: string): boolean {
  return event.code === code
    && event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Option+X form when the keymap cannot consume it. */
export function isLineCutAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyX')
}

/** Match the Option+V form when the keymap cannot consume it. */
export function isPasteAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyV')
}

/** Match the Option+C form when the keymap cannot consume it. */
export function isCopyAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyC')
}

/** Match the Option+A form of Select All on its physical key. */
export function isSelectAllAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyA')
}

/** Match the plain Option+/ form that toggles a line comment. */
export function isToggleCommentAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'Slash')
}

/** Match the shifted Option+/ form that opens the shortcut list. */
export function isShortcutHelpAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'Slash'
    && event.altKey
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Option+S form when the keymap cannot consume it. */
export function isSaveAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyS')
}

/** Match the Option+Z form when the keymap cannot consume it. */
export function isUndoAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'KeyZ')
}

/** Match the Shift+Option+Z form when the keymap cannot consume it. */
export function isRedoAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyZ'
    && event.altKey
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match Cmd/Ctrl+Option+L, the reformat shortcut, on either platform. */
export function isReformatShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyL'
    && event.altKey
    && !event.shiftKey
    && (event.metaKey || event.ctrlKey)
}

/** Match the Shift+Option+Enter form of Complete Current Statement. */
export function isCompleteStatementAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'Enter'
    && event.shiftKey
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Option+Right Arrow form of Move to Line End. */
export function isLineEndAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'ArrowRight'
    && event.altKey
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Linux physical-key form for moving a line one row upward. */
export function isMoveLineUpAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'ArrowUp'
    && event.altKey
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Linux physical-key form for moving a line one row downward. */
export function isMoveLineDownAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'ArrowDown'
    && event.altKey
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
}

/** Match the Linux physical-key form of the Settings shortcut. */
export function isSettingsAltShortcut(event: JavaDocAltShortcutEvent): boolean {
  return isPlainAltShortcut(event, 'Comma')
}

/**
 * CodeMirror wraps a non-empty selection when `(` is typed. Completion can
 * leave the just-typed Java identifier selected, where that behavior turns a
 * method call into `(methodName)`. Collapse only an exact identifier to its
 * end before the normal close-brackets input handler runs.
 */
export function prepareSelectedJavaIdentifierCall(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || selection.empty) {
    return false
  }
  const selected = view.state.sliceDoc(selection.from, selection.to)
  if (!isJavaIdentifier(selected)) {
    return false
  }
  const identifier = javaIdentifierAt(view.state.doc.toString(), selection.from)
  if (!identifier || identifier.from !== selection.from || identifier.to !== selection.to) {
    return false
  }
  view.dispatch({ selection: { anchor: selection.to } })
  return true
}

/**
 * Handle the input event itself when a browser doesn't expose `(` on the
 * keydown event (keyboard layouts and IMEs can do that). This runs before
 * closeBrackets, so the selected identifier is never handed to its wrapping
 * behavior as the range to replace.
 */
export function handleJavaIdentifierCallInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== '(') {
    return false
  }
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1) {
    return false
  }
  const source = view.state.doc.toString()

  // A completion can update CodeMirror's selection before WebView updates its
  // native selection. If that stale range still points at the completed
  // identifier, insert the call at the current cursor instead of letting the
  // browser's input change use the old position.
  if (selection.empty) {
    if (view.compositionStarted) {
      return false
    }
    const identifier = javaIdentifierAt(source, selection.head)
    const staleRange = identifier
      && identifier.to === selection.head
      && ((from === identifier.from && to === identifier.from)
        || (from === identifier.from && to === identifier.to))
    if (!staleRange) {
      return false
    }
    const next = view.state.sliceDoc(selection.head, selection.head + 1)
    if (next && !/[\s)\]}:;>]/.test(next)) {
      return false
    }
    view.dispatch({
      changes: { from: selection.head, insert: '()' },
      selection: { anchor: selection.head + 1 },
      scrollIntoView: true,
      userEvent: 'input.type',
    })
    return true
  }

  if (selection.from !== from || selection.to !== to) {
    return false
  }
  const selected = view.state.sliceDoc(selection.from, selection.to)
  if (!isJavaIdentifier(selected)) {
    return false
  }
  const identifier = javaIdentifierAt(source, selection.from)
  if (!identifier || identifier.from !== selection.from || identifier.to !== selection.to) {
    return false
  }

  // Match closeBrackets' default `before` rule. If another non-whitespace
  // character follows, leave the insertion to closeBrackets' normal wrapper
  // behavior rather than changing unrelated selection editing.
  const next = view.state.sliceDoc(selection.to, selection.to + 1)
  if (next && !/[\s)\]}:;>]/.test(next)) {
    return false
  }

  view.dispatch({
    changes: { from: selection.to, insert: '()' },
    selection: { anchor: selection.to + 1 },
    scrollIntoView: true,
    userEvent: 'input.type',
  })
  return true
}

/**
 * Handle a printable `(` key before the browser creates an input event.
 *
 * A keymap command can prevent the browser from replaying the same key after
 * dispatching the transaction, which keeps the original selection from being
 * handed to closeBrackets a second time. Returning false deliberately leaves
 * all other selections to the normal close-brackets behavior.
 */
export function handleJavaIdentifierCallKey(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || selection.empty) {
    return false
  }
  return handleJavaIdentifierCallInput(view, selection.from, selection.to, '(')
}

/** Key names for both an unshifted layout and browsers reporting Shift+9 as `9`. */
const javaIdentifierCallKeyBindings = [
  { key: '(', run: handleJavaIdentifierCallKey },
  { key: 'Shift-(', run: handleJavaIdentifierCallKey },
  { key: 'Shift-9', run: handleJavaIdentifierCallKey },
]

/** High-precedence keymap used by the editor and its keyboard regression tests. */
export const javaIdentifierCallKeymap = Prec.highest(keymap.of(javaIdentifierCallKeyBindings))

/** Match the IntelliJ-style Ctrl/Command+Option+V chord by physical key. */
export function isIntroduceVariableShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyV'
    && event.altKey
    && !event.shiftKey
    && (event.metaKey !== event.ctrlKey)
}

/** Match the IntelliJ-style Ctrl/Command+Option+M chord by physical key. */
export function isExtractMethodShortcut(event: JavaDocAltShortcutEvent): boolean {
  return event.code === 'KeyM'
    && event.altKey
    && !event.shiftKey
    && (event.metaKey !== event.ctrlKey)
}

/** A deliberately small CodeMirror wrapper used by the single editor pane. */
export class JavaEditor {
  readonly view: EditorView

  constructor(parent: HTMLElement, callbacks: EditorCallbacks = {}) {
    const macPlatform = isMacPlatform()
    const save = () => callbacks.onSave?.() !== false
    const run = () => callbacks.onRun?.() !== false
    const runTestAtCursor = (view: EditorView): boolean => {
      const methodName = findJavaTestMethodAt(view.state)
      // Returning true even when no callback is installed keeps the browser's
      // Ctrl+R refresh shortcut from escaping the editor.
      return callbacks.onRunTestAtCursor?.(methodName) !== false
    }
    const bindings = (id: string): readonly string[] => platformShortcutBindings(id, macPlatform)
    const runTestAtCursorShortcuts = bindings('run-test-at-cursor')
    const runAllTestsShortcuts = bindings('run-test')
    const duplicateLineShortcuts = bindings('duplicate-line')
    const deleteLineShortcuts = bindings('delete-line')
    const cutLineShortcuts = bindings('cut-line')
    const copyShortcuts = bindings('copy')
    const pasteShortcuts = bindings('paste')
    const selectAllShortcuts = bindings('select-all')
    const javaDocShortcuts = bindings('insert-javadoc')
    const completeStatementShortcuts = bindings('complete-statement')
    const toggleCommentShortcuts = bindings('toggle-comment')
    const undoShortcuts = bindings('undo')
    const redoShortcuts = bindings('redo')
    const moveLineUpShortcuts = bindings('move-line-up')
    const moveLineDownShortcuts = bindings('move-line-down')
    const reformatShortcuts = bindings('reformat')
    const completeShortcuts = bindings('complete')
    const saveShortcuts = bindings('save')
    const lineEndShortcuts = bindings('move-to-line-end')
    const showShortcutsBindings = bindings('show-shortcuts')
    const settingsShortcuts = bindings('open-settings')
    const introduceVariableShortcuts = bindings('introduce-variable')
    const extractMethodShortcuts = bindings('extract-method')
    const finishTemplateShortcuts = bindings('finish-template')
    const shortcutLabel = testRunShortcutLabel(macPlatform ? 'mac' : 'other')
    const clipboard = callbacks.clipboard ?? createClipboardBridge()
    const extractMethod = (view: EditorView): boolean => extractJavaMethod(view, callbacks.onRefactorError)
    const showShortcuts = (): boolean => {
      callbacks.onShowShortcuts?.()
      return true
    }
    const showSettings = (): boolean => {
      callbacks.onShowSettings?.()
      return true
    }
    const copySelection = (view: EditorView): boolean => {
      // Consume Alt+C even without a selection so a composed character is not
      // inserted on layouts where the browser treats Alt+C as text input.
      copySelectedText(view.state, clipboard)
      return true
    }

    /** Cut the selection, or the whole line when nothing is selected. */
    const cutSelectionOrLine = (view: EditorView): boolean => {
      const state = view.state
      const selected = state.selection.ranges.filter((range) => !range.empty)
      if (selected.length > 0) {
        const text = selected
          .map((range) => state.sliceDoc(range.from, range.to))
          .join(state.lineBreak)
        void clipboard.writeText(text)
        view.dispatch({ ...state.replaceSelection(''), userEvent: 'delete.cut' })
        return true
      }
      const text = selectedLineBlocks(state)
        .map((block) => state.sliceDoc(block.from, block.to))
        .join('')
      if (!text) {
        return false
      }
      void clipboard.writeText(text)
      return deleteLine(view)
    }

    // Cmd/Ctrl+X already reaches the browser's own cut handling, which knows
    // how to place a selection on the clipboard. Only the line form, which the
    // browser has no notion of, needs to be taken over here.
    const cutLineWithoutSelection = (view: EditorView): boolean => (
      view.state.selection.ranges.every((range) => range.empty) && cutSelectionOrLine(view)
    )

    const pasteFromClipboard = (view: EditorView): boolean => {
      void clipboard.readText().then((text) => {
        if (!text) {
          return
        }
        const state = view.state
        const insert = state.selection.ranges.length === 1
          ? formatJavaDocClipboard(text, state.doc.toString(), state.selection.main.head)
          : text
        view.dispatch({
          ...state.replaceSelection(insert),
          userEvent: 'input.paste',
          scrollIntoView: true,
        })
      })
      return true
    }

    const testMethodFromGutterEvent = (event: Event): string | null => {
      const target = event.target
      if (!(target instanceof Element)) {
        return null
      }
      return target.closest<HTMLElement>('.cm-test-run-button')?.dataset.testMethod ?? null
    }
    const insertJavaDoc = (view: EditorView): boolean => {
      const selection = view.state.selection.main
      if (!selection.empty) {
        return false
      }
      const edit = planJavaDocInsertion(view.state.doc.toString(), selection.head)
      if (!edit) {
        return false
      }
      view.dispatch({
        ...(edit.insert ? { changes: { from: edit.from, insert: edit.insert } } : {}),
        selection: { anchor: edit.cursor },
      })
      return true
    }
    let hoveredDefinition = ''

    const updateDefinitionHover = (view: EditorView, event: MouseEvent): void => {
      const modifierHeld = event.metaKey || event.altKey || event.ctrlKey
      const position = modifierHeld
        ? view.posAtCoords({ x: event.clientX, y: event.clientY })
        : null
      const highlight = modifierHeld && position !== null
        ? javaDefinitionHoverRange(view.state.doc.toString(), position)
        : null
      const range = highlight ? `${highlight.from}:${highlight.to}` : ''
      if (range === hoveredDefinition) {
        return
      }
      hoveredDefinition = range
      view.dispatch({
        effects: setDefinitionHover.of(highlight),
      })
    }

    const clearDefinitionHover = (view: EditorView): void => {
      if (!hoveredDefinition) {
        return
      }
      hoveredDefinition = ''
      view.dispatch({ effects: setDefinitionHover.of(null) })
    }

    // Linux app shortcuts use the physical Alt key. Register them from
    // `event.code` at the highest precedence so CodeMirror's built-in
    // Alt+Shift+Arrow line-copy commands cannot consume the chord first.
    const altShortcutCommands: Array<[
      (event: JavaDocAltShortcutEvent) => boolean,
      (view: EditorView) => boolean,
    ]> = [
      ...(!macPlatform ? [
        [isJavaDocAltShortcut, insertJavaDoc],
        [isLineDuplicateAltShortcut, copyLineDown],
        [isLineDeleteAltShortcut, deleteLine],
        [isLineCutAltShortcut, cutSelectionOrLine],
        [isCopyAltShortcut, copySelection],
        [isPasteAltShortcut, pasteFromClipboard],
        [isSelectAllAltShortcut, selectAll],
        [isToggleCommentAltShortcut, toggleComment],
        [isShortcutHelpAltShortcut, showShortcuts],
        [isSaveAltShortcut, save],
        [isRedoAltShortcut, redo],
        [isUndoAltShortcut, undo],
        [isCompleteStatementAltShortcut, completeJavaStatement],
        [isLineEndAltShortcut, moveToJavaLineEnd],
        [isMoveLineUpAltShortcut, moveLineUp],
        [isMoveLineDownAltShortcut, moveLineDown],
        [isSettingsAltShortcut, showSettings],
      ] as Array<[(event: JavaDocAltShortcutEvent) => boolean, (view: EditorView) => boolean]> : []),
      [isReformatShortcut, reformatJavaDocument],
      [isIntroduceVariableShortcut, introduceJavaVariable],
      [isExtractMethodShortcut, extractMethod],
    ]

    const commandBindings = (
      keys: readonly string[],
      command: (view: EditorView) => boolean,
      preventDefault = true,
    ) => keys.map((key) => ({ key, run: command, preventDefault }))

    const state = EditorState.create({
      doc: '',
      extensions: [
        leetcoderTheme,
        syntaxHighlighting(leetcoderHighlight),
        java(),
        javaIterTemplateExtension,
        javaAutoImports,
        javaImportPruning,
        javaFolding,
        javaImportFolding,
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        testMethodMarkers,
        failureMarkers,
        failureDecorations,
        definitionHover,
        gutter({
          class: 'cm-failure-gutter',
          markers: (view) => view.state.field(failureMarkers),
        }),
        gutter({
          class: 'cm-test-gutter',
          markers: (view) => buildTestRunMarkers(
            view.state.field(testMethodMarkers),
            shortcutLabel,
          ),
          domEventHandlers: {
            mousedown: (_view, _line, event) => {
              if (!testMethodFromGutterEvent(event)) {
                return false
              }
              event.stopPropagation()
              return true
            },
            click: (_view, _line, event) => {
              const methodName = testMethodFromGutterEvent(event)
              if (!methodName) {
                return false
              }
              event.stopPropagation()
              callbacks.onRunTestAtCursor?.(methodName)
              return true
            },
          },
        }),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        // Handle the actual text insertion before closeBrackets. This is the
        // reliable path for keyboard layouts whose keydown event doesn't
        // report the printable `(` key.
        Prec.high(EditorView.inputHandler.of(handleJavaIdentifierCallInput)),
        closeBrackets(),
        bracketMatching(),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        // Consume the printable opening parenthesis before the browser can
        // emit a second input event with the stale selection range.
        javaIdentifierCallKeymap,
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        Prec.high(keymap.of([
          ...commandBindings(bindings('expand-template'), expandJavaTemplateOnTab, false),
          ...commandBindings(finishTemplateShortcuts, finishJavaIterTemplate, false),
          // Run chords intentionally use Ctrl on both macOS and Linux.
          ...commandBindings(saveShortcuts, save),
          ...commandBindings(runTestAtCursorShortcuts, runTestAtCursor),
          ...commandBindings(runAllTestsShortcuts, run),
          ...commandBindings(javaDocShortcuts, insertJavaDoc, false),
          ...commandBindings(completeStatementShortcuts, completeJavaStatement),
          ...commandBindings(lineEndShortcuts, moveToJavaLineEnd),
          ...commandBindings(moveLineUpShortcuts, moveLineUp),
          ...commandBindings(moveLineDownShortcuts, moveLineDown),
          ...commandBindings(introduceVariableShortcuts, introduceJavaVariable),
          ...commandBindings(extractMethodShortcuts, extractMethod),
          // IntelliJ-style line editing shortcuts. CodeMirror's built-in
          // commands handle selected line blocks and multiple cursors while
          // preserving the document's configured line separator.
          ...commandBindings(duplicateLineShortcuts, copyLineDown),
          ...commandBindings(deleteLineShortcuts, deleteLine),
          ...commandBindings(cutLineShortcuts, macPlatform ? cutLineWithoutSelection : cutSelectionOrLine),
          ...commandBindings(copyShortcuts, copySelection),
          ...commandBindings(pasteShortcuts, pasteFromClipboard),
          ...commandBindings(selectAllShortcuts, selectAll),
          ...commandBindings(undoShortcuts, undo),
          ...commandBindings(redoShortcuts, redo),
          ...commandBindings(toggleCommentShortcuts, toggleComment),
          ...commandBindings(showShortcutsBindings, showShortcuts),
          ...commandBindings(settingsShortcuts, showSettings),
          ...commandBindings(reformatShortcuts, reformatJavaDocument),
          ...commandBindings(completeShortcuts, startCompletion, false),
        ])),
        EditorView.clipboardInputFilter.of((text, state) => state.selection.ranges.length === 1
          ? formatJavaDocClipboard(text, state.doc.toString(), state.selection.main.head)
          : text),
        autocompletion({
          override: [javaCompletions],
          activateOnTyping: true,
          maxRenderedOptions: 24,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.onChange?.(update.state.doc.toString())
          }
        }),
        // CodeMirror's built-in keymap contains an Alt+ArrowRight movement
        // command. Run our physical-key fallbacks before that keymap so the
        // Linux Cmd-equivalent cannot be consumed as a group/line movement.
        // The same ordering also makes Option-letter shortcuts reliable on
        // macOS, where the browser reports a composed glyph in event.key.
        Prec.highest(EditorView.domEventHandlers({
          keydown: (event, view) => {
            const command = altShortcutCommands.find(([matches]) => matches(event))?.[1]
            if (!command) {
              return false
            }
            const handled = command(view)
            if (handled) {
              event.preventDefault()
              event.stopPropagation()
            }
            return handled
          },
        })),
        EditorView.domEventHandlers({
          click: (event, view) => {
            if (event.button !== 0 || !(event.metaKey || event.altKey || event.ctrlKey)) {
              return false
            }
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (position === null) {
              return false
            }
            const definition = javaDefinitionAt(view.state.doc.toString(), position)
            if (!definition) {
              return false
            }
            event.preventDefault()
            view.dispatch({
              selection: { anchor: definition.from },
              effects: EditorView.scrollIntoView(definition.from, { y: 'center' }),
            })
            view.focus()
            return true
          },
          mousemove: (event, view) => {
            updateDefinitionHover(view, event)
            return false
          },
          mouseout: (event, view) => {
            if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) {
              return false
            }
            clearDefinitionHover(view)
            return false
          },
        }),
      ],
    })

    this.view = new EditorView({ state, parent })
  }

  getValue(): string {
    return this.view.state.doc.toString()
  }

  setValue(source: string): void {
    const current = this.getValue()
    if (source === current) {
      return
    }
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: source },
      selection: { anchor: 0 },
      // Loading a file is an external state replacement, not an edit the
      // user should be able to undo back to the empty bootstrap document.
      annotations: Transaction.addToHistory.of(false),
    })
    this.foldImports()
  }

  /**
   * Adopt a version of the same file that changed on disk.
   *
   * Unlike `setValue` this keeps the cursor where it was, because the user did
   * not navigate anywhere; another editor simply wrote the file they are
   * already looking at.
   */
  reloadExternalValue(source: string): void {
    const current = this.getValue()
    if (source === current) {
      return
    }
    const selection = this.view.state.selection.main
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: source },
      selection: {
        anchor: Math.min(selection.anchor, source.length),
        head: Math.min(selection.head, source.length),
      },
      annotations: Transaction.addToHistory.of(false),
    })
    this.foldImports()
  }

  /** Collapse the leading import block, the way an IDE opens a file. */
  foldImports(): void {
    const block = importBlockRange(this.getValue())
    if (!block || block.count < 2 || block.to <= block.from) {
      return
    }
    this.view.dispatch({ effects: foldEffect.of({ from: block.from, to: block.to }) })
  }

  focus(): void {
    this.view.focus()
  }

  /** Move the cursor to a 1-based source line/column and bring it into view. */
  revealLine(line: number, column?: number | null): void {
    const target = Math.max(1, Math.min(Math.trunc(line) || 1, this.view.state.doc.lines))
    const lineInfo = this.view.state.doc.line(target)
    const targetColumn = column === null || column === undefined
      ? 0
      : Math.max(0, Math.min(Math.trunc(column) - 1, lineInfo.length))
    this.view.dispatch({
      selection: { anchor: lineInfo.from + targetColumn },
      effects: EditorView.scrollIntoView(lineInfo.from + targetColumn, { y: 'center' }),
    })
    this.view.focus()
  }

  /** Replace source issues shown in the line gutter and editor background. */
  setIssues(issues: readonly EditorIssue[], options: { reveal?: boolean } = {}): void {
    this.view.dispatch({ effects: setEditorIssues.of(issues) })
    const first = issues[0]
    if (first && options.reveal !== false) {
      this.revealLine(first.line, first.column)
    }
  }

  destroy(): void {
    this.view.destroy()
  }
}

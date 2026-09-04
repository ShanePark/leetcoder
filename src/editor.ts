import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { java, javaLanguage } from '@codemirror/lang-java'
import {
  HighlightStyle,
  bracketMatching,
  codeFolding,
  foldEffect,
  foldGutter,
  foldService,
  getIndentation,
  indentString,
  indentOnInput,
  indentRange,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
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
  EditorSelection,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
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
  javaIdentifierAt,
  resolveJavaDefinition,
} from './completions'
import type { ClipboardBridge } from './clipboard'
import { createClipboardBridge } from './clipboard'
import { platformShortcutBindings, shortcutLabel } from './shortcuts'
import {
  formatJavaSource,
  importBlockRange,
  removeUnusedJavaTypeImports,
} from './java-format'

/**
 * Editor palette references the design tokens in styles.css. CSS variables are
 * used instead of resolved colors so an appearance change can update the
 * CodeMirror surface without rebuilding the editor state.
 */
const editorPalette = {
  background: 'var(--bg)',
  surface: 'var(--surface-2)',
  text: 'var(--text)',
  textDim: 'var(--text-dim)',
  textFaint: 'var(--text-faint)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  violet: 'var(--editor-violet)',
  blue: 'var(--editor-blue)',
  selection: 'var(--editor-selection)',
  activeLine: 'var(--editor-active-line)',
} as const

const leetcoderTheme = EditorView.theme({
  '&': {
    color: editorPalette.text,
    backgroundColor: editorPalette.background,
    fontSize: '14px',
    height: '100%',
  },
  '.cm-content': {
    caretColor: editorPalette.accent,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: editorPalette.accent,
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: editorPalette.selection,
  },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--editor-link-background)',
  },
  '.cm-activeLine': {
    backgroundColor: editorPalette.activeLine,
  },
  '.cm-gutters': {
    backgroundColor: editorPalette.background,
    color: editorPalette.textFaint,
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: editorPalette.activeLine,
    color: editorPalette.textDim,
  },
  '.cm-test-gutter': {
    flex: '0 0 0',
    width: '0',
    minWidth: '0',
    overflow: 'visible',
    zIndex: '1',
  },
  '.cm-test-gutter .cm-gutterElement': {
    position: 'relative',
    width: '0',
    overflow: 'visible',
  },
  '.cm-foldGutter': {
    minWidth: '14px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: editorPalette.textFaint,
    cursor: 'pointer',
    padding: '0 2px',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: editorPalette.textDim,
  },
  '.cm-foldPlaceholder': {
    margin: '0 2px',
    padding: '0 6px',
    border: '1px solid var(--editor-link-border)',
    borderRadius: '4px',
    backgroundColor: editorPalette.surface,
    color: editorPalette.textDim,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
  },
  '.cm-foldPlaceholder:hover': {
    borderColor: editorPalette.accent,
    color: editorPalette.text,
  },
  '.cm-test-run-button': {
    display: 'inline-flex',
    position: 'absolute',
    top: '50%',
    left: '2px',
    transform: 'translateY(-50%)',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: '0',
    border: '0',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: editorPalette.green,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '1',
    opacity: '0.8',
  },
  '.cm-test-run-button:hover': {
    backgroundColor: 'var(--green-soft)',
    opacity: '1',
  },
  '.cm-test-run-button:focus-visible': {
    outline: `2px solid ${editorPalette.accent}`,
    outlineOffset: '1px',
  },
  '.cm-specialChar': {
    color: editorPalette.red,
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--editor-link-background)',
    outline: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: editorPalette.surface,
    color: editorPalette.text,
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: editorPalette.text,
  },
  '.cm-panels': {
    backgroundColor: editorPalette.surface,
    color: editorPalette.text,
  },
}, { dark: true })

const leetcoderHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.self], color: editorPalette.violet },
  { tag: [tags.string, tags.character, tags.special(tags.string)], color: editorPalette.green },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: editorPalette.amber },
  { tag: [tags.comment, tags.blockComment, tags.lineComment, tags.docComment], color: editorPalette.textFaint, fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: editorPalette.blue },
  { tag: [tags.annotation, tags.meta], color: editorPalette.amber },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: editorPalette.text },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.operator], color: editorPalette.textDim },
  { tag: [tags.propertyName, tags.variableName], color: editorPalette.text },
  { tag: tags.invalid, color: editorPalette.red },
])

export interface EditorCallbacks {
  onChange?: (source: string) => void
  onSave?: () => boolean | void
  onRun?: () => boolean | void
  onRunTestAtCursor?: (methodName: string | null) => boolean | void
  onShowShortcuts?: () => void
  onShowSettings?: () => void
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

function minimalDocumentChange(before: string, after: string) {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1

  let beforeTo = before.length
  let afterTo = after.length
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo -= 1
    afterTo -= 1
  }
  return { from, to: beforeTo, insert: after.slice(from, afterTo) }
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

/**
 * Reformat the whole document: tidy imports and whitespace, then re-indent
 * through the Java language support, which already has the syntax tree.
 */
export function reformatJavaDocument(view: EditorView): boolean {
  const source = view.state.doc.toString()
  const formatted = formatJavaSource(source)
  if (formatted !== source) {
    view.dispatch({ changes: minimalDocumentChange(source, formatted), userEvent: 'format' })
  }
  const indentation = indentRange(view.state, 0, view.state.doc.length)
  if (!indentation.empty) {
    view.dispatch({ changes: indentation, userEvent: 'format' })
  }
  return true
}

/**
 * The line blocks `deleteLine` would remove for the current selection. A
 * selection that ends exactly at a line start does not include that line.
 */
export function selectedLineBlocks(state: EditorState): Array<{ from: number; to: number }> {
  const blocks: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from)
    let endLine = state.doc.lineAt(range.to)
    if (range.to > range.from && endLine.from === range.to) {
      endLine = state.doc.lineAt(range.to - 1)
    }
    const from = startLine.from
    const to = Math.min(state.doc.length, endLine.to + 1)
    const previous = blocks[blocks.length - 1]
    if (previous && previous.to >= from) {
      previous.to = to
    } else {
      blocks.push({ from, to })
    }
  }
  return blocks
}

function isTestAnnotation(annotation: string): boolean {
  const withoutArguments = annotation.slice(1, annotation.indexOf('(') >= 0
    ? annotation.indexOf('(')
    : undefined).trim()
  const simpleName = withoutArguments.slice(withoutArguments.lastIndexOf('.') + 1)
  return simpleName === 'Test'
}

/**
 * Return the Java @Test method containing a CodeMirror document position.
 *
 * MethodDeclaration nodes include their modifiers, declaration, parameters,
 * and body, so a single range check covers all of the places where a user
 * reasonably expects a test-only run shortcut to work. The Java syntax tree
 * also keeps comments and string contents out of the declaration nodes.
 */
export function findJavaTestMethodAt(
  state: EditorState,
  position = state.selection.main.head,
): string | null {
  const source = state.doc.toString()
  const boundedPosition = Math.max(0, Math.min(position, source.length))
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state)
    .resolveInner(boundedPosition, 1)
  while (node && node.name !== 'MethodDeclaration') {
    node = node.parent
  }
  if (!node || boundedPosition < node.from || boundedPosition >= node.to) {
    return null
  }
  return testMethodNameAndAnnotation(source, node)?.methodName ?? null
}

/**
 * A source-level run action for one Java @Test method. `from` is the start of
 * the @Test annotation (or, for a same-line annotation/declaration, the
 * declaration line), which is the position used by the CodeMirror gutter.
 */
export interface JavaTestMethodMarker {
  methodName: string
  /** Document position at the start of the annotation's line, as required by CodeMirror gutters. */
  from: number
  line: number
}

function testMethodNameAndAnnotation(
  source: string,
  method: ReturnType<typeof syntaxTree>['topNode'],
): { methodName: string; annotationFrom: number } | null {
  const modifiers = method.getChild('Modifiers')
  let annotationFrom: number | null = null
  let hasTest = false
  for (let child = modifiers?.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'MarkerAnnotation' && child.name !== 'Annotation') {
      continue
    }
    const annotation = source.slice(child.from, child.to).trim()
    if (!isTestAnnotation(annotation)) {
      continue
    }
    hasTest = true
    annotationFrom = child.from
    break
  }
  if (!hasTest || annotationFrom === null) {
    return null
  }
  const definition = method.getChild('Definition')
  if (!definition) {
    return null
  }
  const methodName = source.slice(definition.from, definition.to)
  return isJavaIdentifier(methodName) ? { methodName, annotationFrom } : null
}

/**
 * Extract all test methods from the current Java syntax tree. This deliberately
 * uses syntax nodes instead of text matching so comments, strings, and
 * annotation-looking text cannot create source run actions.
 */
export function findJavaTestMethodMarkers(state: EditorState): JavaTestMethodMarker[] {
  const source = state.doc.toString()
  const markers: JavaTestMethodMarker[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'MethodDeclaration') {
        return
      }
      const testMethod = testMethodNameAndAnnotation(source, node.node)
      if (!testMethod) {
        return
      }
      markers.push({
        methodName: testMethod.methodName,
        from: state.doc.lineAt(testMethod.annotationFrom).from,
        line: state.doc.lineAt(testMethod.annotationFrom).number,
      })
    },
  })
  return markers.sort((left, right) => left.from - right.from)
}

/** A source position that should be surfaced in the editor gutter. */
export interface EditorIssue {
  file: string
  line: number
  column?: number | null
  message?: string | null
}

export interface JavaDocInsertion {
  from: number
  insert: string
  cursor: number
}

interface SourceLine {
  from: number
  to: number
  text: string
}

const JAVA_CLASS_DECLARATION = /^[ \t]*(?:(?:public|protected|private|abstract|final|static|strictfp|sealed|non-sealed)[ \t]+)*class[ \t]+[A-Za-z_$][\w$]*/

function isEscaped(source: string, position: number): boolean {
  let backslashes = 0
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function isInsideCommentOrString(source: string, position: number): boolean {
  let blockComment = false
  let lineComment = false
  let textBlock = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < position; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (textBlock) {
      if (character === '"' && next === '"' && source[index + 2] === '"'
        && !isEscaped(source, index)) {
        textBlock = false
        index += 2
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (character === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (character === '"' && next === '"' && source[index + 2] === '"'
      && !isEscaped(source, index)) {
      textBlock = true
      index += 2
    } else if (character === '"' || character === "'") {
      quote = character
    }
  }
  return blockComment || lineComment || textBlock || quote !== null
}

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
  if (view.state.selection.ranges.length !== 1
    || selection.empty
    || selection.from !== from
    || selection.to !== to) {
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

/** Key names for both an unshifted layout and the usual Shift+9 `(` input. */
const javaIdentifierCallKeyBindings = [
  { key: '(', run: handleJavaIdentifierCallKey },
  { key: 'Shift-(', run: handleJavaIdentifierCallKey },
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

function lineAt(source: string, position: number): SourceLine {
  const bounded = Math.max(0, Math.min(position, source.length))
  let from = bounded
  while (from > 0 && source[from - 1] !== '\n' && source[from - 1] !== '\r') {
    from -= 1
  }
  let to = bounded
  while (to < source.length && source[to] !== '\n' && source[to] !== '\r') {
    to += 1
  }
  return { from, to, text: source.slice(from, to) }
}

function previousLine(source: string, lineFrom: number): SourceLine | null {
  if (lineFrom <= 0) {
    return null
  }
  let to = lineFrom - 1
  if (source[to] === '\n' && to > 0 && source[to - 1] === '\r') {
    to -= 1
  }
  let from = to
  while (from > 0 && source[from - 1] !== '\n' && source[from - 1] !== '\r') {
    from -= 1
  }
  return { from, to, text: source.slice(from, to) }
}

function lineBreakFor(source: string, line?: SourceLine): string {
  if (line) {
    const following = /^(?:\r\n|\r|\n)/.exec(source.slice(line.to))
    if (following) {
      return following[0]
    }
    const preceding = source.slice(Math.max(0, line.from - 2), line.from)
    if (preceding.endsWith('\r\n')) {
      return '\r\n'
    }
    if (preceding.endsWith('\r')) {
      return '\r'
    }
    if (preceding.endsWith('\n')) {
      return '\n'
    }
  }
  const match = /\r\n|\r|\n/.exec(source)
  return match?.[0] ?? '\n'
}

export interface JavaStatementCompletion {
  /** Position at which completion text is inserted, before trailing spaces/comments. */
  semicolonFrom: number
  /** Empty when the current statement already has its semicolon. */
  semicolon: string
  /** Closing parentheses/brackets needed to make the statement syntactically complete. */
  closing: string
  /** Cursor position immediately after the completed statement. */
  cursor: number
}

function lineCodeEnd(text: string): number {
  let blockComment = false
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '/') {
      return index
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (character === '"' || character === "'") {
      quote = character
    }
  }
  return text.length
}

function balancedJavaDelimiters(text: string): boolean {
  const stack: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character)
      continue
    }
    if (character !== ')' && character !== ']' && character !== '}') {
      continue
    }
    const opening = character === ')' ? '(' : character === ']' ? '[' : '{'
    if (stack.pop() !== opening) {
      return false
    }
  }
  return quote === null && stack.length === 0
}

/**
 * Return the closing delimiters needed by a source fragment, or null when its
 * delimiters are mismatched. Parentheses and square brackets can be repaired
 * for an incomplete expression; an unmatched brace is deliberately rejected
 * because it may be the beginning of a block rather than an expression.
 */
function missingJavaClosingDelimiters(text: string): string | null {
  const stack: string[] = []
  let blockComment = false
  let quote: '"' | "'" | null = null
  let escaped = false
  let textBlock = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (textBlock) {
      if (character === '"' && next === '"' && text[index + 2] === '"'
        && !isEscaped(text, index)) {
        textBlock = false
        index += 2
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (character === '"' && next === '"' && text[index + 2] === '"'
      && !isEscaped(text, index)) {
      textBlock = true
      index += 2
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      stack.push(')')
      continue
    }
    if (character === '[') {
      stack.push(']')
      continue
    }
    if (character === '{') {
      stack.push('}')
      continue
    }
    if (character !== ')' && character !== ']' && character !== '}') {
      continue
    }
    if (stack.pop() !== character) {
      return null
    }
  }

  if (blockComment || textBlock || quote !== null || stack.includes('}')) {
    return null
  }
  return stack.reverse().join('')
}

function hasJavaSyntaxError(node: JavaSyntaxNode): boolean {
  if (node.type.isError) {
    return true
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (hasJavaSyntaxError(child)) {
      return true
    }
  }
  return false
}

function isStatementCandidate(text: string, closing = ''): boolean {
  const statement = text.trim().replace(/;\s*$/, '').trimEnd()
  if (!statement || missingJavaClosingDelimiters(statement) === null) {
    return false
  }
  if (/^(?:package|import|@)\b/.test(statement)) {
    return false
  }
  // Parse the exact text that the command would produce. The Java grammar
  // keeps recoverable parse errors as zero-width `⚠` nodes, so checking only
  // the top-level statement name would incorrectly accept `foo =;` and
  // `return value +;` as completable statements.
  const tree = javaLanguage.parser.parse(`${statement}${closing};`)
  const node = tree.topNode.firstChild
  if (!node || node.nextSibling || hasJavaSyntaxError(tree.topNode)) {
    return false
  }
  return new Set([
    'AssertStatement',
    'BreakStatement',
    'ContinueStatement',
    'ExpressionStatement',
    'LocalVariableDeclaration',
    'ReturnStatement',
    'ThrowStatement',
    'YieldStatement',
  ]).has(node.name)
}

/** Plan the minimal syntax completion for the current Java statement. */
export function planJavaStatementCompletion(
  source: string,
  position: number,
): JavaStatementCompletion | null {
  const line = lineAt(source, position)
  if (isInsideCommentOrString(source, line.from) || isInsideCommentOrString(source, position)) {
    return null
  }
  const codeEnd = line.from + lineCodeEnd(line.text)
  const code = source.slice(line.from, codeEnd)
  const trimmed = code.trim()
  if (!trimmed || code.includes('/*')) {
    return null
  }
  const hasSemicolon = /;\s*$/.test(trimmed)
  const statement = hasSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed
  const closing = missingJavaClosingDelimiters(statement)
  if (closing === null || !isStatementCandidate(statement, closing)) {
    return null
  }
  const codeEndWithoutSpaces = line.from + code.trimEnd().length
  const semicolonPosition = hasSemicolon ? codeEndWithoutSpaces - 1 : codeEndWithoutSpaces
  const semicolonFrom = closing && hasSemicolon ? semicolonPosition : codeEndWithoutSpaces
  const semicolon = hasSemicolon ? '' : ';'
  return {
    semicolonFrom,
    semicolon,
    closing,
    cursor: hasSemicolon
      ? codeEndWithoutSpaces + closing.length
      : semicolonFrom + closing.length + semicolon.length,
  }
}

/** Complete the current Java statement without inserting a line break. */
export function completeJavaStatement(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1 || !selection.empty) {
    return false
  }
  const plan = planJavaStatementCompletion(state.doc.toString(), selection.head)
  if (!plan) {
    return false
  }
  const insert = `${plan.closing}${plan.semicolon}`
  view.dispatch({
    ...(insert ? { changes: { from: plan.semicolonFrom, insert } } : {}),
    selection: { anchor: plan.cursor },
    userEvent: 'input.completeStatement',
  })
  return true
}

/** Move every cursor to its physical line end, correcting blank-line indent when known. */
export function moveToJavaLineEnd(view: EditorView): boolean {
  const { state } = view
  const changes: Array<{ from: number; to: number; insert: string }> = []
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head)
    if (line.text.trim() !== '' || lines.has(line.number)) {
      continue
    }
    lines.add(line.number)
    const columns = getIndentation(state, line.from)
    if (columns === null) {
      continue
    }
    const indent = indentString(state, columns)
    if (indent !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: indent })
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: 'input.indent' })
  }
  const selection = EditorSelection.create(
    view.state.selection.ranges.map((range) => (
      EditorSelection.cursor(view.state.doc.lineAt(range.head).to)
    )),
  )
  view.dispatch({ selection })
  return true
}

export interface JavaVariableInsertion {
  from: number
  insert: string
  replaceFrom: number
  replaceTo: number
  selected: string
  name: string
  nameFrom: number
  nameTo: number
}

type JavaSyntaxNode = ReturnType<typeof syntaxTree>['topNode']

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'true',
  'false', 'null', 'record', 'sealed', 'permits', 'non-sealed', 'yield',
])

function javaVariableBase(expression: string): string {
  const value = expression.trim()
  const method = /(?:^|\.)([A-Za-z_$][\w$]*)\s*\(/.exec(value)
  if (method) {
    const methodName = method[1]
    const property = /^(?:get|is|has)([A-Z][A-Za-z0-9_$]*)$/.exec(methodName)
    return property ? property[1][0].toLowerCase() + property[1].slice(1) : methodName
  }
  const created = /\bnew\s+(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)/.exec(value)
  if (created) {
    return created[1][0].toLowerCase() + created[1].slice(1)
  }
  const identifier = /^[A-Za-z_$][\w$]*$/.exec(value)
  if (identifier) {
    return identifier[0]
  }
  const property = /\.([A-Za-z_$][\w$]*)$/.exec(value)
  return property?.[1] ?? 'value'
}

function uniqueJavaVariableName(source: string, from: number, to: number, base: string): string {
  const fallback = /^[A-Za-z_$][\w$]*$/.test(base) && !JAVA_KEYWORDS.has(base) ? base : 'value'
  const surrounding = `${source.slice(0, from)} ${source.slice(to)}`
  const used = new Set(surrounding.match(/[A-Za-z_$][\w$]*/g) ?? [])
  if (!used.has(fallback) && !JAVA_KEYWORDS.has(fallback)) {
    return fallback
  }
  let suffix = 2
  while (used.has(`${fallback}${suffix}`) || JAVA_KEYWORDS.has(`${fallback}${suffix}`)) {
    suffix += 1
  }
  return `${fallback}${suffix}`
}

function exactJavaSyntaxNode(
  state: EditorState,
  from: number,
  to: number,
): JavaSyntaxNode | null {
  let node: JavaSyntaxNode | null = syntaxTree(state).resolveInner(from, 1)
  while (node) {
    if (node.from === from && node.to === to) {
      return node
    }
    node = node.parent
  }
  return null
}

function allowsJavaExpressionSelection(state: EditorState, from: number, to: number): boolean {
  const exact = exactJavaSyntaxNode(state, from, to)
  if (!exact) {
    return true
  }
  if (exact.name === 'Definition' || exact.name === 'TypeName' || exact.name === 'PrimitiveType'
    || exact.name === 'MethodName' || exact.name.endsWith('Statement')) {
    return false
  }
  for (let node = exact.parent; node; node = node.parent) {
    if (node.name === 'FieldDeclaration') {
      return false
    }
  }
  return true
}

/** Plan introducing a `var` for one single-line expression selection. */
export function planJavaVariableInsertion(
  source: string,
  selectionFrom: number,
  selectionTo: number,
): JavaVariableInsertion | null {
  if (selectionFrom < 0 || selectionTo <= selectionFrom || selectionTo > source.length) {
    return null
  }
  const line = lineAt(source, selectionFrom)
  if (lineAt(source, selectionTo).from !== line.from
    || isInsideCommentOrString(source, line.from)
    || isInsideCommentOrString(source, selectionFrom)
    || isInsideCommentOrString(source, selectionTo)) {
    return null
  }
  const codeEnd = line.from + lineCodeEnd(line.text)
  const code = source.slice(line.from, codeEnd)
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? ''
  const codeStart = line.from + indent.length
  const selected = source.slice(selectionFrom, selectionTo)
  if (code.includes('/*')
    || selectionFrom < codeStart
    || selectionTo > codeEnd
    || selected.trim() !== selected
    || !balancedJavaDelimiters(selected)
    || !isStatementCandidate(code.slice(indent.length))) {
    return null
  }
  if (/;/.test(selected) || /(?:^|[^=!<>])=(?!=|>)/.test(selected)) {
    return null
  }
  const name = uniqueJavaVariableName(source, selectionFrom, selectionTo, javaVariableBase(selected))
  if (/^[A-Za-z_$][\w$]*$/.test(selected)) {
    return null
  }
  const lineBreak = lineBreakFor(source, line)
  const insert = `${indent}var ${name} = ${selected};${lineBreak}`
  const nameFrom = line.from + indent.length + 4
  return {
    from: line.from,
    insert,
    replaceFrom: selectionFrom,
    replaceTo: selectionTo,
    selected,
    name,
    nameFrom,
    nameTo: nameFrom + name.length,
  }
}

/** Introduce a local `var` for the current single expression selection. */
export function introduceJavaVariable(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1 || selection.empty) {
    return false
  }
  const from = Math.min(selection.from, selection.to)
  const to = Math.max(selection.from, selection.to)
  const plan = planJavaVariableInsertion(state.doc.toString(), from, to)
  if (!plan || !allowsJavaExpressionSelection(state, from, to)) {
    return false
  }
  let changes
  if (plan.replaceFrom === plan.from + plan.insert.indexOf('var ')) {
    changes = [{
      from: plan.from,
      to: plan.replaceTo,
      insert: `${plan.insert}${state.sliceDoc(plan.from, plan.replaceFrom)}${plan.name}`,
    }]
  } else {
    changes = [
      { from: plan.from, insert: plan.insert },
      { from: plan.replaceFrom, to: plan.replaceTo, insert: plan.name },
    ]
  }
  view.dispatch({
    changes,
    selection: { anchor: plan.nameFrom, head: plan.nameTo },
    userEvent: 'input.introduceVariable',
  })
  return true
}

function javaDocBodyCursor(line: SourceLine): number | null {
  const match = /^([ \t]*)\* (.*)$/.exec(line.text)
  if (!match) {
    return null
  }
  return line.from + match[1].length + 2
}

function existingJavaDocCursor(source: string, classLine: SourceLine): number | null {
  let line = previousLine(source, classLine.from)
  if (!line || (!/^[ \t]*\*\/[ \t]*$/.test(line.text)
    && !/^[ \t]*\/\*\*.*\*\/[ \t]*$/.test(line.text))) {
    return null
  }

  const closingLine = line
  let lastBodyCursor: number | null = null
  while (line) {
    const opening = /^[ \t]*\/\*\*/.exec(line.text)
    if (opening) {
      const openingEnd = line.text.indexOf('/**') + 3
      const closing = line.text.indexOf('*/', openingEnd)
      if (closing >= 0) {
        if (lastBodyCursor !== null) {
          return lastBodyCursor
        }
        let cursor = openingEnd
        while (cursor < closing && /[ \t]/.test(line.text[cursor] ?? '')) {
          cursor += 1
        }
        return line.from + cursor
      }
      return lastBodyCursor ?? (closingLine.from + closingLine.text.search(/\*\//))
    }

    if (line === closingLine && /^[ \t]*\*\/[ \t]*$/.test(line.text)) {
      line = previousLine(source, line.from)
      continue
    }

    const bodyCursor = javaDocBodyCursor(line)
    if (bodyCursor !== null && lastBodyCursor === null) {
      lastBodyCursor = bodyCursor
    } else if (!/^[ \t]*$/.test(line.text) && !/^[ \t]*\*\*?[ \t]*$/.test(line.text)) {
      return null
    }
    line = previousLine(source, line.from)
  }
  return null
}

/** Plan the JavaDoc edit for a cursor on a Java class declaration line. */
export function planJavaDocInsertion(source: string, position: number): JavaDocInsertion | null {
  const classLine = lineAt(source, position)
  if (isInsideCommentOrString(source, classLine.from) || !JAVA_CLASS_DECLARATION.test(classLine.text)) {
    return null
  }

  const existingCursor = existingJavaDocCursor(source, classLine)
  if (existingCursor !== null) {
    return { from: existingCursor, insert: '', cursor: existingCursor }
  }

  const indent = /^[ \t]*/.exec(classLine.text)?.[0] ?? ''
  const lineBreak = lineBreakFor(source, classLine)
  const lines = [
    `${indent}/**`,
    `${indent} * `,
    `${indent} */`,
  ]
  const insert = `${lines.join(lineBreak)}${lineBreak}`
  const cursor = classLine.from + lines[0].length + lineBreak.length + lines[1].length
  return { from: classLine.from, insert, cursor }
}

function isJavaDocBodyAt(source: string, position: number): { prefix: string } | null {
  const line = lineAt(source, position)
  const body = /^([ \t]*)\* /.exec(line.text)
  if (!body || position < line.from + body[0].length) {
    return null
  }
  const beforeLine = source.slice(0, line.from)
  if (beforeLine.lastIndexOf('/**') <= beforeLine.lastIndexOf('*/')) {
    return null
  }
  return { prefix: `${body[1]}* ` }
}

/** Format a multiline clipboard payload when it is pasted into JavaDoc text. */
export function formatJavaDocClipboard(text: string, source: string, position: number): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.includes('\n')) {
    return text
  }
  const body = isJavaDocBodyAt(source, position)
  if (!body) {
    return text
  }
  const withoutTrailingNewlines = normalized.replace(/\n+$/, '')
  const lines = withoutTrailingNewlines.split('\n')
  return [lines[0], ...lines.slice(1).map((line) => `${body.prefix}${line}`)].join('\n')
}

/** Copy the selected text, or the current line when there is no selection. */
export function copySelectedText(
  state: EditorState,
  clipboard: Pick<ClipboardBridge, 'writeText'>,
): boolean {
  const selected = state.selection.ranges.filter((range) => !range.empty)
  const text = selected.length > 0
    ? selected
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak)
    : selectedLineBlocks(state)
      .map((block) => state.sliceDoc(block.from, block.to))
      .join('')
  if (!text) {
    return false
  }
  void clipboard.writeText(text)
  return true
}

const setEditorIssues = StateEffect.define<readonly EditorIssue[]>()

class FailureMarker extends GutterMarker {
  constructor(private readonly message: string) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof FailureMarker && other.message === this.message
  }

  toDOM(): Node {
    const marker = document.createElement('span')
    marker.className = 'cm-failure-marker'
    marker.textContent = '●'
    marker.setAttribute('aria-label', this.message || 'Test failure')
    if (this.message) {
      marker.title = this.message
    }
    return marker
  }
}

class TestRunMarker extends GutterMarker {
  constructor(
    private readonly methodName: string,
    private readonly shortcutLabel: string,
  ) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof TestRunMarker
      && other.methodName === this.methodName
      && other.shortcutLabel === this.shortcutLabel
  }

  toDOM(): Node {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-test-run-button'
    button.textContent = '▶'
    button.dataset.testMethod = this.methodName
    const label = `Run ${this.methodName} (${this.shortcutLabel})`
    button.setAttribute('aria-label', label)
    button.title = label
    return button
  }
}

/** Build gutter markers from the syntax-tree extraction result. */
export function buildTestRunMarkers(
  markers: readonly JavaTestMethodMarker[],
  shortcutLabel: string,
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>()
  const orderedMarkers = [...markers].sort((left, right) => left.from - right.from)
  for (const marker of orderedMarkers) {
    builder.add(marker.from, marker.from, new TestRunMarker(marker.methodName, shortcutLabel))
  }
  return builder.finish()
}

const testMethodMarkers = StateField.define<readonly JavaTestMethodMarker[]>({
  create: (state) => findJavaTestMethodMarkers(state),
  update(value, transaction) {
    return transaction.docChanged ? findJavaTestMethodMarkers(transaction.state) : value
  },
})

function buildFailureMarkers(state: EditorState, issues: readonly EditorIssue[]): RangeSet<GutterMarker> {
  const byLine = new Map<number, { issue: EditorIssue; line: NonNullable<ReturnType<typeof safeLine>> }>()
  for (const issue of issues) {
    const line = safeLine(state, issue.line)
    if (line && !byLine.has(line.number)) {
      byLine.set(line.number, { issue, line })
    }
  }
  const entries = [...byLine.values()]
    .sort((left, right) => left.line.from - right.line.from)
  const builder = new RangeSetBuilder<GutterMarker>()
  for (const { issue, line } of entries) {
    const message = issue.message?.trim() || 'Test failure'
    builder.add(line.from, line.from, new FailureMarker(message))
  }
  return builder.finish()
}

function buildFailureDecorations(state: EditorState, issues: readonly EditorIssue[]) {
  const byLine = new Map<number, EditorIssue>()
  for (const issue of issues) {
    const line = safeLine(state, issue.line)
    if (line && !byLine.has(line.number)) {
      byLine.set(line.number, issue)
    }
  }
  const entries = [...byLine.entries()]
    .map(([lineNumber, issue]) => ({ issue, line: state.doc.line(lineNumber) }))
    .sort((left, right) => left.line.from - right.line.from)
  const builder = new RangeSetBuilder<Decoration>()
  for (const { issue, line } of entries) {
    const message = issue.message?.trim() || 'Test failure'
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: {
          class: 'cm-failure-line',
          title: message,
        },
      }),
    )
  }
  return builder.finish()
}

function safeLine(state: EditorState, line: number) {
  const target = Math.trunc(line)
  if (!Number.isFinite(target) || target < 1 || target > state.doc.lines) {
    return null
  }
  return state.doc.line(target)
}

const failureMarkers = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setEditorIssues)) {
        return buildFailureMarkers(transaction.state, effect.value)
      }
    }
    return value
  },
})

const failureDecorations = StateField.define<ReturnType<typeof RangeSet.of<Decoration>>>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setEditorIssues)) {
        return buildFailureDecorations(transaction.state, effect.value)
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const setDefinitionHover = StateEffect.define<{ from: number; to: number } | null>()

const definitionHover = StateField.define<ReturnType<typeof RangeSet.of<Decoration>>>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDefinitionHover)) {
        continue
      }
      if (!effect.value || effect.value.from >= effect.value.to) {
        return Decoration.none
      }
      const builder = new RangeSetBuilder<Decoration>()
      builder.add(
        effect.value.from,
        effect.value.to,
        Decoration.mark({ class: 'cm-definition-link' }),
      )
      return builder.finish()
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

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
    const shortcutLabel = testRunShortcutLabel(macPlatform ? 'mac' : 'other')
    const clipboard = callbacks.clipboard ?? createClipboardBridge()
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
      const identifier = position === null ? null : javaIdentifierAt(view.state.doc.toString(), position)
      const definition = modifierHeld && position !== null && identifier
        ? resolveJavaDefinition(view.state.doc.toString(), position)
        : null
      const range = definition && identifier
        ? `${identifier.from}:${identifier.to}`
        : ''
      if (range === hoveredDefinition) {
        return
      }
      hoveredDefinition = range
      view.dispatch({
        effects: setDefinitionHover.of(identifier && definition
          ? { from: identifier.from, to: identifier.to }
          : null),
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
            const definition = resolveJavaDefinition(view.state.doc.toString(), position)
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
  setIssues(issues: readonly EditorIssue[]): void {
    this.view.dispatch({ effects: setEditorIssues.of(issues) })
    const first = issues[0]
    if (first) {
      this.revealLine(first.line, first.column)
    }
  }

  destroy(): void {
    this.view.destroy()
  }
}

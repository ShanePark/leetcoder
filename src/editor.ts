import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import {
  HighlightStyle,
  indentOnInput,
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
} from '@codemirror/commands'
import {
  EditorState,
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
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import {
  addJavaTypeImports,
  JAVA_TYPE_IMPORTS,
  javaCompletions,
  javaIdentifierAt,
  resolveJavaDefinition,
} from './completions'

/**
 * Editor palette derived from the design tokens in styles.css. Keep the two
 * files in sync:
 *   background      = --bg        (#0d1017)
 *   surface         = --surface-2 (#171c27, panels/tooltips)
 *   text            = --text      (#e8ecf4)
 *   textDim         = --text-dim  (#98a2b6)
 *   textFaint       = --text-faint(#5d6778)
 *   accent          = --accent    (#5b9dff)
 *   green           = --green     (#3ecf8e)
 *   amber           = --amber     (#ffbf3f)
 *   red             = --red       (#ff5c7a)
 * Syntax-only colors (no styles.css counterpart): violet #c792ea for
 * keywords, blue #82aaff for types/classes.
 */
const editorPalette = {
  background: '#0d1017',
  surface: '#171c27',
  text: '#e8ecf4',
  textDim: '#98a2b6',
  textFaint: '#5d6778',
  accent: '#5b9dff',
  green: '#3ecf8e',
  amber: '#ffbf3f',
  red: '#ff5c7a',
  violet: '#c792ea',
  blue: '#82aaff',
  selection: 'rgba(91, 157, 255, 0.22)',
  activeLine: 'rgba(255, 255, 255, 0.04)',
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
    backgroundColor: 'rgba(91, 157, 255, 0.14)',
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
    minWidth: '22px',
  },
  '.cm-test-run-button': {
    display: 'inline-flex',
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
    backgroundColor: 'rgba(62, 207, 142, 0.14)',
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
    backgroundColor: 'rgba(91, 157, 255, 0.18)',
    outline: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: editorPalette.surface,
    color: editorPalette.text,
    border: '1px solid rgba(148, 163, 190, 0.18)',
    borderRadius: '8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'rgba(91, 157, 255, 0.13)',
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
}

export type TestRunShortcutPlatform = 'mac' | 'other'

/** The platform-specific shortcut shown on each source-level test action. */
export function testRunShortcutLabel(platform: TestRunShortcutPlatform): string {
  return platform === 'mac' ? '⇧⌘R' : 'Shift+Ctrl+R'
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
    const save = () => callbacks.onSave?.() !== false
    const run = () => callbacks.onRun?.() !== false
    const runTestAtCursor = (view: EditorView): boolean => {
      const methodName = findJavaTestMethodAt(view.state)
      // Returning true even when no callback is installed keeps the browser's
      // Ctrl/Cmd+Shift+R refresh shortcut from escaping the editor.
      return callbacks.onRunTestAtCursor?.(methodName) !== false
    }
    const shortcutLabel = testRunShortcutLabel(isMacPlatform() ? 'mac' : 'other')
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

    const state = EditorState.create({
      doc: '',
      extensions: [
        leetcoderTheme,
        syntaxHighlighting(leetcoderHighlight),
        java(),
        javaAutoImports,
        lineNumbers(),
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
        closeBrackets(),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        indentOnInput(),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        Prec.high(keymap.of([
          { key: 'Mod-s', run: save },
          { key: 'Mod-r', run },
          { key: 'Shift-Mod-r', run: runTestAtCursor, preventDefault: true },
          { key: 'Shift-Mod-j', run: insertJavaDoc },
          // IntelliJ-style line editing shortcuts. CodeMirror's built-in
          // commands handle selected line blocks and multiple cursors while
          // preserving the document's configured line separator.
          { key: 'Mod-d', run: copyLineDown, preventDefault: true },
          { key: 'Alt-d', run: copyLineDown, preventDefault: true },
          { key: 'Mod-Backspace', run: deleteLine, preventDefault: true },
          { key: 'Alt-Backspace', run: deleteLine, preventDefault: true },
          { key: 'Ctrl-Space', run: startCompletion },
          { key: 'Cmd-Space', run: startCompletion },
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
          keydown: (event, view) => {
            if (!isJavaDocAltShortcut(event)) {
              if (!isLineDuplicateAltShortcut(event) && !isLineDeleteAltShortcut(event)) {
                return false
              }
              const handled = isLineDuplicateAltShortcut(event)
                ? copyLineDown(view)
                : deleteLine(view)
              if (handled) {
                event.preventDefault()
              }
              return handled
            }
            const handled = insertJavaDoc(view)
            if (handled) {
              event.preventDefault()
            }
            return handled
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

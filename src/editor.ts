import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import { HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
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
import { javaCompletions, javaIdentifierAt, resolveJavaDefinition } from './completions'

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
        lineNumbers(),
        highlightActiveLineGutter(),
        failureMarkers,
        failureDecorations,
        definitionHover,
        gutter({
          class: 'cm-failure-gutter',
          markers: (view) => view.state.field(failureMarkers),
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

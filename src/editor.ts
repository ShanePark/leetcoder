import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  EditorState,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
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
import { oneDark } from '@codemirror/theme-one-dark'
import { javaCompletions } from './completions'

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

/** A deliberately small CodeMirror wrapper used by the single editor pane. */
export class JavaEditor {
  readonly view: EditorView

  constructor(parent: HTMLElement, callbacks: EditorCallbacks = {}) {
    const save = () => callbacks.onSave?.() !== false
    const run = () => callbacks.onRun?.() !== false

    const state = EditorState.create({
      doc: '',
      extensions: [
        oneDark,
        java(),
        lineNumbers(),
        highlightActiveLineGutter(),
        failureMarkers,
        failureDecorations,
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
          { key: 'Ctrl-Space', run: startCompletion },
          { key: 'Cmd-Space', run: startCompletion },
        ])),
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

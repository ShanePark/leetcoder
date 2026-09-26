import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Transaction,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  showTooltip,
  type Tooltip,
} from '@codemirror/view'
import { setEditorIssues, type EditorIssue } from './gutters'

interface PositionedIssue {
  id: number
  issue: EditorIssue
  from: number
  to: number
}

interface DiagnosticViewState {
  issues: readonly PositionedIssue[]
  activeIds: readonly number[] | null
}

const setActiveDiagnostic = StateEffect.define<readonly number[]>()
const dismissActiveDiagnostic = StateEffect.define<null>()

function validColumn(value: number | null | undefined, lineLength: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.trunc(value) < 1) {
    return null
  }
  return Math.max(1, Math.min(Math.trunc(value), lineLength + 1))
}

function caretRangeLength(caret: string | null | undefined): number {
  if (!caret) {
    return 1
  }
  const start = caret.indexOf('^')
  if (start < 0) {
    return 1
  }
  let end = start + 1
  while (caret[end] === '^' || caret[end] === '~') {
    end += 1
  }
  return end - start
}

function columnFromCaret(caret: string | null | undefined): number | null {
  if (!caret) {
    return null
  }
  const index = caret.indexOf('^')
  return index < 0 ? null : index + 1
}

function resolveIssue(state: EditorState, issue: EditorIssue, id: number): PositionedIssue | null {
  const lineNumber = Math.trunc(issue.line)
  if (!Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) {
    return null
  }
  const line = state.doc.line(lineNumber)
  const rawColumn = issue.column ?? columnFromCaret(issue.caret)
  const column = validColumn(rawColumn, line.length)
  const from = column === null ? line.from : line.from + column - 1
  const to = column === null ? from : Math.min(line.to, from + caretRangeLength(issue.caret))
  return { id, issue, from, to }
}

function currentLocation(state: EditorState, entry: PositionedIssue): { line: number; column: number } {
  const line = state.doc.lineAt(Math.max(0, Math.min(entry.from, state.doc.length)))
  return { line: line.number, column: entry.from - line.from + 1 }
}

function diagnosticMessage(issue: EditorIssue): string {
  return issue.message?.trim() || 'Test failure'
}

function tooltipFor(entries: readonly PositionedIssue[]): Tooltip | null {
  if (entries.length === 0) {
    return null
  }
  const from = Math.min(...entries.map((entry) => entry.from))
  const to = Math.max(...entries.map((entry) => entry.to))
  return {
    pos: from,
    end: to,
    above: true,
    arrow: true,
    create(view) {
      const state = view.state
      const dom = document.createElement('div')
      dom.className = 'cm-diagnostic-tooltip'
      dom.setAttribute('role', 'group')
      dom.setAttribute('aria-label', 'Compiler diagnostics')

      for (const entry of entries) {
        const location = currentLocation(state, entry)
        const message = document.createElement('div')
        message.className = 'cm-diagnostic-tooltip-message'
        message.textContent = diagnosticMessage(entry.issue)
        dom.append(message)

        const locationLabel = document.createElement('div')
        locationLabel.className = 'cm-diagnostic-tooltip-location'
        locationLabel.textContent = `${entry.issue.file}:${location.line}:${location.column}`
        dom.append(locationLabel)

        const currentLine = state.doc.line(location.line).text
        if (entry.issue.sourceLine === currentLine && entry.issue.caret) {
          const source = document.createElement('pre')
          source.className = 'cm-diagnostic-tooltip-source'
          source.textContent = `${currentLine}\n${entry.issue.caret}`
          dom.append(source)
        }
      }
      return { dom }
    },
  }
}

function resolveIssues(state: EditorState, issues: readonly EditorIssue[]): readonly PositionedIssue[] {
  const resolved: PositionedIssue[] = []
  for (let index = 0; index < issues.length; index += 1) {
    const entry = resolveIssue(state, issues[index], index)
    if (entry) {
      resolved.push(entry)
    }
  }
  return resolved.sort((left, right) => left.from - right.from || left.to - right.to || left.id - right.id)
}

function mapIssue(transaction: Transaction, entry: PositionedIssue): PositionedIssue {
  const from = transaction.changes.mapPos(entry.from, 1)
  const to = transaction.changes.mapPos(entry.to, -1)
  return { ...entry, from, to: Math.max(from, to) }
}

export const diagnosticViewState = StateField.define<DiagnosticViewState>({
  create: () => ({ issues: [], activeIds: null }),
  update(value, transaction) {
    const replacement = transaction.effects.find((effect) => effect.is(setEditorIssues))
    if (replacement?.is(setEditorIssues)) {
      return { issues: resolveIssues(transaction.state, replacement.value), activeIds: null }
    }

    if (transaction.docChanged) {
      return {
        issues: value.issues.map((entry) => mapIssue(transaction, entry)),
        activeIds: null,
      }
    }

    for (const effect of transaction.effects) {
      if (effect.is(setActiveDiagnostic)) {
        const activeIds = effect.value.filter((id) => value.issues.some((entry) => entry.id === id))
        return { ...value, activeIds: activeIds.length > 0 ? activeIds : null }
      }
      if (effect.is(dismissActiveDiagnostic)) {
        return { ...value, activeIds: null }
      }
    }
    return value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => buildDiagnosticRangeDecorations(value.issues)),
    showTooltip.from(field, (value) => value.activeIds
      ? tooltipFor(value.issues.filter((entry) => value.activeIds?.includes(entry.id)))
      : null),
  ],
})

/** Build inline ranges from compiler columns and javac's caret span. */
export function buildDiagnosticRangeDecorations(issues: readonly PositionedIssue[]) {
  const groups = new Map<string, PositionedIssue[]>()
  for (const entry of issues) {
    if (entry.to <= entry.from) {
      continue
    }
    const key = `${entry.from}:${entry.to}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  const ranges = [...groups.values()].sort((left, right) => left[0].from - right[0].from || left[0].to - right[0].to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const group of ranges) {
    const { from, to } = group[0]
    const message = group.map(({ issue }) => diagnosticMessage(issue)).join('\n')
    builder.add(from, to, Decoration.mark({
      class: 'cm-diagnostic-range',
      attributes: { title: message },
    }))
  }
  return builder.finish()
}

/** Open every diagnostic on a source line in a persistent editor tooltip. */
export function showDiagnosticAtLine(view: EditorView, lineNumber: number): boolean {
  const current = view.state.field(diagnosticViewState)
  const matching = current.issues.filter((entry) => currentLocation(view.state, entry).line === lineNumber)
  if (matching.length === 0) {
    return false
  }
  const first = matching[0]
  view.dispatch({
    selection: { anchor: first.from },
    effects: [
      setActiveDiagnostic.of(matching.map((entry) => entry.id)),
      EditorView.scrollIntoView(first.from, { y: 'center' }),
    ],
  })
  view.focus()
  return true
}

/** Dismiss the persistent gutter tooltip without changing diagnostic ranges. */
export function dismissDiagnosticTooltip(view: EditorView): void {
  view.dispatch({ effects: dismissActiveDiagnostic.of(null) })
}

const hoverDiagnostics = hoverTooltip((view, position) => {
  const current = view.state.field(diagnosticViewState)
  if (current.activeIds) {
    return null
  }
  const matching = current.issues.filter((entry) => entry.from <= position && position < entry.to)
  return tooltipFor(matching)
}, { hideOnChange: true })

const dismissOnEscape = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== 'Escape' || !view.state.field(diagnosticViewState).activeIds) {
      return false
    }
    dismissDiagnosticTooltip(view)
    event.preventDefault()
    event.stopPropagation()
    return true
  },
})

const dismissOnClickAway = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {
    view.dom.ownerDocument.addEventListener('mousedown', this.onMouseDown, true)
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.view.state.field(diagnosticViewState).activeIds) {
      return
    }
    const target = event.target
    if (!(target instanceof Element)) {
      dismissDiagnosticTooltip(this.view)
      return
    }
    if (target.closest('.cm-failure-marker, .cm-diagnostic-tooltip')) {
      return
    }
    dismissDiagnosticTooltip(this.view)
  }

  destroy(): void {
    this.view.dom.ownerDocument.removeEventListener('mousedown', this.onMouseDown, true)
  }
})

/** Editor extensions for precise compiler ranges, hover help, and click-open diagnostics. */
export const diagnosticHoverTooltips: Extension = [
  diagnosticViewState,
  hoverDiagnostics,
  dismissOnEscape,
  dismissOnClickAway,
]

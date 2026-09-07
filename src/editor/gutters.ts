import {
  EditorState,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
} from '@codemirror/view'
import {
  findJavaTestMethodMarkers,
  type JavaTestMethodMarker,
} from './test-markers'

/** A source position that should be surfaced in the editor gutter. */
export interface EditorIssue {
  file: string
  line: number
  column?: number | null
  message?: string | null
}

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

export const testMethodMarkers = StateField.define<readonly JavaTestMethodMarker[]>({
  create: (state) => findJavaTestMethodMarkers(state),
  update(value, transaction) {
    return transaction.docChanged ? findJavaTestMethodMarkers(transaction.state) : value
  },
})

function safeLine(state: EditorState, line: number) {
  const target = Math.trunc(line)
  if (!Number.isFinite(target) || target < 1 || target > state.doc.lines) {
    return null
  }
  return state.doc.line(target)
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

export const setEditorIssues = StateEffect.define<readonly EditorIssue[]>()

export const failureMarkers = StateField.define<RangeSet<GutterMarker>>({
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

export const failureDecorations = StateField.define<ReturnType<typeof RangeSet.of<Decoration>>>({
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

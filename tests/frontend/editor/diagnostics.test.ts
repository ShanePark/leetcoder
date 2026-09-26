import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, showTooltip, type TooltipView } from '@codemirror/view'
import type { EditorIssue } from '../../../src/editor/gutters'
import { buildFailureMarkers, setEditorIssues } from '../../../src/editor/gutters'
import {
  buildDiagnosticRangeDecorations,
  diagnosticHoverTooltips,
  diagnosticViewState,
  dismissDiagnosticTooltip,
  showDiagnosticAtLine,
} from '../../../src/editor/diagnostics'

interface FakeElement {
  tagName: string
  className: string
  type: string
  textContent: string | null
  title: string
  dataset: Record<string, string>
  attributes: Map<string, string>
  children: FakeElement[]
  setAttribute(name: string, value: string): void
  append(...children: FakeElement[]): void
}

function fakeElement(tagName: string): FakeElement {
  return {
    tagName,
    className: '',
    type: '',
    textContent: '',
    title: '',
    dataset: {},
    attributes: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attributes.set(name, value)
    },
    append(...children) {
      this.children.push(...children)
    },
  }
}

const originalDocument = globalThis.document

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  })
})

function stateWithIssues(source: string, issues: readonly EditorIssue[] = []): EditorState {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tagName: string) => fakeElement(tagName) },
  })
  const state = EditorState.create({ doc: source, extensions: [diagnosticHoverTooltips] })
  return issues.length ? state.update({ effects: setEditorIssues.of(issues) }).state : state
}

function mutableView(initial: EditorState) {
  let current = initial
  const focus = vi.fn()
  const view = {
    get state() { return current },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      current = current.update(spec).state
    },
    focus,
  } as unknown as EditorView
  return { view, state: () => current, focus }
}

function rangeSummary(state: EditorState) {
  const ranges = buildDiagnosticRangeDecorations(state.field(diagnosticViewState).issues)
  const found: Array<{ from: number; to: number; className: string; title: string }> = []
  const cursor = ranges.iter()
  while (cursor.value) {
    const decoration = cursor.value
    found.push({
      from: cursor.from,
      to: cursor.to,
      className: decoration.spec.class ?? '',
      title: decoration.spec.attributes?.title ?? '',
    })
    cursor.next()
  }
  return found
}

describe('in-editor compiler diagnostics', () => {
  it('underlines every same-line source range and keeps messages sharing a range', () => {
    const issues: EditorIssue[] = [
      { file: 'Solution.java', line: 2, column: 2, caret: ' ^~~', message: 'cannot find symbol' },
      { file: 'Solution.java', line: 2, column: 7, caret: '      ^', message: "';' expected" },
      { file: 'Solution.java', line: 2, column: 2, caret: ' ^~~', message: 'incompatible types' },
    ]
    const state = stateWithIssues('class X {}\nabcdefghij', issues)

    expect(rangeSummary(state)).toEqual([
      {
        from: state.doc.line(2).from + 1,
        to: state.doc.line(2).from + 4,
        className: 'cm-diagnostic-range',
        title: 'cannot find symbol\nincompatible types',
      },
      {
        from: state.doc.line(2).from + 6,
        to: state.doc.line(2).from + 7,
        className: 'cm-diagnostic-range',
        title: "';' expected",
      },
    ])

    const marker = buildFailureMarkers(state, issues).iter().value
    expect(marker).not.toBeNull()
    const button = marker!.toDOM() as unknown as FakeElement
    expect(button.tagName).toBe('button')
    expect(button.dataset.diagnosticLine).toBe('2')
    expect(button.title).toBe('cannot find symbol\n\';\' expected\nincompatible types')
    expect(button.attributes.get('aria-label')).toContain('incompatible types')
  })

  it('keeps line-only issues clickable while clamping columns to valid line bounds', () => {
    const issues: EditorIssue[] = [
      { file: 'Solution.java', line: 1, column: 0, message: 'missing location' },
      { file: 'Solution.java', line: 2, column: 99, caret: '^', message: 'end of line' },
      { file: 'Solution.java', line: 2, message: 'column unavailable' },
      { file: 'Solution.java', line: 3, column: 1, message: 'invalid line' },
    ]
    const state = stateWithIssues('abc\nx', issues)
    const entries = state.field(diagnosticViewState).issues

    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ from: 0, to: 0 })
    expect(entries[1]).toMatchObject({ from: 4, to: 4 })
    expect(entries[2]).toMatchObject({ from: 5, to: 5 })
    expect(rangeSummary(state)).toEqual([])

    const { view } = mutableView(state)
    expect(showDiagnosticAtLine(view, 1)).toBe(true)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([0])
    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([2, 1])
    expect(showDiagnosticAtLine(view, 3)).toBe(false)
  })

  it('maps diagnostics through edits, closes an open tooltip, and clears stale results on replacement', () => {
    const initial = stateWithIssues('class X {}\nabcdef', [
      { file: 'Solution.java', line: 2, column: 3, caret: '  ^', message: 'bad token' },
    ])
    const { view, state } = mutableView(initial)

    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    expect(view.state.selection.main.head).toBe(initial.doc.line(2).from + 2)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([0])
    expect(view.focus).toBeDefined()

    view.dispatch({ changes: { from: 0, insert: '// heading\n' } })
    const moved = state().field(diagnosticViewState)
    expect(moved.activeIds).toBeNull()
    expect(moved.issues[0].from).toBe(state().doc.line(3).from + 2)
    expect(showDiagnosticAtLine(view, 3)).toBe(true)

    dismissDiagnosticTooltip(view)
    expect(view.state.field(diagnosticViewState).activeIds).toBeNull()
    view.dispatch({ effects: setEditorIssues.of([]) })
    expect(view.state.field(diagnosticViewState).issues).toEqual([])
    expect(showDiagnosticAtLine(view, 3)).toBe(false)
    expect(rangeSummary(view.state)).toEqual([])
  })

  it('shows compiler text and only shows a source snippet while it still matches', () => {
    const sourceLine = '  <script>&value'
    const issue: EditorIssue = {
      file: 'Solution.java',
      line: 2,
      column: 3,
      message: '<img src=x onerror=alert(1)> cannot resolve symbol',
      sourceLine,
      caret: '  ^~~~~',
    }
    const initial = stateWithIssues(`class X {}\n${sourceLine}`, [issue])
    const { view, state, focus } = mutableView(initial)

    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    const tooltip = state().facet(showTooltip).find((value) => value !== null)
    expect(tooltip).toBeDefined()
    const rendered = tooltip!.create(view) as TooltipView
    const container = rendered.dom as unknown as FakeElement
    expect(container.className).toBe('cm-diagnostic-tooltip')
    expect(container.children[0].textContent).toBe(issue.message)
    expect(container.children[1].textContent).toBe('Solution.java:2:3')
    expect(container.children[2].tagName).toBe('pre')
    expect(container.children[2].textContent).toBe(`${sourceLine}\n${issue.caret}`)

    view.dispatch({ changes: { from: initial.doc.line(2).from, insert: 'changed ' } })
    expect(state().field(diagnosticViewState).activeIds).toBeNull()
    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    const staleSourceTooltip = state().facet(showTooltip).find((value) => value !== null)!.create(view).dom as unknown as FakeElement
    expect(staleSourceTooltip.children.some((child) => child.tagName === 'pre')).toBe(false)
    expect(staleSourceTooltip.children[0].textContent).toBe(issue.message)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, showTooltip, type TooltipView } from '@codemirror/view'
import type { EditorIssue } from '../../../src/editor/gutters'
import { buildFailureMarkers, failureMarkers, setEditorIssues } from '../../../src/editor/gutters'
import {
  buildDiagnosticRangeDecorations,
  diagnosticHoverTooltips,
  diagnosticViewState,
  dismissDiagnosticTooltip,
  goToNextDiagnostic,
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
      className: decoration.spec.class ?? decoration.spec.attributes?.class ?? '',
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
        title: '',
      },
      {
        from: state.doc.line(2).from + 6,
        to: state.doc.line(2).from + 7,
        className: 'cm-diagnostic-range',
        title: '',
      },
    ])

    const marker = buildFailureMarkers(state, issues).iter().value
    expect(marker).not.toBeNull()
    const button = marker!.toDOM() as unknown as FakeElement
    expect(button.tagName).toBe('button')
    expect(button.title).toBe('')
    expect(button.attributes.get('aria-label')).toBe("Show diagnostics: cannot find symbol\n';' expected\nincompatible types")

    const gutterState = EditorState.create({
      doc: 'class X {}\nabcdef',
      extensions: [failureMarkers],
    }).update({ effects: setEditorIssues.of([issues[0]]) }).state
    const movedGutter = gutterState.update({ changes: { from: 0, insert: '// heading\n' } }).state
    const mappedMarker = movedGutter.field(failureMarkers).iter()
    expect(mappedMarker.from).toBe(movedGutter.doc.line(3).from)
    const mappedButton = mappedMarker.value!.toDOM() as unknown as FakeElement
    expect(mappedButton.attributes.get('aria-label')).toBe('Show diagnostics: cannot find symbol')
    expect(mappedButton.dataset.diagnosticLine).toBeUndefined()
  })

  it('underlines line-only and end-of-line issues and keeps blank-line diagnostics targetable', () => {
    const issues: EditorIssue[] = [
      { file: 'Solution.java', line: 1, column: 0, message: 'missing location' },
      { file: 'Solution.java', line: 2, column: 99, caret: '^', message: 'end of line' },
      { file: 'Solution.java', line: 2, message: 'column unavailable' },
      { file: 'Solution.java', line: 3, column: 1, message: 'blank line' },
      { file: 'Solution.java', line: 5, column: 1, message: 'invalid line' },
    ]
    const state = stateWithIssues('abc\nx\n\nz', issues)
    const entries = state.field(diagnosticViewState).issues

    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({ from: 0, to: 3 })
    expect(entries[1]).toMatchObject({ from: 4, to: 5 })
    expect(entries[2]).toMatchObject({ from: 4, to: 5 })
    expect(entries[3]).toMatchObject({ from: 6, to: 6 })
    expect(rangeSummary(state)).toEqual([
      { from: 0, to: 3, className: 'cm-diagnostic-range', title: '' },
      { from: 4, to: 5, className: 'cm-diagnostic-range', title: '' },
      { from: 6, to: 6, className: 'cm-diagnostic-empty-line', title: '' },
    ])

    const { view } = mutableView(state)
    expect(showDiagnosticAtLine(view, 1)).toBe(true)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([0])
    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([1, 2])
    expect(showDiagnosticAtLine(view, 3)).toBe(true)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([3])
    expect(showDiagnosticAtLine(view, 5)).toBe(false)
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

  it('reattaches an underline after its source character is deleted', () => {
    const initial = stateWithIssues('abc', [
      { file: 'Solution.java', line: 1, column: 2, caret: ' ^', message: 'invalid token' },
    ])
    const { view, state } = mutableView(initial)

    view.dispatch({ changes: { from: 1, to: 2, insert: '' } })

    expect(state().doc.toString()).toBe('ac')
    expect(state().field(diagnosticViewState).issues[0]).toMatchObject({ from: 1, to: 2 })
    expect(rangeSummary(state())).toEqual([
      { from: 1, to: 2, className: 'cm-diagnostic-range', title: '' },
    ])
  })

  it('shows compact escaped messages without paths or source dumps', () => {
    const sourceLine = '  <script>&value'
    const longMessage = `cannot resolve ${'MissingType.'.repeat(24)}`
    const issue: EditorIssue = {
      file: 'Solution.java',
      line: 2,
      column: 3,
      message: '<img src=x onerror=alert(1)> cannot resolve symbol',
      sourceLine,
      caret: '  ^~~~~',
    }
    const initial = stateWithIssues(`class X {}\n${sourceLine}`, [issue, { ...issue, message: longMessage }])
    const { view, state, focus } = mutableView(initial)

    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    const tooltip = state().facet(showTooltip).find((value) => value !== null)
    expect(tooltip).toBeDefined()
    const rendered = tooltip!.create(view) as TooltipView
    const container = rendered.dom as unknown as FakeElement
    expect(container.className).toBe('cm-diagnostic-tooltip')
    expect(container.children.map((child) => child.textContent)).toEqual([issue.message, longMessage])
    expect(container.children.some((child) => child.tagName === 'pre')).toBe(false)
    expect(container.children.map((child) => child.textContent).join(' ')).not.toContain('Solution.java')

    view.dispatch({ changes: { from: initial.doc.line(2).from, insert: 'changed ' } })
    expect(state().field(diagnosticViewState).activeIds).toBeNull()
    expect(showDiagnosticAtLine(view, 2)).toBe(true)
    const staleSourceTooltip = state().facet(showTooltip).find((value) => value !== null)!.create(view).dom as unknown as FakeElement
    expect(staleSourceTooltip.children.some((child) => child.tagName === 'pre')).toBe(false)
    expect(staleSourceTooltip.children[0].textContent).toBe(issue.message)
  })
})

describe('next diagnostic navigation', () => {
  // Line 2 starts at 4. Issues start at 5 (two sharing it), 8, and 0.
  const issues: EditorIssue[] = [
    { file: 'Solution.java', line: 2, column: 2, caret: ' ^~', message: 'first on line 2' },
    { file: 'Solution.java', line: 2, column: 5, caret: '    ^', message: 'second on line 2' },
    { file: 'Solution.java', line: 2, column: 2, caret: ' ^~', message: 'shares the first start' },
    { file: 'Solution.java', line: 1, column: 1, caret: '^', message: 'line 1' },
  ]

  function viewAt(cursor: number, source = 'abc\nabcdef', entries = issues) {
    const initial = stateWithIssues(source, entries)
    return mutableView(initial.update({ selection: { anchor: cursor } }).state)
  }

  it('moves to the first issue starting after the cursor and opens all issues sharing that start', () => {
    const { view, focus } = viewAt(1)

    expect(goToNextDiagnostic(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(5)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([0, 2])
    expect(focus).toHaveBeenCalledOnce()
    const tooltip = view.state.facet(showTooltip).find((value) => value !== null)
    expect(tooltip).toBeDefined()
    const container = tooltip!.create(view).dom as unknown as FakeElement
    expect(container.children.map((child) => child.textContent)).toEqual(['first on line 2', 'shares the first start'])
  })

  it('skips the issue the cursor is at the start of or inside', () => {
    const atStart = viewAt(5).view
    expect(goToNextDiagnostic(atStart)).toBe(true)
    expect(atStart.state.selection.main.head).toBe(8)
    expect(atStart.state.field(diagnosticViewState).activeIds).toEqual([1])

    const inside = viewAt(6).view
    expect(goToNextDiagnostic(inside)).toBe(true)
    expect(inside.state.selection.main.head).toBe(8)
  })

  it('wraps to the first issue and cycles through every issue on repeated presses', () => {
    const { view } = viewAt(8)
    const visited: Array<{ head: number; activeIds: readonly number[] | null }> = []
    for (let press = 0; press < 4; press += 1) {
      expect(goToNextDiagnostic(view)).toBe(true)
      visited.push({
        head: view.state.selection.main.head,
        activeIds: view.state.field(diagnosticViewState).activeIds,
      })
    }
    expect(visited).toEqual([
      { head: 0, activeIds: [3] },
      { head: 5, activeIds: [0, 2] },
      { head: 8, activeIds: [1] },
      { head: 0, activeIds: [3] },
    ])
  })

  it('wraps to the same issue when it is the only one', () => {
    const { view } = viewAt(2, 'abc\nabcdef', [issues[0]])
    expect(goToNextDiagnostic(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(5)
    expect(goToNextDiagnostic(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(5)
    expect(view.state.field(diagnosticViewState).activeIds).toEqual([0])
  })

  it('returns false and leaves the editor unchanged without issues', () => {
    const { view, state, focus } = viewAt(2, 'abc\nabcdef', [])
    const before = state()
    expect(goToNextDiagnostic(view)).toBe(false)
    expect(state()).toBe(before)
    expect(focus).not.toHaveBeenCalled()
  })
})

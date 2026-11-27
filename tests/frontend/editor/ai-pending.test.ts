import { java } from '@codemirror/lang-java'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { renderJavaProblemSource } from '../../../src/domain/template'
import { JavaEditor } from '../../../src/editor'
import {
  aiPendingEffect,
  aiPendingExtension,
  aiPendingRegion,
  clearAiPendingEffect,
  readAiInsertedLines,
  readAiPending,
  readAiPendingStatus,
  type AiPendingStatus,
} from '../../../src/editor/ai-pending'
import { AI_TESTS_USER_EVENT } from '../../../src/editor/ai-tests'

// JavaEditor is exercised through its real extensions without browser layout.
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>()
  class StateOnlyEditorView {
    state: EditorState
    constructor(options: { state: EditorState }) { this.state = options.state }
    dispatch = (spec: TransactionSpec) => { this.state = this.state.update(spec).state }
  }
  Object.setPrototypeOf(StateOnlyEditorView, original.EditorView)
  return { ...original, EditorView: StateOnlyEditorView }
})

const TEMPLATE = renderJavaProblemSource('example', 'Q1Example', 'public int minMoves(int[] nums) {')
const ASSERTION = 'assertThat(minMoves(new int[]{2, 1, 3})).isEqualTo(3);'

const status: AiPendingStatus = { title: 'Generating tests', label: 'Reading the problem', detail: null, step: 0, total: 3 }

const classWith = (test: string): string =>
  `class Q1Example {\n    int f() {\n        return 1;\n    }\n\n${test}\n}\n`

const lineAt = (source: string, text: string, after = 0): { from: number; to: number } => {
  const from = source.indexOf(text, after)
  expect(from).toBeGreaterThanOrEqual(0)
  const start = source.lastIndexOf('\n', from - 1) + 1
  const end = source.indexOf('\n', from)
  return { from: start, to: end < 0 ? source.length : end }
}

function lockedState(source: string, kind: 'examples' | 'case' = 'examples'): EditorState {
  const state = EditorState.create({ doc: source, extensions: [java(), aiPendingExtension] })
  const effect = aiPendingEffect(state, kind, status)
  expect(effect).not.toBeNull()
  return state.update({ effects: effect! }).state
}

/** Every decoration the editor would draw, from all static sources. */
function decorations(state: EditorState): Array<{ from: number; to: number; value: Decoration }> {
  const ranges: Array<{ from: number; to: number; value: Decoration }> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    ;(source as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      ranges.push({ from, to, value })
    })
  }
  return ranges
}

describe('AI pending region', () => {
  it('locks the template test() from its annotation to its closing brace, with the status on the body line', () => {
    const region = aiPendingRegion(TEMPLATE, 'examples')
    expect(region).toEqual({
      from: lineAt(TEMPLATE, '    @Test').from,
      to: lineAt(TEMPLATE, '    }', TEMPLATE.indexOf('assertThat()')).to,
      anchor: lineAt(TEMPLATE, '        assertThat()').to,
    })
  })

  it('puts the status on the opening line of an empty or one-line test()', () => {
    const empty = classWith('    @Test\n    public void test() {\n    }')
    expect(aiPendingRegion(empty, 'examples')).toEqual({
      from: lineAt(empty, '    @Test').from,
      to: lineAt(empty, '    }\n}').to,
      anchor: lineAt(empty, 'public void test() {').to,
    })

    const oneLine = classWith('    @Test\n    public void test() {}')
    const testLine = lineAt(oneLine, 'public void test() {}')
    expect(aiPendingRegion(oneLine, 'examples')).toEqual({
      from: lineAt(oneLine, '    @Test').from,
      to: testLine.to,
      anchor: testLine.to,
    })
  })

  it('locks nothing when test() already has code', () => {
    const filled = TEMPLATE.replace('assertThat()', ASSERTION)
    expect(aiPendingRegion(filled, 'examples')).toBeNull()
  })

  it('locks the last test method for a case, with the status after its closing brace', () => {
    const filled = TEMPLATE.replace('assertThat()', ASSERTION)
    const closing = lineAt(filled, '    }', filled.indexOf(ASSERTION))
    expect(aiPendingRegion(filled, 'case')).toEqual({
      from: lineAt(filled, '    @Test').from,
      to: closing.to,
      anchor: closing.to,
    })
  })

  it('locks only the line the new method would follow when the class has no test', () => {
    const source = 'class Q1Example {\n    int f() {\n        return 1;\n    }\n}\n'
    const region = aiPendingRegion(source, 'case')
    expect(region).not.toBeNull()
    expect(region!.from).toBe(region!.to - source.slice(0, region!.to).split('\n').at(-1)!.length)
    expect(source.slice(region!.from, region!.to)).toBe('    }')
  })
})

describe('AI pending lock', () => {
  it('refuses edits inside the locked lines and at their edges', () => {
    const state = lockedState(TEMPLATE)
    const { from, to, anchor } = readAiPending(state)!
    const refused: TransactionSpec[] = [
      { changes: { from: anchor, insert: 'x' } },
      { changes: { from: from + 2, to: from + 3 } },
      { changes: { from, insert: 'x' } },
      { changes: { from: to, insert: 'x' } },
      // Joining a locked line with its neighbours.
      { changes: { from: from - 1, to: from } },
      { changes: { from: to, to: to + 1 } },
      { changes: { from: 0, to: state.doc.length, insert: 'class Other {}' } },
    ]
    for (const spec of refused) {
      expect(state.update(spec).state.doc.toString()).toBe(TEMPLATE)
    }
  })

  it('allows edits elsewhere and whole lines added around the lock, and follows them', () => {
    const state = lockedState(TEMPLATE)
    const before = readAiPending(state)!
    const edited = state.update({ changes: { from: 0, insert: '// note\n' } }).state
    expect(edited.doc.toString()).not.toBe(TEMPLATE)
    const shift = '// note\n'.length
    expect(readAiPending(edited)).toEqual({ from: before.from + shift, to: before.to + shift, anchor: before.anchor + shift })

    const above = edited.update({ changes: { from: readAiPending(edited)!.from, insert: '\n' } }).state
    expect(readAiPending(above)!.from).toBe(readAiPending(edited)!.from + 1)
    const below = above.update({ changes: { from: readAiPending(above)!.to, insert: '\n    // after' } }).state
    expect(below.doc.toString()).toContain('    }\n    // after')
    expect(readAiPending(below)!.to).toBe(readAiPending(above)!.to)
  })

  it('lets the fill through and ends the wait with it', () => {
    const state = lockedState(TEMPLATE)
    const anchor = readAiPending(state)!.anchor
    const body = TEMPLATE.lastIndexOf('assertThat()', anchor)
    const filled = state.update({
      changes: { from: body, to: anchor, insert: ASSERTION },
      userEvent: AI_TESTS_USER_EVENT,
    }).state
    expect(filled.doc.toString()).toBe(TEMPLATE.replace('assertThat()', ASSERTION))
    expect(readAiPending(filled)).toBeNull()
  })

  it('lets a document load replace the text and drop the lock', () => {
    const state = lockedState(TEMPLATE)
    const loaded = state.update({
      changes: { from: 0, to: state.doc.length, insert: 'class Other {}' },
      effects: clearAiPendingEffect,
    }).state
    expect(loaded.doc.toString()).toBe('class Other {}')
    expect(readAiPending(loaded)).toBeNull()
  })

  it('moves the shown status to its next step without moving the lock', () => {
    const state = lockedState(TEMPLATE)
    const next = { ...status, label: 'Asking Claude', detail: 'model-x', step: 1 }
    const effect = aiPendingEffect(state, 'examples', next)!
    const stepped = state.update({ effects: effect }).state
    expect(readAiPendingStatus(stepped)).toEqual(next)
    expect(readAiPending(stepped)).toEqual(readAiPending(state))
  })

  it('locks nothing when the request could not apply', () => {
    const state = EditorState.create({ doc: 'class A {}', extensions: [java(), aiPendingExtension] })
    expect(aiPendingEffect(state, 'examples', status)).toBeNull()
  })
})

describe('AI pending indicator', () => {
  it.each([
    ['the template', TEMPLATE],
    ['a one-line test()', classWith('    @Test\n    public void test() {}')],
  ])('draws only inline decorations and keeps the line count for %s', (_name, source) => {
    const state = EditorState.create({ doc: source, extensions: [java(), aiPendingExtension] })
    const locked = lockedState(source)
    expect(locked.doc.lines).toBe(state.doc.lines)

    const drawn = decorations(locked)
    const widgets = drawn.filter((range) => range.from === range.to && range.value.spec.widget)
    expect(widgets).toHaveLength(1)
    expect(widgets[0].from).toBe(readAiPending(locked)!.anchor)
    // A block widget or a replaced range would add or remove visual lines.
    for (const range of drawn) {
      expect(range.value.spec.block).toBeFalsy()
      expect((range.value as unknown as { point?: boolean }).point && range.from !== range.to).toBeFalsy()
    }
    expect(drawn.some((range) => range.value.spec.class === 'cm-ai-pending-line cm-ai-pending-anchor-line')).toBe(true)

    const cleared = locked.update({ effects: clearAiPendingEffect }).state
    expect(cleared.doc.lines).toBe(state.doc.lines)
    expect(decorations(cleared).filter((range) => range.value.spec.widget)).toHaveLength(0)
  })
})

describe('JavaEditor AI pending', () => {
  function createEditor(source: string): JavaEditor {
    const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement)
    editor.setValue(source)
    return editor
  }

  it('keeps the user out of the locked test and fills it, marking the added lines', () => {
    const editor = createEditor(TEMPLATE)
    editor.showAiPending('examples', status)
    expect(readAiPending(editor.view.state)).not.toBeNull()

    const anchor = readAiPending(editor.view.state)!.anchor
    editor.view.dispatch({ changes: { from: anchor, insert: 'x' }, userEvent: 'input.type' })
    expect(editor.getValue()).toBe(TEMPLATE)

    expect(editor.applyAiTests([ASSERTION]).ok).toBe(true)
    expect(editor.getValue()).toContain(`        ${ASSERTION}\n    }`)
    expect(readAiPending(editor.view.state)).toBeNull()
    const assertionLine = editor.view.state.doc.lineAt(editor.getValue().indexOf(ASSERTION)).number
    expect(readAiInsertedLines(editor.view.state)).toEqual([assertionLine])
  })

  it('marks every line of an added case method', () => {
    const filled = TEMPLATE.replace('assertThat()', ASSERTION)
    const editor = createEditor(filled)
    editor.showAiPending('case', { ...status, title: 'Adding failing case' })
    expect(readAiPending(editor.view.state)).not.toBeNull()

    expect(editor.applyAiCaseTest([ASSERTION]).ok).toBe(true)
    expect(readAiPending(editor.view.state)).toBeNull()
    const source = editor.getValue()
    const first = editor.view.state.doc.lineAt(source.indexOf('public void test2()')).number - 1
    const lines = readAiInsertedLines(editor.view.state)
    expect(lines[0]).toBe(first)
    expect(source.split('\n')[lines.at(-1)! - 1]).toBe('    }')
  })

  it('fills a file that is not open the way it fills the editor, imports included', () => {
    const editor = createEditor('class Other {}\n')
    const listAssertion = 'assertThat(List.of(minMoves(new int[]{1}))).containsExactly(0);'

    const filled = editor.fillAiTestsInSource('examples', TEMPLATE, [listAssertion])
    expect(filled.result.ok).toBe(true)
    expect(filled.source).toContain('import java.util.List;')
    expect(filled.source).toContain(`        ${listAssertion}\n    }`)

    const added = editor.fillAiTestsInSource('case', filled.source!, [ASSERTION])
    expect(added.result).toMatchObject({ ok: true, methodName: 'test2' })
    expect(added.source).toContain('public void test2()')

    const rejected = editor.fillAiTestsInSource('examples', filled.source!, [ASSERTION])
    expect(rejected).toEqual({ result: { ok: false, reason: expect.any(String) }, source: null })
    expect(editor.getValue()).toBe('class Other {}\n')
  })

  it('drops the lock when another document loads', () => {
    const editor = createEditor(TEMPLATE)
    editor.showAiPending('examples', status)
    editor.setValue('class Other {}\n')
    expect(readAiPending(editor.view.state)).toBeNull()

    editor.setValue(TEMPLATE)
    editor.showAiPending('examples', status)
    editor.setValue(TEMPLATE)
    expect(readAiPending(editor.view.state)).toBeNull()

    editor.showAiPending('examples', status)
    editor.reloadExternalValue(TEMPLATE.replace('Q1Example', 'Q1Renamed'))
    expect(readAiPending(editor.view.state)).toBeNull()
  })
})

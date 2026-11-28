import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { JavaEditor } from '../../../src/editor'
import { applyUndo } from './helpers'

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

const BEFORE = 'class A {\n  int f() {\n    return 1;\n  }\n}\n'
const AFTER = 'class A {\n  // note\n  int f() {\n    return 2;\n  }\n}\n'

function createEditor(source: string): JavaEditor {
  const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement)
  editor.setValue(source)
  return editor
}

describe('replacing the document', () => {
  it('changes only the differing lines, keeps the cursor on its code, and undoes in one step', () => {
    const editor = createEditor(BEFORE)
    const cursor = BEFORE.indexOf('f()')
    editor.view.dispatch({ selection: EditorSelection.cursor(cursor) })

    editor.replaceValue(AFTER)
    expect(editor.getValue()).toBe(AFTER)
    expect(editor.view.state.selection.main.head).toBe(AFTER.indexOf('f()'))

    const undone = applyUndo(editor.view.state)
    expect(undone.handled).toBe(true)
    expect(undone.state.doc.toString()).toBe(BEFORE)
  })

  it('does nothing for the same text', () => {
    const editor = createEditor(BEFORE)
    const state = editor.view.state
    editor.replaceValue(BEFORE)
    expect(editor.view.state).toBe(state)
  })
})

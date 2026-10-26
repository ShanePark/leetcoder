import { autocompletion, completionStatus, CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { javaCompletions } from '../../../src/completions'
import { insertSingleCompletion, startCompletionOrInsertSingle } from '../../../src/editor/single-completion'
import { mutableEditorView } from './helpers'

const source = `class Solution {
    long dfsIsland(int[][] grid, int i, int j) {
        int y = i, x = j;
        if (y < 0 || x == grid.l) return 0;
    }
}`

function harness(cursor = source.indexOf('grid.l') + 'grid.l'.length, doc = source) {
  return mutableEditorView(EditorState.create({
    doc,
    extensions: [java(), autocompletion({ override: [javaCompletions] })],
    selection: { anchor: cursor },
  }))
}

// The editor's autocompletion plugin needs a DOM. Run the wrapped source the
// way that plugin does for the explicit query the command starts.
async function runExplicitQuery(editor: ReturnType<typeof harness>) {
  const state = editor.state()
  const context = new CompletionContext(state, state.selection.main.head, true, editor.view)
  const result = await insertSingleCompletion(javaCompletions)(context) as CompletionResult | null
  await Promise.resolve()
  return result
}

describe('explicit completion with a single suggestion', () => {
  it('inserts the only matching member before a closing parenthesis', async () => {
    const editor = harness()
    expect(startCompletionOrInsertSingle(editor.view)).toBe(true)
    expect(completionStatus(editor.state())).toBe('pending')

    expect(await runExplicitQuery(editor)).toBeNull()
    expect(editor.state().doc.toString()).toContain('if (y < 0 || x == grid.length) return 0;')
    expect(editor.state().selection.main.head).toBe(source.indexOf('grid.l') + 'grid.length'.length)
  })

  it('opens the popup normally when several suggestions match', async () => {
    const cursor = source.indexOf('grid.') + 'grid.'.length
    const editor = harness(cursor, source.replace('grid.l)', 'grid.)'))
    startCompletionOrInsertSingle(editor.view)

    const result = await runExplicitQuery(editor)
    expect(result?.options.map((option) => option.label)).toEqual(['length', 'clone()'])
    expect(editor.state().doc.toString()).toContain('x == grid.) return 0;')
  })

  it('leaves typed and automatic completion queries unchanged', async () => {
    const editor = harness()
    const automatic = new CompletionContext(editor.state(), editor.state().selection.main.head, false, editor.view)
    expect(insertSingleCompletion(javaCompletions)(automatic)).not.toBeNull()

    // Without the command, an explicit query (such as a restarted popup) only lists options.
    expect(await runExplicitQuery(editor)).not.toBeNull()
    startCompletionOrInsertSingle(editor.view)
    editor.view.dispatch({ selection: { anchor: editor.state().selection.main.head - 1 } })
    expect(await runExplicitQuery(editor)).not.toBeNull()
    expect(editor.state().doc.toString()).toBe(source)
  })

  it('does not insert when the document changed before the query finished', async () => {
    const editor = harness()
    startCompletionOrInsertSingle(editor.view)
    const state = editor.state()
    const context = new CompletionContext(state, state.selection.main.head, true, editor.view)
    const result = insertSingleCompletion(javaCompletions)(context)
    editor.view.dispatch({ changes: { from: 0, insert: ' ' } })
    await Promise.resolve()
    expect(result).toBeNull()
    expect(editor.state().doc.toString()).toBe(` ${source}`)
  })
})

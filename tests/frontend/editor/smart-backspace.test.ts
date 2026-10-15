import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { ensureSyntaxTree, indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { smartBackspaceOnBlankLine } from '../../../src/editor/editing'
import { mutableEditorView, runEditorCommand } from './helpers'

const loop = [
  'class Solution {',
  '    void solve() {',
  '        for (int i = 0; i < 3; i++) {',
  '            i++;',
  '        }',
]

function editorState(lines: string[], line: number, column: number, extraCursor?: [number, number]): EditorState {
  const doc = lines.join('\n')
  const offset = (l: number, c: number) => lines.slice(0, l - 1).reduce((sum, text) => sum + text.length + 1, 0) + c
  const ranges = [EditorSelection.cursor(offset(line, column))]
  if (extraCursor) ranges.push(EditorSelection.cursor(offset(...extraCursor)))
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: [
      java(),
      history(),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
  expect(ensureSyntaxTree(state, state.doc.length, 1000)).not.toBeNull()
  return state.update({}).state
}

function cursorLineAndColumn(state: EditorState): [number, number] {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return [line.number, head - line.from]
}

describe('smart backspace on blank lines', () => {
  it('joins a blank line at its proper indentation with the previous line end', () => {
    const state = editorState([...loop, '        ', '    }', '}'], 6, 8)
    const next = runEditorCommand(state, smartBackspaceOnBlankLine)
    expect(next.doc.toString()).toBe([...loop, '    }', '}'].join('\n'))
    expect(cursorLineAndColumn(next)).toEqual([5, 9])
  })

  it('joins when the cursor is before the proper indentation and drops trailing whitespace', () => {
    const state = editorState([...loop, '            ', '    }', '}'], 6, 4)
    const next = runEditorCommand(state, smartBackspaceOnBlankLine)
    expect(next.doc.toString()).toBe([...loop, '    }', '}'].join('\n'))
    expect(cursorLineAndColumn(next)).toEqual([5, 9])
  })

  it('trims back to the proper indentation when the cursor is beyond it', () => {
    const state = editorState([...loop, '              ', '    }', '}'], 6, 12)
    const next = runEditorCommand(state, smartBackspaceOnBlankLine)
    expect(next.doc.toString()).toBe([...loop, '        ', '    }', '}'].join('\n'))
    expect(cursorLineAndColumn(next)).toEqual([6, 8])
  })

  it('falls through when the line has text', () => {
    const state = editorState([...loop, '        int x;', '    }', '}'], 6, 8)
    const { view, state: current } = mutableEditorView(state)
    expect(smartBackspaceOnBlankLine(view)).toBe(false)
    expect(current()).toBe(state)
  })

  it('falls through for a selection and on the first line', () => {
    const selected = editorState([...loop, '        ', '    }', '}'], 6, 8)
      .update({ selection: EditorSelection.single(1, 4) }).state
    expect(smartBackspaceOnBlankLine(mutableEditorView(selected).view)).toBe(false)
    const first = editorState(['    ', 'class A {}'], 1, 4)
    expect(smartBackspaceOnBlankLine(mutableEditorView(first).view)).toBe(false)
  })

  it('handles one cursor per blank line', () => {
    const lines = [...loop, '        ', '    }', '', '    ', '}']
    const state = editorState(lines, 6, 8, [9, 4])
    const next = runEditorCommand(state, smartBackspaceOnBlankLine)
    expect(next.doc.toString()).toBe([...loop, '    }', '', '}'].join('\n'))
    expect(next.selection.ranges.map((range) => range.head)).toEqual([
      next.doc.line(5).to,
      next.doc.line(7).to,
    ])
  })

  it('undoes in one step', () => {
    const lines = [...loop, '            ', '    }', '}']
    const state = editorState(lines, 6, 4)
    const { view, state: current } = mutableEditorView(state)
    expect(smartBackspaceOnBlankLine(view)).toBe(true)
    expect(current().doc.toString()).toBe([...loop, '    }', '}'].join('\n'))
    expect(undo(view)).toBe(true)
    expect(current().doc.toString()).toBe(lines.join('\n'))
  })
})

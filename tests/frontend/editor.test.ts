import { copyLineDown, deleteLine, history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import {
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import {
  findJavaTestMethodAt,
  formatJavaDocClipboard,
  isJavaDocAltShortcut,
  isLineDeleteAltShortcut,
  isLineDuplicateAltShortcut,
  planJavaDocInsertion,
} from '../../src/editor'

function javaState(source: string): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [java()],
  })
}

function applyDeleteLine(state: EditorState): EditorState {
  let transaction: TransactionSpec | null = null
  const view = {
    state,
    lineWrapping: false,
    moveVertically: (range: unknown) => range,
    dispatch: (spec: TransactionSpec) => {
      transaction = spec
    },
  } as unknown as EditorView

  expect(deleteLine(view)).toBe(true)
  if (!transaction) {
    throw new Error('deleteLine did not dispatch a transaction')
  }
  return state.update(transaction).state
}

function applyUndo(state: EditorState): { handled: boolean; state: EditorState } {
  let nextState = state
  const handled = undo({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state
    },
  })
  return { handled, state: nextState }
}

describe('Java test method lookup', () => {
  it('finds a test from its annotation, declaration, or nested body', () => {
    const source = [
      'class Solution {',
      '    @Test',
      '    public void test1() {',
      '        if (true) {',
      '            String brace = "}";',
      '        }',
      '    }',
      '    @Test',
      '    public void test2() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('@Test') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('test1') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('String brace') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('test2') + 2)).toBe('test2')
  })

  it('returns null between methods and outside test methods', () => {
    const source = [
      'class Solution {',
      '    @Test void test1() {}',
      '',
      '    void helper() {}',
      '',
      '    @Test void test2() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('helper'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('helper()') + 'helper()'.length)).toBeNull()
    const gapBeforeTest2 = source.indexOf('\n\n    @Test', source.indexOf('helper')) + 1
    expect(findJavaTestMethodAt(state, gapBeforeTest2)).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('}') + 1)).toBeNull()
  })

  it('ignores annotation-looking text in comments and strings', () => {
    const source = [
      'class Solution {',
      '    // @Test void fakeComment() {}',
      '    String text = "@Test void fakeString() {}";',
      '    @Test void actual_test() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('fakeComment'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('fakeString'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('actual_test') + 2)).toBe('actual_test')
  })

  it('supports qualified Test annotations and keeps Java identifier names intact', () => {
    const source = [
      'class Solution {',
      '    @org.junit.jupiter.api.Test',
      '    void test_2$() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('junit'))).toBe('test_2$')
  })
})

describe('JavaDoc editor helpers', () => {
  it('plans an indented JavaDoc above a class and places the cursor after the body prefix', () => {
    const source = 'package demo;\n\n    public class Solution {\n}'
    const position = source.indexOf('Solution')
    const edit = planJavaDocInsertion(source, position)

    expect(edit).toEqual({
      from: source.indexOf('    public class'),
      insert: '    /**\n     * \n     */\n',
      cursor: source.indexOf('    public class') + '    /**\n     * '.length,
    })
  })

  it('preserves CRLF line endings', () => {
    const source = 'public class Solution {\r\n}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('/**\r\n * \r\n */\r\n')
  })

  it('uses the class line separator when a source contains mixed line endings', () => {
    const source = 'package demo;\npublic class Solution {\r\n}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('/**\r\n * \r\n */\r\n')
  })

  it('does nothing when the cursor is not on a class declaration line', () => {
    const source = 'public class Solution {\n    void solve() {}\n}'

    expect(planJavaDocInsertion(source, source.indexOf('solve'))).toBeNull()
    expect(planJavaDocInsertion('// class Ignored {}', 3)).toBeNull()
  })

  it('does not treat a class-looking line inside a block comment as a declaration', () => {
    const source = '/*\nclass Fake {}\n*/\nclass Real {}'

    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('does not treat a class-looking line inside a Java text block as a declaration', () => {
    const source = 'String text = """\nThis contains a " quote\nclass Fake {}\n""";\nclass Real {}'

    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('keeps escaped triple quotes inside a Java text block', () => {
    const source = 'String text = """\nescaped \\"""\nclass Fake {}\n""";\nclass Real {}'

    expect(source).toContain('escaped \\"""')
    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('matches only the exact Shift+Option+J shortcut', () => {
    const shortcut = { code: 'KeyJ', shiftKey: true, altKey: true, metaKey: false, ctrlKey: false }

    expect(isJavaDocAltShortcut(shortcut)).toBe(true)
    expect(isJavaDocAltShortcut({ ...shortcut, code: 'KeyK' })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, shiftKey: false })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, metaKey: true })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, ctrlKey: true })).toBe(false)
  })

  it('matches the Option+D and Option+Backspace line shortcuts without consuming other modifiers', () => {
    const duplicate = { code: 'KeyD', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }
    const remove = { code: 'Backspace', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }

    expect(isLineDuplicateAltShortcut(duplicate)).toBe(true)
    expect(isLineDuplicateAltShortcut({ ...duplicate, shiftKey: true })).toBe(false)
    expect(isLineDuplicateAltShortcut({ ...duplicate, metaKey: true })).toBe(false)
    expect(isLineDuplicateAltShortcut({ ...duplicate, code: 'KeyS' })).toBe(false)

    expect(isLineDeleteAltShortcut(remove)).toBe(true)
    expect(isLineDeleteAltShortcut({ ...remove, ctrlKey: true })).toBe(false)
    expect(isLineDeleteAltShortcut({ ...remove, code: 'Delete' })).toBe(false)
  })

  it('duplicates the selected lines as one block and keeps the selection on the copy', () => {
    const source = 'class Solution {\n    int value;\n    return value;\n}'
    const firstSelectedLine = source.indexOf('    int')
    const lastSelectedLineEnd = source.indexOf('\n}', firstSelectedLine)
    const state = EditorState.create({
      doc: source,
      selection: EditorSelection.single(firstSelectedLine, lastSelectedLineEnd),
    })
    let nextState: EditorState | undefined

    expect(copyLineDown({
      state,
      dispatch: (transaction) => {
        nextState = transaction.state
      },
    })).toBe(true)

    expect(nextState?.doc.toString()).toBe(
      'class Solution {\n    int value;\n    return value;\n    int value;\n    return value;\n}',
    )
    const duplicatedSource = nextState?.doc.toString() ?? ''
    expect(nextState?.selection.main.from).toBe(duplicatedSource.indexOf('    int', firstSelectedLine + 1))
    expect(nextState?.selection.main.to).toBe(duplicatedSource.indexOf('\n}'))
  })

  it('duplicates each line independently for multiple cursors', () => {
    const source = 'first\n    second\nthird'
    const state = EditorState.create({
      doc: source,
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(source.indexOf('third') + 2),
      ]),
    })
    let nextState: EditorState | undefined

    expect(copyLineDown({
      state,
      dispatch: (transaction) => {
        nextState = transaction.state
      },
    })).toBe(true)

    const duplicatedSource = nextState?.doc.toString() ?? ''
    expect(duplicatedSource).toBe('first\nfirst\n    second\nthird\nthird')
    const finalCopyStart = duplicatedSource.lastIndexOf('third')
    expect(nextState?.selection.ranges.map((range) => range.head)).toEqual([7, finalCopyStart + 2])
  })

  it('deletes the current or selected lines, including the final line without leaving a blank line', () => {
    const source = 'first\n    second\nthird'
    const currentLine = EditorState.create({
      doc: source,
      selection: { anchor: source.indexOf('second') },
    })
    expect(applyDeleteLine(currentLine).doc.toString()).toBe('first\nthird')

    const selectedLines = EditorState.create({
      doc: source,
      selection: EditorSelection.single(source.indexOf('    second'), source.length),
    })
    expect(applyDeleteLine(selectedLines).doc.toString()).toBe('first')

    const finalLine = EditorState.create({
      doc: source,
      selection: { anchor: source.indexOf('third') },
    })
    expect(applyDeleteLine(finalLine).doc.toString()).toBe('first\n    second')
  })

  it('keeps the loaded document when undo reaches the start of user history', () => {
    const source = 'class Solution {}'
    let state = EditorState.create({
      doc: '',
      extensions: [history()],
    })

    // This mirrors JavaEditor.setValue: loading a file must not create an
    // undo step back to the empty bootstrap document.
    state = state.update({
      changes: { from: 0, to: 0, insert: source },
      selection: { anchor: 0 },
      annotations: Transaction.addToHistory.of(false),
    }).state
    state = state.update({
      changes: { from: 0, insert: '// ' },
      annotations: Transaction.time.of(0),
    }).state

    const firstUndo = applyUndo(state)
    expect(firstUndo.handled).toBe(true)
    expect(firstUndo.state.doc.toString()).toBe(source)

    const extraUndo = applyUndo(firstUndo.state)
    expect(extraUndo.handled).toBe(false)
    expect(extraUndo.state.doc.toString()).toBe(source)
  })

  it('does not create a duplicate and targets an existing JavaDoc body', () => {
    const source = '/**\n * Existing description\n */\npublic class Solution {}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('')
    expect(edit?.cursor).toBe(source.indexOf('Existing description'))
  })

  it('recognizes a compact JavaDoc immediately above the class', () => {
    const source = '/** Existing description */\nclass Solution {}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('')
    expect(edit?.cursor).toBe(source.indexOf('Existing description'))
  })

  it('formats multiline JavaDoc clipboard input with the current prefix', () => {
    const source = '/**\n * |\n */\npublic class Solution {}'
    const position = source.indexOf('|')
    const document = source.replace('|', '')

    expect(formatJavaDocClipboard('Runtime\r\n0\r\nms\r\nBeats\r\n100.00%\r\n', document, position))
      .toBe('Runtime\n * 0\n * ms\n * Beats\n * 100.00%')
  })

  it('preserves internal blank lines while removing trailing newlines', () => {
    const source = '/**\n * text\n */\nclass Solution {}'
    const position = source.indexOf('text') + 4

    expect(formatJavaDocClipboard('one\n\ntwo\n\n', source, position))
      .toBe('one\n * \n * two')
  })

  it('leaves ordinary code, non-JavaDoc comments, and single-line pastes unchanged', () => {
    const code = 'class Solution {\n    String value;\n}'
    expect(formatJavaDocClipboard('a\nb', code, code.indexOf('value'))).toBe('a\nb')

    const blockComment = '/*\n * text\n */\nclass Solution {}'
    expect(formatJavaDocClipboard('a\nb', blockComment, blockComment.indexOf('text') + 4)).toBe('a\nb')

    const javaDoc = '/**\n * text\n */\nclass Solution {}'
    const position = javaDoc.indexOf('text') + 4
    expect(formatJavaDocClipboard('single line', javaDoc, position)).toBe('single line')
  })
})

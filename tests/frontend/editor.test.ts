import { copyLineDown, deleteLine, history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import {
  buildTestRunMarkers,
  findJavaTestMethodAt,
  findJavaTestMethodMarkers,
  formatJavaDocClipboard,
  isJavaDocAltShortcut,
  isLineCutAltShortcut,
  isLineDeleteAltShortcut,
  isLineDuplicateAltShortcut,
  isPasteAltShortcut,
  isRedoAltShortcut,
  isReformatShortcut,
  isShortcutHelpAltShortcut,
  isUndoAltShortcut,
  javaAutoImports,
  planJavaDocInsertion,
  reformatJavaDocument,
  selectedLineBlocks,
  testRunShortcutLabel,
} from '../../src/editor'

/** Drive a command that reads `view.state` again between its dispatches. */
function runEditorCommand(
  state: EditorState,
  command: (view: EditorView) => boolean,
): EditorState {
  let current = state
  const view = {
    get state() {
      return current
    },
    lineWrapping: false,
    moveVertically: (range: unknown) => range,
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state
    },
  } as unknown as EditorView

  expect(command(view)).toBe(true)
  return current
}

describe('line block selection', () => {
  it('covers the cursor line including its line break', () => {
    const state = javaState('one\ntwo\nthree\n')
    expect(selectedLineBlocks(state.update({ selection: { anchor: 5 } }).state))
      .toEqual([{ from: 4, to: 8 }])
  })

  it('excludes a line the selection only touches at its start', () => {
    const state = javaState('one\ntwo\nthree\n')
    const selected = state.update({ selection: EditorSelection.single(0, 4) }).state
    expect(selectedLineBlocks(selected)).toEqual([{ from: 0, to: 4 }])
  })

  it('merges overlapping blocks from multiple cursors', () => {
    const state = EditorState.create({
      doc: 'one\ntwo\nthree\n',
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(2),
        EditorSelection.cursor(10),
      ]),
    })
    expect(selectedLineBlocks(state)).toEqual([{ from: 0, to: 4 }, { from: 8, to: 14 }])
  })
})

describe('reformat command', () => {
  const indentedJavaState = (source: string): EditorState => EditorState.create({
    doc: source,
    extensions: [java(), indentUnit.of('    '), EditorState.tabSize.of(4)],
  })

  it('prunes unused imports, tidies whitespace, and re-indents the body', () => {
    const source = [
      'package shane.leetcode.problems.easy;',
      '',
      'import java.util.List;',
      'import java.util.ArrayList;',
      '',
      '',
      '',
      'class Q1 {',
      'int size() {   ',
      'return new ArrayList<Integer>().size();',
      '}',
      '}',
      '',
    ].join('\n')

    const formatted = runEditorCommand(indentedJavaState(source), reformatJavaDocument).doc.toString()

    expect(formatted).toBe([
      'package shane.leetcode.problems.easy;',
      '',
      'import java.util.ArrayList;',
      '',
      'class Q1 {',
      '    int size() {',
      '        return new ArrayList<Integer>().size();',
      '    }',
      '}',
      '',
    ].join('\n'))
  })

  it('leaves an already formatted document unchanged', () => {
    const source = 'package shane.leetcode.problems.easy;\n\nclass Q1 {\n}\n'
    expect(runEditorCommand(indentedJavaState(source), reformatJavaDocument).doc.toString()).toBe(source)
  })
})

describe('Option shortcut matchers', () => {
  const base = { shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }

  it('matches the cut, paste, and shortcut-list forms on their physical keys', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX' })).toBe(true)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV' })).toBe(true)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash' })).toBe(true)
    expect(isLineCutAltShortcut({ ...base, code: 'KeyV' })).toBe(false)
  })

  it('ignores the same keys with extra modifiers', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX', metaKey: true })).toBe(false)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV', shiftKey: true })).toBe(false)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash', ctrlKey: true })).toBe(false)
  })

  it('separates undo from redo by the Shift modifier', () => {
    expect(isUndoAltShortcut({ ...base, code: 'KeyZ' })).toBe(true)
    expect(isUndoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true })).toBe(false)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true })).toBe(true)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ' })).toBe(false)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true, metaKey: true })).toBe(false)
  })

  it('matches reformat on either primary modifier but not on Alt alone', () => {
    expect(isReformatShortcut({ ...base, code: 'KeyL', metaKey: true })).toBe(true)
    expect(isReformatShortcut({ ...base, code: 'KeyL', ctrlKey: true })).toBe(true)
    expect(isReformatShortcut({ ...base, code: 'KeyL' })).toBe(false)
    expect(isReformatShortcut({ ...base, code: 'KeyL', metaKey: true, shiftKey: true })).toBe(false)
  })
})

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

describe('Java auto imports', () => {
  it('adds imports while a declaration is typed character by character', () => {
    const source = 'class Solution {\n    void test() {\n        |\n    }\n}'
    const cursor = source.indexOf('|')
    let state = EditorState.create({
      doc: source.replace('|', ''),
      selection: { anchor: cursor },
      extensions: [java(), javaAutoImports],
    })

    for (const character of 'List<Integer> list = new ArrayList<>();') {
      const head = state.selection.main.head
      state = state.update({
        changes: { from: head, insert: character },
        selection: { anchor: head + character.length },
        userEvent: 'input.type',
      }).state
    }

    expect(state.doc.toString()).toContain('import java.util.ArrayList;\nimport java.util.List;')
    expect(state.doc.toString()).toContain('List<Integer> list = new ArrayList<>();')
  })

  it('imports all known types from a pasted declaration in the same edit', () => {
    const source = `package shane.leetcode.problems.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Solution {
    void test() {
    }
}`
    const insertion = source.indexOf('    }')
    let state = EditorState.create({ doc: source, extensions: [java(), javaAutoImports, history()] })
    state = state.update({
      changes: { from: insertion, insert: '        List<Integer> list = new ArrayList<>();\n' },
      selection: { anchor: insertion + '        List<Integer> list = new ArrayList<>();\n'.length },
      userEvent: 'input.paste',
    }).state

    expect(state.doc.toString()).toContain(
      'import java.util.ArrayList;\nimport java.util.List;\nimport org.junit.jupiter.api.Test;',
    )
    expect(state.doc.toString()).toContain('List<Integer> list = new ArrayList<>();')

    const undone = applyUndo(state)
    expect(undone.handled).toBe(true)
    expect(undone.state.doc.toString()).toBe(source)
  })

  it('imports static type receivers inserted by completion snippets', () => {
    const source = 'class Solution { Object values = |; }'
    const cursor = source.indexOf('|')
    let state = EditorState.create({
      doc: source.replace('|', ''),
      extensions: [java(), javaAutoImports],
    })
    state = state.update({
      changes: { from: cursor, insert: 'List.of()' },
      selection: { anchor: cursor + 'List.of()'.length },
      userEvent: 'input.complete',
    }).state

    expect(state.doc.toString()).toBe(
      'import java.util.List;\n\nclass Solution { Object values = List.of(); }',
    )
  })

  it('ignores comments, literals, fully qualified types, and external import collisions', () => {
    const source = `import example.List;

class Solution {
    String text = "ArrayList";
    // ArrayList ignored;
    java.util.List<Integer> values;
}`
    let state = EditorState.create({ doc: source, extensions: [java(), javaAutoImports] })
    state = state.update({
      changes: { from: source.length, insert: '\n' },
      userEvent: 'input.type',
    }).state

    expect(state.doc.toString()).toBe(`${source}\n`)
  })
})

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

  it('extracts one gutter marker per real test annotation and skips comments, strings, and helpers', () => {
    const source = [
      'class Solution {',
      '    // @Test void fakeComment() {}',
      '    String text = "@Test void fakeString() {}";',
      '    @DisplayName("qualified")',
      '    @org.junit.jupiter.api.Test',
      '    void test_2$() {}',
      '    void helper() {}',
      '    @Test void testInline() {}',
      '    @Test void 테스트() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodMarkers(state)).toEqual([
      {
        methodName: 'test_2$',
        from: source.lastIndexOf('\n', source.indexOf('@org.junit.jupiter.api.Test')) + 1,
        line: 5,
      },
      {
        methodName: 'testInline',
        from: source.lastIndexOf('\n', source.indexOf('@Test void testInline')) + 1,
        line: 8,
      },
      {
        methodName: '테스트',
        from: source.lastIndexOf('\n', source.indexOf('@Test void 테스트')) + 1,
        line: 9,
      },
    ])
  })

  it('recomputes marker positions after document edits and builds sorted gutter ranges', () => {
    const source = [
      'class Solution {',
      '    @Test void first() {}',
      '}',
    ].join('\n')
    const state = javaState(source)
    const inserted = state.update({
      changes: { from: 0, insert: '// heading\n' },
    }).state
    const markers = findJavaTestMethodMarkers(inserted)

    expect(markers).toEqual([{
      methodName: 'first',
      from: inserted.doc.line(3).from,
      line: 3,
    }])
    const gutterMarkers = buildTestRunMarkers(markers, 'Shift+Ctrl+R')
    const cursor = gutterMarkers.iter()
    expect(gutterMarkers.size).toBe(1)
    expect(cursor.from).toBe(markers[0].from)
    expect(cursor.to).toBe(markers[0].from)
    cursor.next()
    expect(cursor.value).toBeNull()
  })

  it('uses the platform-specific selected-test shortcut label', () => {
    expect(testRunShortcutLabel('other')).toBe('Alt+Shift+R')
    expect(testRunShortcutLabel('mac')).toBe('⇧⌘R')
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

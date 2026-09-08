import { closeBrackets, insertBracket } from '@codemirror/autocomplete'
import { moveLineDown, moveLineUp } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { runScopeHandlers, type EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  completeJavaStatement,
  copySelectedText,
  handleJavaIdentifierCallInput,
  javaIdentifierCallKeymap,
  isCompleteStatementAltShortcut,
  isLineEndAltShortcut,
  planJavaStatementCompletion,
  prepareSelectedJavaIdentifierCall,
  reformatJavaDocument,
  moveToJavaLineEnd,
  selectedLineBlocks,
} from '../../../src/editor'
import { runEditorCommand, javaState } from './helpers'

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

describe('clipboard copy command', () => {
  it('copies selected text and joins multiple selections with the document line break', () => {
    const state = EditorState.create({
      doc: 'first\nsecond\nthird',
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.single(0, 5).main,
        EditorSelection.single(6, 12).main,
      ]),
    })
    const copied: string[] = []

    expect(copySelectedText(state, { writeText: async (text) => { copied.push(text) } })).toBe(true)
    expect(copied).toEqual(['first\nsecond'])
  })

  it('copies the current line when there is no selection', () => {
    const state = EditorState.create({ doc: 'first\nsource\nlast', selection: { anchor: 8 } })
    const copied: string[] = []

    expect(copySelectedText(state, { writeText: async (text) => { copied.push(text) } })).toBe(true)
    expect(copied).toEqual(['source\n'])
  })
})

describe('Java method-call parentheses', () => {
  it('handles the physical opening-parenthesis keymap before closeBrackets', () => {
    const source = 'assertThat(firstStableIndex)'
    const from = source.indexOf('firstStableIndex')
    const to = from + 'firstStableIndex'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
      extensions: [java(), closeBrackets(), javaIdentifierCallKeymap],
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    const handled = runScopeHandlers(view, {
      key: '(',
      keyCode: 57,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe('assertThat(firstStableIndex())')
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(to + 1)
  })

  it('handles Shift+9 when the browser reports the digit instead of `(`', () => {
    const source = 'assertThat(firstStableIndex)'
    const from = source.indexOf('firstStableIndex')
    const to = from + 'firstStableIndex'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
      extensions: [java(), closeBrackets(), javaIdentifierCallKeymap],
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    const handled = runScopeHandlers(view, {
      key: '9',
      keyCode: 57,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')

    expect(handled).toBe(true)
    expect(state.doc.toString()).toBe('assertThat(firstStableIndex())')
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(to + 1)
  })

  it('uses the current cursor when completion leaves a stale native input range', () => {
    const source = 'assertThat(firstStableIndex)'
    const from = source.indexOf('firstStableIndex')
    const to = from + 'firstStableIndex'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: to },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    // This is the native range observed in the failure: the editor cursor is
    // after the method name, while the browser still reports its start.
    expect(state.update({ changes: { from, to: from, insert: '(' } }).state.doc.toString())
      .toBe('assertThat((firstStableIndex)')
    expect(handleJavaIdentifierCallInput(view, from, from, '(')).toBe(true)
    expect(state.doc.toString()).toBe('assertThat(firstStableIndex())')
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(to + 1)
  })

  it('handles the real opening-parenthesis input callback for a selected identifier', () => {
    const source = 'assertThat(firstStableIndex)'
    const from = source.indexOf('firstStableIndex')
    const to = from + 'firstStableIndex'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(handleJavaIdentifierCallInput(view, from, to, '(')).toBe(true)
    expect(state.doc.toString()).toBe('assertThat(firstStableIndex())')
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(to + 1)
  })

  it('collapses a selected identifier before closeBrackets inserts the call pair', () => {
    const source = 'assertThat(firstStableIndex)'
    const from = source.indexOf('firstStableIndex')
    const to = from + 'firstStableIndex'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
      extensions: [java(), closeBrackets()],
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(prepareSelectedJavaIdentifierCall(view)).toBe(true)
    expect(state.selection.main.empty).toBe(true)
    expect(state.selection.main.head).toBe(to)
    const bracket = insertBracket(state, '(')
    expect(bracket).not.toBeNull()
    state = bracket!.state

    expect(state.doc.toString()).toBe('assertThat(firstStableIndex())')
    expect(state.selection.main.head).toBe(to + 1)
  })

  it('leaves an explicit non-identifier selection available for normal wrapping', () => {
    const state = EditorState.create({
      doc: 'left + right',
      selection: { anchor: 0, head: 'left + right'.length },
      extensions: [java(), closeBrackets()],
    })
    const view = { state, dispatch: () => {} } as unknown as EditorView
    expect(prepareSelectedJavaIdentifierCall(view)).toBe(false)
    expect(insertBracket(state, '(')?.state.doc.toString()).toBe('(left + right)')
  })

  it('does not intercept a non-identifier input selection', () => {
    const source = 'assertThat(left + right)'
    const from = source.indexOf('left')
    const to = source.indexOf('right') + 'right'.length
    let state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(handleJavaIdentifierCallInput(view, from, to, '(')).toBe(false)
    expect(state.doc.toString()).toBe(source)
    expect(state.selection.main.from).toBe(from)
    expect(state.selection.main.to).toBe(to)
  })
})

describe('line movement commands', () => {
  it('moves a single line and a selected line block without copying content', () => {
    const source = 'one\ntwo\nthree\nfour'
    const single = runEditorCommand(
      EditorState.create({ doc: source, selection: { anchor: source.indexOf('two') } }),
      moveLineUp,
    )
    expect(single.doc.toString()).toBe('two\none\nthree\nfour')

    const blockFrom = source.indexOf('two')
    const blockTo = source.indexOf('four')
    const block = runEditorCommand(
      EditorState.create({ doc: source, selection: EditorSelection.single(blockFrom, blockTo) }),
      moveLineDown,
    )
    expect(block.doc.toString()).toBe('one\nfour\ntwo\nthree')
    expect(block.doc.lines).toBe(4)
  })
})

describe('Complete Current Statement', () => {
  it('adds a missing semicolon without inserting a line break', () => {
    const source = 'class Solution {\n    void solve() {\n        return answer\n    }\n}'
    const position = source.indexOf('return answer') + 'return answer'.length
    const plan = planJavaStatementCompletion(source, position)

    expect(plan?.semicolon).toBe(';')
    expect(plan?.closing).toBe('')
    expect(plan?.cursor).toBe(position + 1)

    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      completeJavaStatement,
    )
    expect(state.doc.toString()).toBe(
      'class Solution {\n    void solve() {\n        return answer;\n    }\n}',
    )
    expect(state.selection.main.head).toBe(position + 1)
  })

  it('does not duplicate an existing semicolon or complete control headers', () => {
    const complete = 'class S {\n    void f() {\n        call();\n    }\n}'
    const completePosition = complete.indexOf('call') + 4
    const completed = runEditorCommand(
      javaState(complete).update({ selection: { anchor: completePosition } }).state,
      completeJavaStatement,
    )
    expect(completed.doc.toString()).toBe(complete)
    expect(completed.selection.main.head).toBe(complete.indexOf('call();') + 'call();'.length)

    const control = 'class S {\n    void f() {\n        if (ready)\n    }\n}'
    expect(planJavaStatementCompletion(control, control.indexOf('ready') + 5)).toBeNull()
    expect(planJavaStatementCompletion('// return value', 8)).toBeNull()
  })

  it('accepts array initializers that end with a closing brace', () => {
    for (const statement of ['int[] xs = {1, 2}', 'return new int[]{1, 2}']) {
      const source = `class S {\n    void f() {\n        ${statement}\n    }\n}`
      const position = source.indexOf(statement) + statement.length
      const state = runEditorCommand(
        javaState(source).update({ selection: { anchor: position } }).state,
        completeJavaStatement,
      )

      expect(state.doc.toString()).toBe(
        `class S {\n    void f() {\n        ${statement};\n    }\n}`,
      )
    }
  })

  it('rejects syntactically incomplete statements instead of adding a semicolon', () => {
    for (const statement of ['foo =', 'foo +', 'int x =', 'return foo +']) {
      const source = `class S {\n    void f() {\n        ${statement}\n    }\n}`
      const position = source.indexOf(statement) + statement.length

      expect(planJavaStatementCompletion(source, position)).toBeNull()

      const state = javaState(source).update({ selection: { anchor: position } }).state
      let dispatched = false
      const view = {
        state,
        dispatch: () => {
          dispatched = true
        },
      } as unknown as EditorView
      expect(completeJavaStatement(view)).toBe(false)
      expect(dispatched).toBe(false)
    }
  })

  it('closes an incomplete call before adding its semicolon', () => {
    const statement = 'assertThat(uniformArray(new int[]{4,6})).isTrue('
    const source = `class S {\n    void f() {\n        ${statement}\n    }\n}`
    const position = source.indexOf(statement) + statement.length
    const plan = planJavaStatementCompletion(source, position)

    expect(plan?.closing).toBe(')')
    expect(plan?.semicolon).toBe(';')

    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      completeJavaStatement,
    )
    const completed = `class S {\n    void f() {\n        ${statement});\n    }\n}`
    expect(state.doc.toString()).toBe(completed)
    expect(state.selection.main.head).toBe(source.indexOf(statement) + `${statement});`.length)
  })

  it('closes an incomplete call before an existing semicolon and leaves the cursor after it', () => {
    const statement = 'assertThat(value).isTrue(;'
    const source = `class S {\n    void f() {\n        ${statement}\n    }\n}`
    const position = source.indexOf(statement) + statement.length - 1
    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      completeJavaStatement,
    )

    expect(state.doc.toString()).toBe(
      `class S {\n    void f() {\n        assertThat(value).isTrue();\n    }\n}`,
    )
    expect(state.selection.main.head).toBe(source.indexOf(statement) + statement.length + 1)
  })

  it('inserts a semicolon before trailing spaces and line comments', () => {
    const source = 'class S {\n    void f() {\n        return answer   // c\n    }\n}'
    const statement = 'return answer'
    const position = source.indexOf(statement) + statement.length
    const plan = planJavaStatementCompletion(source, position)

    expect(plan?.semicolonFrom).toBe(source.indexOf('   // c'))

    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      completeJavaStatement,
    )
    expect(state.doc.toString()).toBe(
      'class S {\n    void f() {\n        return answer;   // c\n    }\n}',
    )
    expect(state.selection.main.head).toBe(source.indexOf(statement) + 'return answer;'.length)
  })

  it('matches only Shift+Option+Enter', () => {
    const shortcut = { code: 'Enter', shiftKey: true, altKey: true, metaKey: false, ctrlKey: false }
    expect(isCompleteStatementAltShortcut(shortcut)).toBe(true)
    expect(isCompleteStatementAltShortcut({ ...shortcut, shiftKey: false })).toBe(false)
    expect(isCompleteStatementAltShortcut({ ...shortcut, code: 'NumpadEnter' })).toBe(false)
    expect(isCompleteStatementAltShortcut({ ...shortcut, metaKey: true })).toBe(false)
  })
})

describe('Move to line end', () => {
  it('moves to the current line end without crossing its newline', () => {
    const source = 'class S {\n    void f() {\n        call();\n        next();\n    }\n}'
    const position = source.indexOf('call') + 2
    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      moveToJavaLineEnd,
    )
    expect(state.selection.main.head).toBe(source.indexOf('call();') + 'call();'.length)
    expect(state.doc.toString()).toBe(source)
  })

  it('indents a whitespace-only Java line when the language can determine it', () => {
    const source = 'class S {\n    void f() {\n\n    }\n}'
    const blank = source.indexOf('\n\n') + 1
    const state = EditorState.create({
      doc: source,
      selection: { anchor: blank },
      extensions: [java(), indentUnit.of('    '), EditorState.tabSize.of(4)],
    })
    const moved = runEditorCommand(state, moveToJavaLineEnd)
    expect(moved.doc.toString()).toBe('class S {\n    void f() {\n        \n    }\n}')
    expect(moved.selection.main.head).toBe(blank + 8)
  })

  it('matches only the plain Option+Right Arrow form', () => {
    const shortcut = { code: 'ArrowRight', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }
    expect(isLineEndAltShortcut(shortcut)).toBe(true)
    expect(isLineEndAltShortcut({ ...shortcut, code: 'ArrowLeft' })).toBe(false)
    expect(isLineEndAltShortcut({ ...shortcut, shiftKey: true })).toBe(false)
    expect(isLineEndAltShortcut({ ...shortcut, ctrlKey: true })).toBe(false)
  })
})

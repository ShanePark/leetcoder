import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cutSelectionOrLine } from '../../../src/editor/editing'
import {
  copySelectedText,
  reformatJavaDocument,
  selectedLineBlocks,
} from '../../../src/editor'
import { mutableEditorView, runEditorCommand, javaState } from './helpers'

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

describe('clipboard cut command', () => {
  it('copies and removes the selected range', () => {
    const source = 'alpha beta\ngamma'
    const state = EditorState.create({
      doc: source,
      selection: EditorSelection.single(6, 10),
    })
    const editor = mutableEditorView(state)
    const copied: string[] = []

    expect(cutSelectionOrLine(editor.view, { writeText: async (text) => { copied.push(text) } })).toBe(true)
    expect(copied).toEqual(['beta'])
    expect(editor.state().doc.toString()).toBe('alpha \ngamma')
  })

  it('joins and removes multiple selected ranges', () => {
    const source = 'first\nsecond\nthird'
    const state = EditorState.create({
      doc: source,
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([
        EditorSelection.single(0, 5).main,
        EditorSelection.single(13, 18).main,
      ]),
    })
    const editor = mutableEditorView(state)
    const copied: string[] = []

    expect(cutSelectionOrLine(editor.view, { writeText: async (text) => { copied.push(text) } })).toBe(true)
    expect(copied).toEqual(['first\nthird'])
    expect(editor.state().doc.toString()).toBe('\nsecond\n')
  })

  it('copies and removes the current line when nothing is selected', () => {
    const state = EditorState.create({ doc: 'first\nsecond\nthird', selection: { anchor: 8 } })
    const editor = mutableEditorView(state)
    const copied: string[] = []

    expect(cutSelectionOrLine(editor.view, { writeText: async (text) => { copied.push(text) } })).toBe(true)
    expect(copied).toEqual(['second\n'])
    expect(editor.state().doc.toString()).toBe('first\nthird')
  })
})

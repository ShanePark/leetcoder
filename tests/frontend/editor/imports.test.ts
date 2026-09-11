import { history } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { javaAutoImports } from '../../../src/editor'
import { applyUndo } from './helpers'

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

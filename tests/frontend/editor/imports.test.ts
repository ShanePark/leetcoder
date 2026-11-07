import { history } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { javaAutoImports } from '../../../src/editor'
import { psLibraryExtension, setPsLibraryMetadata } from '../../../src/completions/library'
import { applyUndo } from './helpers'

describe('Java auto imports', () => {
  it('imports Ps only when the project metadata exposes its methods', () => {
    const source = 'class Solution { Object values = ; }'
    const cursor = source.indexOf(';')
    const base = EditorState.create({ doc: source, extensions: [java(), javaAutoImports, psLibraryExtension] })
    const available = base.update({ effects: setPsLibraryMetadata.of({
      fingerprint: 'fixture',
      methods: [{ name: 'parse', returnType: 'java.lang.Object', parameters: [] }],
    }) }).state
    const unavailable = available.update({ effects: setPsLibraryMetadata.of(null) }).state
    const insert = (state: EditorState) => state.update({
      changes: { from: cursor, insert: 'Ps.parse()' },
      userEvent: 'input.complete',
    }).state.doc.toString()

    expect(insert(base)).not.toContain('import io.github.shanepark.Ps;')
    expect(insert(available)).toContain('import io.github.shanepark.Ps;')
    expect(insert(unavailable)).not.toContain('import io.github.shanepark.Ps;')
  })

  it.each([
    ['TreeNode', 'TreeNode.of(1, 2)', 'io.github.shanepark.leetcode.TreeNode'],
    ['TreeNode', 'new TreeNode(1)', 'io.github.shanepark.leetcode.TreeNode'],
    ['ListNode', 'ListNode.of(1, 2)', 'io.github.shanepark.leetcode.ListNode'],
  ])('imports %s from %s only when the helper library is available', (_type, code, qualified) => {
    const source = 'class Solution { Object values = ; }'
    const cursor = source.indexOf(';')
    const base = EditorState.create({ doc: source, extensions: [java(), javaAutoImports, psLibraryExtension] })
    const available = base.update({ effects: setPsLibraryMetadata.of({
      fingerprint: 'fixture',
      methods: [{ name: 'parse', returnType: 'java.lang.Object', parameters: [] }],
    }) }).state
    const insert = (state: EditorState) => state.update({
      changes: { from: cursor, insert: code },
      userEvent: 'input.complete',
    }).state.doc.toString()

    expect(insert(base)).not.toContain(`import ${qualified};`)
    expect(insert(available)).toContain(`import ${qualified};`)
  })

  describe.each(['ListNode', 'TreeNode'])('a file declaring its own %s', (type) => {
    it.each([
      ['a nested class', (name: string) => `class Solution { static class ${name} {} Object values = ; }`],
      ['a top-level class', (name: string) => `class ${name} {}\nclass Solution { Object values = ; }`],
      ['a record', (name: string) => `class Solution { record ${name}(int val) {} Object values = ; }`],
      ['an interface', (name: string) => `class Solution { interface ${name} {} Object values = ; }`],
    ])('does not import the helper over %s', (_label, source) => {
      const doc = source(type)
      const state = EditorState.create({ doc, extensions: [java(), javaAutoImports, psLibraryExtension] })
        .update({ effects: setPsLibraryMetadata.of({
          fingerprint: 'fixture',
          methods: [{ name: 'parse', returnType: 'java.lang.Object', parameters: [] }],
        }) }).state
      for (const code of [`new ${type}()`, `${type}.of(1)`]) {
        const updated = state.update({
          changes: { from: doc.indexOf(' = ;') + 3, insert: code },
          userEvent: 'input.complete',
        }).state.doc.toString()
        expect(updated).toContain(code)
        expect(updated).not.toContain('import ')
      }
    })
  })

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

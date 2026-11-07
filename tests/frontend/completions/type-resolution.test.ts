import { describe, expect, it } from 'vitest'

import { collectJavaSymbols } from '../../../src/completions/source'
import { resolveJavaReceiverTypes } from '../../../src/completions/type-resolution'

function resolve(sourceWithCursor: string, receiver: string, assertJ = false) {
  const cursor = sourceWithCursor.indexOf('|')
  const source = `${sourceWithCursor.slice(0, cursor)}${sourceWithCursor.slice(cursor + 1)}`
  return resolveJavaReceiverTypes(source, receiver, cursor, collectJavaSymbols(source, cursor), assertJ)
}

describe('Java receiver type resolution', () => {
  it.each([
    'import java.util.Stack; class Solution { void test() { Stack<StringBuilder> stack = new Stack(); stack.| } }',
    'class Solution { void test() { Stack stack = new Stack(); stack.| } }',
  ])('resolves generic and raw Stack receivers without querying inherited catalog groups', (source) => {
    expect(resolve(source, 'stack')).toEqual({
      kind: 'metadata',
      typeNames: ['java.util.Stack'],
      isStatic: false,
    })
  })

  it('keeps the declared interface and concrete initializer types', () => {
    const result = resolve(
      'import java.util.*; class Solution { void test() { List<Integer> values = new ArrayList<>(); values.| } }',
      'values',
    )
    expect(result.typeNames).toEqual(['java.util.List', 'java.util.ArrayList'])
  })

  it('uses explicit and wildcard imports for project types', () => {
    expect(resolve(
      'import org.example.Widget;\nclass Solution { Widget value; void test() { value.| } }',
      'value',
    ).typeNames).toEqual(['org.example.Widget'])
    expect(resolve(
      'import org.example.*;\nclass Solution { void test() { Widget.| } }',
      'Widget',
    ).typeNames).toEqual(['org.example.Widget'])
  })

  it('uses java.lang metadata for implicit types outside the small built-in alias map', () => {
    expect(resolve(
      'class Solution { void test() { Thread thread; thread.| } }',
      'thread',
    ).typeNames).toEqual(['java.lang.Thread'])
  })

  it('does not treat a shadowing local variable as a static type', () => {
    expect(resolve(
      'class Solution { void test() { Object Stack = null; Stack.| } }',
      'Stack',
    )).toMatchObject({ kind: 'metadata', typeNames: ['java.lang.Object'], isStatic: false })
  })

  describe.each(['ListNode', 'TreeNode'])('the helper-library name %s', (type) => {
    const helper = `io.github.shanepark.leetcode.${type}`

    it.each([
      ['nested', (name: string) => `package example;\nclass Solution { static class ${name} { int val; } ${name} node; void test() { node.| } }`],
      ['top-level', (name: string) => `package example;\nclass ${name} { int val; }\nclass Solution { ${name} node; void test() { node.| } }`],
    ])('keeps a %s declaration in the file on its own package', (_label, source) => {
      expect(resolve(source(type), 'node')).toEqual({
        kind: 'metadata',
        typeNames: [`example.${type}`],
        isStatic: false,
      })
    })

    it('keeps a declaration in the file for a static receiver', () => {
      expect(resolve(`package example;\nclass ${type} {}\nclass Solution { void test() { ${type}.| } }`, type)).toEqual({
        kind: 'metadata',
        typeNames: [`example.${type}`],
        isStatic: true,
      })
    })

    it('resolves as a project type when nothing imports the helper', () => {
      expect(resolve(`package example;\nclass Solution { ${type} node; void test() { node.| } }`, 'node').typeNames)
        .toEqual([`example.${type}`])
      expect(resolve(`class Solution { ${type} node; void test() { node.| } }`, 'node').typeNames)
        .toEqual([`java.lang.${type}`])
      expect(resolve(`import org.example.*;\nclass Solution { ${type} node; void test() { node.| } }`, 'node').typeNames)
        .toEqual([`org.example.${type}`])
    })

    it('resolves to the helper once the file imports it', () => {
      expect(resolve(`import ${helper};\nclass Solution { ${type} node; void test() { node.| } }`, 'node').typeNames)
        .toEqual([helper])
      expect(resolve(`import io.github.shanepark.leetcode.*;\nclass Solution { ${type} node; void test() { node.| } }`, 'node').typeNames)
        .toEqual([helper])
    })
  })

  it('leaves the resolution of Ps as it was', () => {
    expect(resolve('class Solution { void test() { Ps.| } }', 'Ps')).toEqual({ kind: 'legacy', typeNames: [], isStatic: true })
    expect(resolve('class Solution { Ps value; void test() { value.| } }', 'value').typeNames).toEqual(['io.github.shanepark.Ps'])
  })

  it('does not send unresolved value chains to the metadata inspector', () => {
    expect(resolve('class Solution { void test() { Object value; value.child.| } }', 'value.child').kind).toBe('unresolved')
    expect(resolve('class Solution { void test() { Object System; System.out.| } }', 'System.out').kind).toBe('unresolved')
  })

  it('leaves source members, AssertJ, Ps, and array receivers on their existing paths', () => {
    expect(resolve('class Solution { void test() { this.| } }', 'this').kind).toBe('legacy')
    expect(resolve('class Solution { void test() { assertThat(value).| } }', 'assertThat(value)', true).kind).toBe('legacy')
    expect(resolve('class Solution { void test() { Ps.| } }', 'Ps').kind).toBe('legacy')
    expect(resolve('class Solution { void test() { int[] values; values.| } }', 'values').kind).toBe('legacy')
  })
})

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { CompletionContext } from '@codemirror/autocomplete'

import { collectJavaMethods, collectJavaSymbols, javaCompletions } from '../../src/completions'

function complete(source: string, explicit = false) {
  const marker = source.indexOf('|')
  const cursor = marker >= 0 ? marker : source.length
  const document = marker >= 0 ? `${source.slice(0, marker)}${source.slice(marker + 1)}` : source
  const state = EditorState.create({ doc: document })
  const context = {
    state,
    pos: cursor,
    explicit,
    matchBefore(pattern: RegExp) {
      const before = document.slice(0, cursor)
      const match = pattern.exec(before)
      if (!match) return null
      return { from: cursor - match[0].length, to: cursor, text: match[0] }
    },
  } as unknown as CompletionContext
  return javaCompletions(context)
}

function labels(source: string, explicit = false): string[] {
  return complete(source, explicit)?.options.map((option) => option.label) ?? []
}

describe('lightweight Java completions', () => {
  it('offers methods from the declared interface and the new implementation', () => {
    const options = labels('class Solution { void solve() { List<Integer> l = new ArrayList<>(); l.| } }')
    expect(options).toContain('size()')
    expect(options).toContain('get(index)')
    expect(options).toContain('add(element)')
    expect(options).toContain('isEmpty()')
  })

  it('infers var, multiline declarations, arrays, and static utility classes', () => {
    const source = `class Solution {
      void solve() {
        var values = new ArrayList<Integer>();
        int[] nums = new int[3];
        values.|
      }
    }`
    expect(labels(source)).toContain('size()')
    expect(labels(source.replace('values.|', 'nums.|'))).toContain('length')
    expect(labels('class Solution { void solve() { Arrays.| } }')).toContain('copyOf(original, newLength)')
    expect(labels('class Solution { void solve() { Math.| } }')).toContain('max(a, b)')
    expect(labels('class Solution { void solve() { Character.| } }')).toContain('isDigit(ch)')
  })

  it('uses parameters, fields, local shadowing, and current methods', () => {
    const source = `class Solution {
      List<Integer> values;
      void solve(List<String> values) {
        values.|
      }
      int helper(int index) { return index; }
    }`
    const symbols = collectJavaSymbols(source, source.indexOf('values.') + 7)
    expect(symbols.filter((symbol) => symbol.name === 'values')).toHaveLength(2)
    expect(labels(source.replace('values.|', 'values;'), true)).toContain('helper(index)')
    expect(labels(source.slice(0, source.indexOf('values.') + 'values.'.length))).toContain('get(index)')
  })

  it('supports AssertJ chains and unknown receivers with useful fallback methods', () => {
    expect(labels('class Solution { void test() { assertThat(values).| } }')).toContain('isEqualTo(expected)')
    expect(labels('class Solution { void test() { unknown.| } }')).toContain('toString()')
    expect(labels('class Solution { void test() { unknown.| } }')).not.toContain('size()')
  })

  it('keeps arrays and primitive receivers narrow', () => {
    const arrayOptions = labels('class Solution { void test() { int[] nums = new int[3]; nums.| } }')
    expect(arrayOptions).toEqual(expect.arrayContaining(['length', 'clone()']))
    expect(arrayOptions).not.toContain('size()')
    expect(arrayOptions).not.toContain('toString()')

    const primitiveOptions = labels('class Solution { void test() { int count = 0; count.| } }')
    expect(primitiveOptions).toContain('toString()')
    expect(primitiveOptions).not.toContain('size()')
    expect(primitiveOptions).not.toContain('get(index)')
  })

  it('separates static factories/utilities from instance methods', () => {
    const listStatic = labels('class Solution { void test() { List.| } }')
    expect(listStatic).toContain('of()')
    expect(listStatic).not.toContain('add(element)')
    expect(listStatic).not.toContain('get(index)')

    const implementationStatic = labels('class Solution { void test() { ArrayList.| } }')
    expect(implementationStatic).not.toContain('add(element)')
    expect(implementationStatic).not.toContain('get(index)')

    const integerStatic = labels('class Solution { void test() { Integer.| } }')
    expect(integerStatic).toContain('parseInt(value)')
    expect(integerStatic).toContain('valueOf(value)')
    expect(integerStatic).not.toContain('intValue()')
  })

  it('shows fields declared later and methods from this.', () => {
    const source = `class Solution {
      void test() { this.| }
      List<Integer> later;
      int helper(int value) { return value; }
    }`
    const options = labels(source)
    expect(options).toContain('later')
    expect(options).toContain('helper(value)')
  })

  it('returns Java keywords, variables, and methods for explicit Ctrl+Space', () => {
    const source = 'class Solution { int answer; int helper(int value) { return value; } void test() { } }'
    const options = labels(source, true)
    expect(options).toContain('answer')
    expect(options).toContain('helper(value)')
    expect(options).toContain('return')
    expect(options).toContain('ArrayList')
  })

  it('extracts method names without treating control-flow blocks as methods', () => {
    const methods = collectJavaMethods('class Solution { int helper(int value) { if (value > 0) { return value; } return 0; } }')
    expect(methods.map((method) => method.name)).toEqual(['helper'])
  })
})

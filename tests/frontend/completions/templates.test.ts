import { EditorState } from '@codemirror/state'
import { java } from '@codemirror/lang-java'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { collectJavaSymbols, javaIterableCandidates } from '../../../src/completions'
import { expandJavaTestTemplate } from '../../../src/completions/templates'
import { labels, applyCompletion, expandPrintTemplateState, expandPrintTemplate } from './helpers'

function expandTestTemplate(source: string): { expanded: boolean, state: EditorState } {
  const marker = source.indexOf('|')
  if (marker < 0) throw new Error('Expansion source must include a | cursor marker')
  let state = EditorState.create({
    doc: `${source.slice(0, marker)}${source.slice(marker + 1)}`,
    extensions: [java()],
    selection: { anchor: marker },
  })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    },
  }
  return { expanded: expandJavaTestTemplate(view as unknown as EditorView), state }
}

describe('lightweight Java completions', () => {
it('expands the test live template at a class declaration', () => {
    const result = expandTestTemplate(`class Solution {
  test|
}`)

    expect(result.expanded).toBe(true)
    expect(result.state.doc.toString()).toBe(`import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Solution {
  @Test
  public void () {
    assertThat()
  }
}`)
    expect(result.state.selection.main.empty).toBe(true)
    expect(result.state.selection.main.head).toBe(result.state.doc.toString().indexOf('()'))
  })

it('reuses existing test imports without duplicating them', () => {
    const result = expandTestTemplate(`import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Solution {
  test|
}`)

    expect(result.expanded).toBe(true)
    expect(result.state.doc.toString()).toBe(`import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Solution {
  @Test
  public void () {
    assertThat()
  }
}`)
  })

it('adds the assertion static import beside unrelated static imports', () => {
    const result = expandTestTemplate(`import java.util.List;

import static java.util.Collections.emptyList;

class Solution {
  test|
}`)

    expect(result.expanded).toBe(true)
    expect(result.state.doc.toString()).toContain('import org.junit.jupiter.api.Test;')
    expect(result.state.doc.toString()).toContain('import static org.assertj.core.api.Assertions.assertThat;')
    expect(result.state.doc.toString()).toContain('import static java.util.Collections.emptyList;')
  })

it('only expands test in a Java declaration context', () => {
    for (const source of [
      'class Solution { void helper() { test| } }',
      'class Solution { String text = "test|"; }',
      'class Solution { // test|\n}',
    ]) {
      const result = expandTestTemplate(source)
      expect(result.expanded).toBe(false)
      expect(result.state.doc.toString()).toBe(source.replace('|', ''))
    }
  })

it('offers the print live-template abbreviations', () => {
    const options = labels('class Solution { void test() { sout| } }')
    expect(options).toEqual(expect.arrayContaining(['sout', 'soutv']))
    expect(labels('class Solution { void test() { serr| } }')).toEqual(
      expect.arrayContaining(['serr', 'serrv']),
    )
  })

it('offers the test live template as a completion', () => {
    expect(labels('class Solution {\n  test|\n}')).toContain('test')
  })

it('expands print templates with a nearby variable and keeps linked fields', () => {
    const source = `class Solution {
  void test(int[] nums) {
    int last = nums.length - 1;
    soutv|
  }
}`
    expect(applyCompletion(source, 'soutv')).toBe(`class Solution {
  void test(int[] nums) {
    int last = nums.length - 1;
    System.out.println("last = " + last);
  }
}`)
    expect(applyCompletion(source, 'serrv')).toBe(`class Solution {
  void test(int[] nums) {
    int last = nums.length - 1;
    System.err.println("last = " + last);
  }
}`)
    expect(applyCompletion(source, 'sout')).toBe(`class Solution {
  void test(int[] nums) {
    int last = nums.length - 1;
    System.out.println();
  }
}`)
    expect(applyCompletion(source, 'serr')).toBe(`class Solution {
  void test(int[] nums) {
    int last = nums.length - 1;
    System.err.println();
  }
}`)
  })

it('expands the mod live template to the common modulo constant', () => {
    const source = `class Solution {
  void test() {
    mod|
  }
}`
    expect(labels(source)).toContain('mod')
    expect(applyCompletion(source, 'mod')).toBe(`class Solution {
  void test() {
    final int MOD = (int) 1e9 + 7;
  }
}`)

    const direct = expandPrintTemplate(source)
    expect(direct.expanded).toBe(true)
    expect(direct.source).toBe(`class Solution {
  void test() {
    final int MOD = (int) 1e9 + 7;
  }
}`)
  })

it('expands iter with an inferred element type and singular variable name', () => {
    const source = `class Solution {
  void test(List<Integer> nums) {
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'nums', elementType: 'Integer', variableName: 'num' },
    ])
    expect(labels(source)).toContain('iter')
    expect(applyCompletion(source, 'iter')).toBe([
      'class Solution {',
      '  void test(List<Integer> nums) {',
      '    for (Integer num : nums) {',
      ' '.repeat(8),
      '    }',
      '  }',
      '}',
    ].join('\n'))
  })

it('selects the iterated expression first and derives char from String.toCharArray()', () => {
    const result = expandPrintTemplateState(`class Solution {
  void test(String s, List<Integer> list) {
    iter|
  }
}`)
    expect(result.expanded).toBe(true)
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe('list')

    const updated = result.state.update(result.state.replaceSelection('s.toCharArray()')).state
    expect(updated.doc.toString()).toContain('for (char integer : s.toCharArray())')
    expect(updated.selection.main.head).toBe(
      updated.doc.toString().indexOf('s.toCharArray()') + 's.toCharArray()'.length,
    )
  })

it('keeps the target active while typing a String.toCharArray() expression', () => {
    const result = expandPrintTemplateState(`class Solution {
  void test(String s, List<Integer> list) {
    iter|
  }
}`)
    let state = result.state.update(result.state.replaceSelection('s')).state
    for (const character of '.toCharArray()') {
      const head = state.selection.main.head
      state = state.update({
        changes: { from: head, insert: character },
        selection: { anchor: head + character.length },
        userEvent: 'input.type',
      }).state
    }

    expect(state.doc.toString()).toContain('for (char integer : s.toCharArray())')
    expect(state.selection.main.head).toBe(
      state.doc.toString().indexOf('s.toCharArray()') + 's.toCharArray()'.length,
    )
  })

it('offers separate iter choices and recomputes type and variable defaults', () => {
    const source = `class Solution {
  void test(List<Integer> nums, String[] names, Map<String, Integer> counts) {
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'names', elementType: 'String', variableName: 'name' },
      { name: 'nums', elementType: 'Integer', variableName: 'num' },
    ])
    expect(labels(source)).toEqual(expect.arrayContaining(['iter (names)', 'iter (nums)']))
    expect(applyCompletion(source, 'iter (names)')).toContain('for (String name : names)')
    expect(applyCompletion(source, 'iter (nums)')).toContain('for (Integer num : nums)')
    expect(applyCompletion(source, 'iter (names)')).not.toContain('for (Map<String, Integer>')
  })

it('uses an editable var fallback when no iterable is visible', () => {
    const result = expandPrintTemplate(`class Solution {
  void test() {
    iter|
  }
}`)
    expect(result.expanded).toBe(true)
    expect(result.source).toBe([
      'class Solution {',
      '  void test() {',
      '    for (var item : items) {',
      ' '.repeat(8),
      '    }',
      '  }',
      '}',
    ].join('\n'))
  })

it('keeps iter candidates scoped and honors local shadowing', () => {
    const source = `class Solution {
  List<Integer> values;
  void test(List<String> values) {
    List<Long> ids = new ArrayList<>();
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'ids', elementType: 'Long', variableName: 'id' },
      { name: 'values', elementType: 'String', variableName: 'value' },
    ])
  })

it('infers collection and array element types from common Java declaration forms', () => {
    const source = `class Solution {
  void test(Collection<String> names, int values[], int[][] matrix) {
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'matrix', elementType: 'int[]', variableName: 'row' },
      { name: 'values', elementType: 'int', variableName: 'value' },
      { name: 'names', elementType: 'String', variableName: 'name' },
    ])
  })

it('recognizes a fully-qualified generic iterable declaration', () => {
    const source = `class Solution {
  void test(java.util.List<String> names) {
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'names', elementType: 'String', variableName: 'name' },
    ])
  })

it('keeps explicit declaration types authoritative over iterable initializers', () => {
    const source = `class Solution {
  void test() {
    List values = new ArrayList<String>();
    Object other = new ArrayList<String>();
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'values', variableName: 'value' },
    ])
  })

it('retains array suffixes before the loop variable name', () => {
    const source = `class Solution {
  void test(int[] values) {
    for (int[] arr = values; arr != null; arr = null) {
      iter|
    }
  }
}`
    const position = source.indexOf('|')
    const document = source.replace('|', '')
    expect(collectJavaSymbols(document, position).find((symbol) => symbol.name === 'arr')).toMatchObject({
      declaredType: 'int[]',
      elementType: 'int',
    })
    expect(javaIterableCandidates(document, position)).toEqual([
      { name: 'arr', elementType: 'int', variableName: 'item' },
      { name: 'values', elementType: 'int', variableName: 'value' },
    ])
  })

it('keeps spacing in nested wildcard element types', () => {
    const source = `class Solution {
  void test(List<List<? extends Number>> groups) {
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'groups', elementType: 'List<? extends Number>', variableName: 'group' },
    ])
    expect(applyCompletion(source, 'iter')).toContain('for (List<? extends Number> group : groups)')
  })

it('ignores iterable-looking declarations inside comments and literals', () => {
    const source = `class Solution {
  List<Integer> values;
  void test() {
    String text = "List<String> values;";
    // List<Double> values;
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'values', elementType: 'Integer', variableName: 'value' },
    ])
    expect(expandPrintTemplate(`class Solution {
  void test() {
    String text = "iter|";
  }
}`).expanded).toBe(false)
  })

it('infers var initializers for generic collections and nested arrays', () => {
    const source = `class Solution {
  void test() {
    var values = new ArrayList<Integer>();
    var matrix = new int[2][3];
    iter|
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'matrix', elementType: 'int[]', variableName: 'row' },
      { name: 'values', elementType: 'Integer', variableName: 'value' },
    ])
  })

it('avoids an enhanced-for variable already active in the loop body', () => {
    const source = `class Solution {
  void test(List<Integer> nums) {
    for (Integer num : nums) {
      iter|
    }
  }
}`
    expect(javaIterableCandidates(source.replace('|', ''), source.indexOf('|'))).toEqual([
      { name: 'nums', elementType: 'Integer', variableName: 'num2' },
    ])
    expect(applyCompletion(source, 'iter')).toContain('for (Integer num2 : nums)')
  })

it('uses an editable value placeholder when no variable is in scope', () => {
    expect(applyCompletion('class Solution { void test() { soutv| } }', 'soutv')).toBe(
      'class Solution { void test() { System.out.println("value = " + value); } }',
    )
  })

it('does not duplicate a semicolon already following the abbreviation', () => {
    expect(applyCompletion('class Solution { void test() { sout|; } }', 'sout')).toBe(
      'class Solution { void test() { System.out.println(); } }',
    )
  })

it('expands an indented abbreviation directly on Tab', () => {
    const result = expandPrintTemplate(`class Solution {
  void test(int[] nums) {
    soutv|
  }
}`)
    expect(result.expanded).toBe(true)
    expect(result.source).toBe(`class Solution {
  void test(int[] nums) {
    System.out.println("nums = " + nums);
  }
}`)
  })

it('keeps the variable name and expression linked while editing the snippet field', () => {
    const result = expandPrintTemplateState(`class Solution {
  void test(int[] nums) {
    soutv|
  }
}`)
    expect(result.expanded).toBe(true)
    const field = result.state.selection.main
    expect(result.state.sliceDoc(field.from, field.to)).toBe('nums')
    expect(result.state.selection.ranges).toHaveLength(2)
    const updated = result.state.update(result.state.replaceSelection('values')).state
    expect(updated.doc.toString()).toContain('System.out.println("values = " + values);')
  })

it('does not expand inside a larger identifier', () => {
    const result = expandPrintTemplate('class Solution { void test() { sout|t } }')
    expect(result.expanded).toBe(false)
    expect(result.source).toBe('class Solution { void test() { soutt } }')
  })

it('keeps direct expansion out of comments, literals, and property expressions', () => {
    for (const source of [
      'class Solution { void test() { // sout|\n } }',
      'class Solution { void test() { String value = "sout|"; } }',
      'class Solution { void test() { object.sout| } }',
    ]) {
      const result = expandPrintTemplate(source)
      expect(result.expanded).toBe(false)
      expect(result.source).toBe(source.replace('|', ''))
    }
  })

it('does not expand unknown dotted chains into collection methods', () => {
    const options = labels('class Solution { void test() { unknown.chain.| } }')
    expect(options).toContain('toString()')
    expect(options).not.toContain('size()')
    expect(options).not.toContain('println(value)')
  })
})

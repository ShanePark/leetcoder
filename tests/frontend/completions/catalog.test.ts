import { describe, expect, it } from 'vitest'
import { collectJavaSymbols } from '../../../src/completions'
import { complete, labels, applyCompletion } from './helpers'

describe('lightweight Java completions', () => {
it('adds a specific import after the package when a Java type completion is picked', () => {
    const source = 'package example;\n\nclass Solution { Li| value; }'
    expect(applyCompletion(source, 'List')).toBe(
      'package example;\n\nimport java.util.List;\n\nclass Solution { List value; }',
    )
  })

it('sorts multiple auto-imports and does not duplicate exact or wildcard imports', () => {
    const withList = applyCompletion(
      'package example;\n\nimport java.util.List;\n\nclass Solution { Arr| value; }',
      'ArrayList',
    )
    expect(withList).toContain('import java.util.ArrayList;\nimport java.util.List;')

    expect(applyCompletion(
      'import java.util.List;\n\nclass Solution { Li| value; }',
      'List',
    ).match(/import java\.util\.List;/g)).toHaveLength(1)

    expect(applyCompletion(
      'import java.util.*;\n\nclass Solution { Li| value; }',
      'List',
    )).toBe('import java.util.*;\n\nclass Solution { List value; }')
  })

it('keeps static imports in a separate group', () => {
    expect(applyCompletion(
      'package example;\n\nimport static org.assertj.core.api.Assertions.assertThat;\n\nclass Solution { Li| value; }',
      'List',
    )).toBe(
      'package example;\n\nimport java.util.List;\n\nimport static org.assertj.core.api.Assertions.assertThat;\n\nclass Solution { List value; }',
    )
  })

it('does not import over a type declared in the same source file', () => {
    expect(applyCompletion(
      'class List {}\nclass Solution { Li| value; }',
      'List',
    )).toBe('class List {}\nclass Solution { List value; }')
  })

it('does not add an import when a completion is applied inside a literal', () => {
    expect(applyCompletion(
      'class Solution { String value = "Li|"; }',
      'List',
    )).toBe('class Solution { String value = "List"; }')
  })

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

it('completes System fields and static utilities', () => {
    const system = labels('class Solution { void test() { System.| } }')
    expect(system).toEqual(expect.arrayContaining(['out', 'err', 'in', 'currentTimeMillis()', 'nanoTime()', 'arraycopy(source, sourcePosition, destination, destinationPosition, length)']))
    expect(system).not.toContain('println(value)')

    const explicit = labels('class Solution { void test() { Sys| } }')
    expect(explicit).toContain('System')
  })

it('completes PrintStream methods for System.out and System.err chains', () => {
    const stdout = labels('class Solution { void test() { System.out.| } }')
    expect(stdout).toEqual(expect.arrayContaining([
      'print()', 'print(value)', 'println()', 'println(value)', 'printf(format, args)',
      'format(format, args)', 'append(value)', 'flush()', 'close()', 'checkError()',
    ]))
    expect(stdout).not.toContain('currentTimeMillis()')

    const stderr = labels('class Solution { void test() { System.err.| } }')
    expect(stderr).toContain('println(value)')

    const input = labels('class Solution { void test() { System.in.| } }')
    expect(input).toContain('read()')
  })

it('keeps the completion range for a typed dotted receiver and adds print snippets', () => {
    const source = 'class Solution { void test() { System.out.pr| } }'
    const result = complete(source)
    expect(result?.from).toBe(source.indexOf('|') - 2)
    expect(result?.options.map((option) => option.label)).toContain('println(value)')

    const topLevel = labels('class Solution { void test() { sout| } }')
    expect(topLevel).toContain('sout')
    expect(topLevel).toContain('serr')
  })
})

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { CompletionContext } from '@codemirror/autocomplete'
import { collectJavaSymbols, javaCompletions, psLibraryExtension, setPsLibraryMetadata } from '../../../src/completions'
import type { PsLibraryMetadata } from '../../../src/completions'
import { complete, labels, applyCompletion } from './helpers'

const psV1: PsLibraryMetadata = {
  fingerprint: 'ps-v1',
  methods: [
    { name: 'strList', returnType: 'java.util.List<java.util.List<java.lang.String>>', parameters: [{ name: 'input', typeName: 'java.lang.String' }] },
    { name: 'intList', returnType: 'java.util.List<java.util.List<java.lang.Integer>>', parameters: [{ name: null, typeName: 'java.lang.String' }] },
    { name: 'intArray', returnType: 'int[][]', parameters: [{ name: null, typeName: 'int[]' }] },
    { name: 'flag', returnType: 'boolean', parameters: [{ name: null, typeName: 'boolean' }] },
  ],
}

function completeWithPs(source: string, metadata: PsLibraryMetadata | null = psV1) {
  const marker = source.indexOf('|')
  const cursor = marker >= 0 ? marker : source.length
  const document = marker >= 0 ? `${source.slice(0, marker)}${source.slice(marker + 1)}` : source
  let state = EditorState.create({ doc: document, extensions: [psLibraryExtension] })
  if (metadata) state = state.update({ effects: setPsLibraryMetadata.of(metadata) }).state
  const context = {
    state,
    pos: cursor,
    explicit: false,
    matchBefore(pattern: RegExp) {
      const before = document.slice(0, cursor)
      const anchoredPattern = new RegExp(`(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ''))
      const match = anchoredPattern.exec(before)
      if (!match) return null
      return { from: cursor - match[0].length, to: cursor, text: match[0] }
    },
  } as unknown as CompletionContext
  return { state, result: javaCompletions(context), cursor, document }
}

function psLabels(source: string, metadata: PsLibraryMetadata | null = psV1): string[] {
  return completeWithPs(source, metadata).result?.options.map((option) => option.label) ?? []
}

function applyPsCompletion(source: string, label: string, metadata: PsLibraryMetadata = psV1): string {
  const { state: initialState, result, cursor } = completeWithPs(source, metadata)
  if (!result) throw new Error('No completion result')
  const completion = result.options.find((option) => option.label === label)
  if (!completion) throw new Error(`Completion not found: ${label}`)
  let state = initialState
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    },
  } as unknown as import('@codemirror/view').EditorView
  if (typeof completion.apply === 'function') completion.apply(view, completion, result.from, cursor)
  else state = state.update({ changes: { from: result.from, to: cursor, insert: completion.apply ?? completion.label } }).state
  return state.doc.toString()
}

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

it('uses project Ps metadata for type and method completions, including return types and snippets', () => {
    const source = 'package example;\n\nclass Solution { Ps| value; }'
    expect(applyPsCompletion(source, 'Ps')).toBe(
      'package example;\n\nimport io.github.shanepark.Ps;\n\nclass Solution { Ps value; }',
    )

    const imported = 'import io.github.shanepark.Ps;\nclass Solution { void test() { Ps.| } }'
    expect(psLabels(imported)).toEqual(expect.arrayContaining([
      'strList(java.lang.String input)',
      'intList(java.lang.String value)',
      'intArray(int[] array)',
      'flag(boolean condition)',
    ]))
    expect(psLabels(imported)).not.toContain('toString()')

    const typed = 'import io.github.shanepark.Ps;\nclass Solution { void test() { Ps.intL| } }'
    const result = completeWithPs(typed)
    expect(result.result?.from).toBe(typed.indexOf('|') - 'intL'.length)
    const option = result.result?.options.find((item) => item.label === 'intList(java.lang.String value)')
    expect(option?.detail).toBe('java.util.List<java.util.List<java.lang.Integer>>')
    expect(applyPsCompletion(typed, 'intList(java.lang.String value)')).toContain('Ps.intList(value)')
    expect(applyPsCompletion(typed.replace('intL|', 'flag|'), 'flag(boolean condition)')).toContain('Ps.flag(condition)')
  })

it('does not suggest Ps when the project metadata is missing or has no public methods', () => {
    expect(psLabels('class Solution { Ps| value; }', null)).not.toContain('Ps')
    expect(psLabels('class Solution { void test() { Ps.| } }', null)).toEqual([])

    const emptyMetadata: PsLibraryMetadata = { fingerprint: 'empty', methods: [] }
    expect(psLabels('class Solution { Ps| value; }', emptyMetadata)).not.toContain('Ps')
    expect(psLabels('class Solution { void test() { Ps.| } }', emptyMetadata)).toEqual([])

    expect(psLabels('class Solution { void test() { intL| } }')).not.toContain('intList(java.lang.String value)')
  })

it('deduplicates Ps type imports and does not expose static helpers without a static import', () => {
    expect(applyPsCompletion(
      'import io.github.shanepark.Ps;\nclass Solution { Ps| value; }',
      'Ps',
    )).toBe('import io.github.shanepark.Ps;\nclass Solution { Ps value; }')
    expect(applyPsCompletion(
      'import io.github.shanepark.*;\nclass Solution { Ps| value; }',
      'Ps',
    )).toBe('import io.github.shanepark.*;\nclass Solution { Ps value; }')
    expect(psLabels('class Solution { void test() { intL| } }')).not.toContain('intList(java.lang.String value)')
  })

it('reflects added, removed, and overloaded Ps methods when the project version changes', () => {
    const source = 'import io.github.shanepark.Ps;\nclass Solution { void test() { Ps.| } }'
    const versionOne: PsLibraryMetadata = {
      fingerprint: 'ps-v1',
      methods: [
        { name: 'convert', returnType: 'java.lang.String', parameters: [{ name: 'input', typeName: 'java.lang.String' }] },
        { name: 'removed', returnType: 'void', parameters: [] },
      ],
    }
    const versionTwo: PsLibraryMetadata = {
      fingerprint: 'ps-v2',
      methods: [
        { name: 'convert', returnType: 'java.lang.String', parameters: [{ name: 'input', typeName: 'java.lang.String' }] },
        { name: 'convert', returnType: 'java.lang.String', parameters: [{ name: 'input', typeName: 'int' }] },
        { name: 'added', returnType: 'java.lang.String', parameters: [{ name: null, typeName: 'java.lang.String' }] },
      ],
    }
    const labelsV1 = psLabels(source, versionOne)
    const labelsV2 = psLabels(source, versionTwo)
    expect(labelsV1).toContain('convert(java.lang.String input)')
    expect(labelsV1).toContain('removed()')
    expect(labelsV2).toEqual(expect.arrayContaining([
      'convert(java.lang.String input)', 'convert(int input)', 'added(java.lang.String value)',
    ]))
    expect(labelsV2).not.toContain('removed()')
  })

it('offers dynamic Ps methods through exact and wildcard static imports only', () => {
    const exactImport = psLabels(
      'import static io.github.shanepark.Ps.intList;\nclass Solution { void test() { intL| } }',
    )
    expect(exactImport).toContain('intList(java.lang.String value)')
    expect(exactImport).not.toContain('strList(java.lang.String input)')

    const wildcardImport = psLabels(
      'import static io.github.shanepark.Ps.*;\nclass Solution { void test() { intL| } }',
    )
    expect(wildcardImport).toEqual(expect.arrayContaining([
      'intList(java.lang.String value)', 'intArray(int[] array)', 'flag(boolean condition)',
    ]))
    expect(applyPsCompletion(
      'import static io.github.shanepark.Ps.intList;\nclass Solution { void test() { intL|; } }',
      'intList(java.lang.String value)',
    )).toContain('intList(value);')
    expect(psLabels(`/*
      import static io.github.shanepark.Ps.*;
    */
    class Solution { void test() { intL| } }`)).not.toContain('intList(java.lang.String value)')
  })

it('keeps a local Ps variable ahead of the dynamic static type catalog', () => {
    const options = psLabels('class Solution { void test() { Object Ps = null; Ps.| } }')
    expect(options).toContain('toString()')
    expect(options).not.toContain('intList(java.lang.String value)')
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

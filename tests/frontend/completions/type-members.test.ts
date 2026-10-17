import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

import type { JavaTypeMembersMetadata } from '../../../src/backend'
import { createJavaMemberCompletionSource } from '../../../src/completions'

function request(sourceWithCursor: string) {
  const cursor = sourceWithCursor.indexOf('|')
  const document = `${sourceWithCursor.slice(0, cursor)}${sourceWithCursor.slice(cursor + 1)}`
  const state = EditorState.create({ doc: document })
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
  return { context, state, cursor, document }
}

async function complete(
  sourceWithCursor: string,
  metadata: JavaTypeMembersMetadata | (() => Promise<JavaTypeMembersMetadata>),
) {
  const input = request(sourceWithCursor)
  const inspect = vi.fn(async () => typeof metadata === 'function' ? metadata() : metadata)
  const result = await createJavaMemberCompletionSource(inspect)(input.context) as CompletionResult | null
  return { ...input, inspect, result }
}

function applyState(result: CompletionResult, state: EditorState, cursor: number, label: string): EditorState {
  const completion = result.options.find((option) => option.label === label)
  if (!completion) throw new Error(`Completion not found: ${label}`)
  let nextState = state
  const view = {
    get state() { return nextState },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      nextState = nextState.update(spec).state
    },
  } as unknown as EditorView
  if (typeof completion.apply === 'function') completion.apply(view, completion, result.from, cursor)
  else nextState = nextState.update({ changes: { from: result.from, to: cursor, insert: completion.apply ?? completion.label } }).state
  return nextState
}

function apply(result: CompletionResult, state: EditorState, cursor: number, label: string): string {
  return applyState(result, state, cursor, label).doc.toString()
}

const stackMetadata: JavaTypeMembersMetadata = {
  fingerprint: 'jdk-test',
  types: [{
    typeName: 'java.util.Stack',
    available: true,
    methods: [
      { name: 'push', returnType: 'E', parameters: [{ name: null, typeName: 'E' }], isStatic: false },
      { name: 'parallelStream', returnType: 'java.util.stream.Stream<E>', parameters: [], isStatic: false },
    ],
    fields: [],
  }],
}

const integerMetadata: JavaTypeMembersMetadata = {
  fingerprint: 'jdk-test',
  types: [{
    typeName: 'java.lang.Integer',
    available: true,
    methods: [
      { name: 'valueOf', returnType: 'java.lang.Integer', parameters: [{ name: null, typeName: 'java.lang.String' }], isStatic: true },
      { name: 'intValue', returnType: 'int', parameters: [], isStatic: false },
    ],
    fields: [{ name: 'MAX_VALUE', typeName: 'int', isStatic: true }],
  }],
}

const streamMetadata: JavaTypeMembersMetadata = {
  fingerprint: 'jdk-streams',
  types: [
    {
      typeName: 'java.util.Arrays', available: true, fields: [],
      methods: ['T', 'double', 'int', 'long'].flatMap((element) => [false, true].map((range) => ({
        name: 'stream', isStatic: true,
        returnType: element === 'T' ? 'java.util.stream.Stream<T>'
          : `java.util.stream.${element[0].toUpperCase()}${element.slice(1)}Stream`,
        parameters: [{ name: null, typeName: `${element}[]` },
          ...(range ? [{ name: null, typeName: 'int' }, { name: null, typeName: 'int' }] : [])],
      }))),
    },
    ...['IntStream', 'LongStream', 'DoubleStream', 'Stream'].map((name) => ({
      typeName: `java.util.stream.${name}`, available: true, fields: [],
      methods: [
        { name: 'sorted', returnType: `java.util.stream.${name}`, parameters: [], isStatic: false },
        { name: 'filter', returnType: `java.util.stream.${name}`, parameters: [{ name: null, typeName: 'java.util.function.Predicate<T>' }], isStatic: false },
        { name: 'map', returnType: `java.util.stream.${name}<R>`, parameters: [{ name: null, typeName: 'java.util.function.Function<T, R>' }], isStatic: false },
        { name: 'parallel', returnType: 'S', parameters: [], isStatic: false },
        { name: 'collect', returnType: 'R', parameters: [
          { name: null, typeName: 'java.util.function.Supplier<R>' },
          { name: null, typeName: 'java.util.function.BiConsumer<R, T>' },
          { name: null, typeName: 'java.util.function.BiConsumer<R, R>' },
        ], isStatic: false },
        { name: 'mapToInt', returnType: 'java.util.stream.IntStream', parameters: [{ name: null, typeName: 'java.util.function.ToIntFunction<T>' }], isStatic: false },
        ...(name !== 'Stream' ? [{ name: 'boxed', returnType: 'java.util.stream.Stream<java.lang.Integer>', parameters: [], isStatic: false }] : [
          { name: 'toList', returnType: 'java.util.List<T>', parameters: [], isStatic: false },
          { name: 'sorted', returnType: 'java.util.stream.Stream<T>', parameters: [{ name: null, typeName: 'java.util.Comparator<? super T>' }], isStatic: false },
          { name: 'collect', returnType: 'R', parameters: [{ name: null, typeName: 'java.util.stream.Collector<? super T, A, R>' }], isStatic: false },
        ]),
        { name: 'of', returnType: `java.util.stream.${name}`, parameters: [{ name: null, typeName: `${name === 'Stream' ? 'T' : name.replace('Stream', '').toLowerCase()}...` }], isStatic: true },
      ],
    })),
    {
      typeName: 'java.util.List', available: true, fields: [],
      methods: [{ name: 'stream', returnType: 'java.util.stream.Stream<E>', parameters: [], isStatic: false }],
    },
    {
      typeName: 'java.lang.String', available: true, fields: [],
      methods: [{ name: 'chars', returnType: 'java.util.stream.IntStream', parameters: [], isStatic: false }],
    },
    {
      typeName: 'java.util.stream.Collectors', available: true, fields: [],
      methods: ['toList', 'toUnmodifiableList', 'toCollection', 'toSet', 'toUnmodifiableSet'].map((name) => ({
        name, returnType: 'java.util.stream.Collector<T, ?, R>', isStatic: true,
        parameters: name === 'toCollection' ? [{ name: null, typeName: 'java.util.function.Supplier<C>' }] : [],
      })),
    },
  ],
}

describe('metadata-backed Java member completions', () => {
  it.each([
    'package example;\nimport java.util.Stack;\nclass Solution { void test() { Stack<StringBuilder> stack = new Stack(); stack.p| } }',
    'class Solution { void test() { Stack stack = new Stack(); stack.p| } }',
  ])('completes push and inherited members on generic and raw Stack values', async (source) => {
    const result = await complete(source, stackMetadata)
    expect(result.inspect).toHaveBeenCalledExactlyOnceWith(['java.util.Stack'])
    expect(result.result?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      'push(element)', 'parallelStream()',
    ]))
    expect(result.result).not.toBeNull()
    expect(apply(result.result!, result.state, result.cursor, 'push(element)')).toContain('stack.push(element)')
  })

  it('filters static and instance members according to the receiver', async () => {
    const staticResult = await complete('Integer.|', integerMetadata)
    expect(staticResult.result?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      'valueOf(value)', 'MAX_VALUE',
    ]))
    expect(staticResult.result?.options.map((option) => option.label)).not.toContain('intValue()')

    const instanceResult = await complete('class Solution { void test() { Integer value; value.| } }', integerMetadata)
    expect(instanceResult.result?.options.map((option) => option.label)).toContain('intValue()')
    expect(instanceResult.result?.options.map((option) => option.label)).not.toContain('valueOf(value)')
    expect(instanceResult.result?.options.map((option) => option.label)).not.toContain('MAX_VALUE')
  })

  it('does not use handwritten catalogs for unavailable or empty metadata', async () => {
    const source = 'class Solution { void test() { List.| } }'
    const unavailable = await complete(source, {
      fingerprint: 'missing',
      types: [{
        typeName: 'java.util.List', available: false,
        methods: [{ name: 'of', returnType: 'java.util.List', parameters: [], isStatic: true }],
        fields: [],
      }],
    })
    expect(unavailable.result?.options).toEqual([])

    const empty = await complete(source, {
      fingerprint: 'empty',
      types: [{ typeName: 'java.util.List', available: true, methods: [], fields: [] }],
    })
    expect(empty.result?.options).toEqual([])
  })

  it('ignores unrelated types returned in the same metadata batch', async () => {
    const result = await complete('class Solution { void test() { Stack stack; stack.| } }', {
      fingerprint: 'mixed',
      types: [
        ...stackMetadata.types,
        {
          typeName: 'java.util.List', available: true,
          methods: [{ name: 'clear', returnType: 'void', parameters: [], isStatic: false }],
          fields: [],
        },
      ],
    })
    expect(result.result?.options.map((option) => option.label)).not.toContain('clear()')
  })

  it('does not offer Stack-only members on ordinary collections', async () => {
    const result = await complete('class Solution { void test() { List<String> values; values.p| } }', {
      fingerprint: 'list',
      types: [{
        typeName: 'java.util.List',
        available: true,
        methods: [{ name: 'parallelStream', returnType: 'java.util.stream.Stream<E>', parameters: [], isStatic: false }],
        fields: [],
      }],
    })
    expect(result.inspect).toHaveBeenCalledExactlyOnceWith(['java.util.List'])
    expect(result.result?.options.map((option) => option.label)).not.toContain('push(element)')
  })

  it('returns no library candidates when metadata inspection fails', async () => {
    const result = await complete('Stack.|', async () => { throw new Error('inspection failed') })
    expect(result.result?.options).toEqual([])
  })

  it.each([
    ['int', 'IntStream'], ['long', 'LongStream'], ['double', 'DoubleStream'], ['String', 'Stream'],
  ])('resolves the matching Arrays.stream overload for %s arrays', async (element, streamType) => {
    const completed = await complete(`class Solution { void solve(${element}[] nums) { Arrays.stream(nums)\n.bo| } }`, streamMetadata)
    const labels = completed.result?.options.map((option) => option.label)
    expect(labels).toContain('sorted()')
    expect(labels?.includes('boxed()')).toBe(element !== 'String')
    expect(completed.inspect.mock.calls).toEqual([[['java.util.Arrays']], [[`java.util.stream.${streamType}`]]])
    expect(completed.result?.from).toBe(completed.cursor - 2)
    if (element !== 'String') expect(apply(completed.result!, completed.state, completed.cursor, 'boxed()')).toContain('.boxed()')
  })

  it('follows boxed, sorted, filter, and map calls across lines and lambda blocks', async () => {
    const completed = await complete(`class Solution {
      void solve(int[] nums) {
        Arrays /* array source */ .stream(nums, 0, nums.length)
          .filter(value -> { String text = "}),"; return value > 0; })
          .boxed()
          .sorted((left, right) -> right.compareTo(left))
          .map(value -> value.toString())
          .toL|
      }
    }`, streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toContain('toList()')
    expect(completed.result?.options.map((option) => option.label)).not.toContain('boxed()')
    expect(completed.result?.options.map((option) => option.label)).not.toContain('of(items)')
    expect(completed.inspect.mock.calls).toEqual([
      [['java.util.Arrays']], [['java.util.stream.IntStream']], [['java.util.stream.Stream']],
    ])
  })

  it('follows collection streams and primitive mapping', async () => {
    const completed = await complete('class Solution { void solve(List<String> values) { values.stream().mapToInt(String::length).bo| } }', streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toContain('boxed()')
    expect(completed.inspect.mock.calls).toEqual([
      [['java.util.List']], [['java.util.stream.Stream']], [['java.util.stream.IntStream']],
    ])
  })

  it.each([
    'class Solution { void solve() { Arrays.stream(new int[]{1, 2}).bo| } }',
    'class Solution { void solve(int[][] matrix) { Arrays.stream(matrix[0]).bo| } }',
  ])('selects primitive streams for array expressions: %s', async (source) => {
    const completed = await complete(source, streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toContain('boxed()')
    expect(completed.inspect.mock.calls).toEqual([[['java.util.Arrays']], [['java.util.stream.IntStream']]])
  })

  it.each([
    ['import java.util.stream.IntStream;\nclass Solution { void solve(int[] nums) { IntStream.of(nums).bo| } }', 'boxed()'],
    ['import java.util.stream.IntStream;\nclass Solution { void solve() { IntStream.of(1, 2).bo| } }', 'boxed()'],
    ['import java.util.stream.DoubleStream;\nclass Solution { void solve() { DoubleStream.of(1, 2).bo| } }', 'boxed()'],
    ['import java.util.stream.Stream;\nclass Solution { void solve(String[] values) { Stream.of(values).toL| } }', 'toList()'],
    ['class Solution { void solve() { "hello".chars().bo| } }', 'boxed()'],
  ])('resolves stream factories and literal receivers: %s', async (source, label) => {
    const completed = await complete(source, streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toContain(label)
  })

  it.each([
    'import java.util.stream.IntStream;\nclass Solution { void solve(IntStream stream) { stream.so| } }',
    'class Solution { void solve(int[] nums) { var stream = Arrays.stream(nums); stream.so| } }',
    'class Solution { void solve(int[] nums) { (Arrays.stream(nums)).parallel().so| } }',
  ])('resolves declared, inferred, and parenthesized stream receivers: %s', async (source) => {
    const completed = await complete(source, streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toContain('sorted()')
    expect(completed.result?.options.map((option) => option.label)).toContain('boxed()')
  })

  it.each([
    'class Solution { void solve(boolean[] nums) { Arrays.stream(nums).bo| } }',
    'class Solution { void solve(int[] nums) { Arrays.stream(nums).missing().bo| } }',
    'class Solution { void solve(int[] nums) { Arrays.stream(nums).of(1).bo| } }',
  ])('does not fabricate members for invalid overloads or calls', async (source) => {
    const completed = await complete(source, streamMetadata)
    expect(completed.result?.options).toEqual([])
  })

  it.each([
    ['import static org.assertj.core.api.Assertions.assertThat;\n', ''],
    ['class Previous { void test() { assertThat(1).isEqualTo(1); } }\n', ''],
    ['// assertThat(previous).isEqualTo(expected);\n', ''],
    ['', 'assertThat(nums).isNotNull();'],
  ])('does not reuse earlier assertion context for a Stream pipeline: %s %s', async (prefix, previous) => {
    const completed = await complete(`${prefix}class Solution {
      void solve(int[] nums) {
        ${previous}
        List<Integer> list = Arrays.stream(nums)
          .|
      }
    }`, streamMetadata)
    const labels = completed.result?.options.map((option) => option.label)
    expect(labels).toContain('boxed()')
    expect(labels).toContain('sorted()')
    expect(labels).not.toContain('as(description)')
    expect(labels).not.toContain('contains(values)')
    expect(completed.inspect.mock.calls).toEqual([[['java.util.Arrays']], [['java.util.stream.IntStream']]])
  })

  it.each([
    'assertThat(nums).|',
    'assertThat(nums)\n .as("message; })")\n .|',
    'Assertions.assertThat(nums).extracting(value -> { return value; }).|',
  ])('preserves assertion completion for the current balanced receiver: %s', async (chain) => {
    const completed = await complete(`class Solution { void solve(int[] nums) { ${chain} } }`, streamMetadata)
    const labels = completed.result?.options.map((option) => option.label)
    expect(labels).toContain('as(description)')
    expect(labels).toContain('contains(values)')
    expect(labels).not.toContain('boxed()')
    expect(completed.inspect).not.toHaveBeenCalled()
  })

  it('offers ready-to-use collectors alongside readable raw collect overloads in full assertion context', async () => {
    const completed = await complete(`import static org.assertj.core.api.Assertions.assertThat;
      class Solution {
        void test() { assertThat(solve(new int[]{1, 2})).isEqualTo(List.of(1, 2)); }
        List<Integer> solve(int[] nums) {
          List<Integer> list = Arrays.stream(nums).boxed()
            .sorted((left, right) -> { return right.compareTo(left); })
            .coll|
        }
      }`, streamMetadata)
    expect(completed.result?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      'collect(Collectors.toList())', 'collect(Collectors.toUnmodifiableList())',
      'collect(Collectors.toCollection(ArrayList::new))', 'collect(Collectors.toSet())',
      'collect(Collectors.toUnmodifiableSet())', 'collect(collector)', 'collect(supplier, accumulator, combiner)',
    ]))
    expect(completed.inspect).toHaveBeenLastCalledWith(['java.util.stream.Collectors'])
    const applied = apply(completed.result!, completed.state, completed.cursor, 'collect(Collectors.toList())')
    expect(applied).toContain('import java.util.stream.Collectors;')
    expect(applied).toContain('.collect(Collectors.toList())')
  })

  it.each(['List', 'Set'])('ranks %s collectors first and uses a compatible collection supplier', async (target) => {
    const completed = await complete(`class Solution { void solve(String[] names) {
      ${target}<String> result = Arrays.stream(names).coll|
    } }`, streamMetadata)
    const collectors = completed.result!.options.filter((option) => option.label.startsWith('collect(Collectors.'))
    const ordered = [...collectors].sort((left, right) => (right.boost ?? 0) - (left.boost ?? 0))
    expect(ordered[0].label).toBe(`collect(Collectors.to${target}())`)
    const collection = target === 'Set' ? 'HashSet' : 'ArrayList'
    const label = `collect(Collectors.toCollection(${collection}::new))`
    const applied = apply(completed.result!, completed.state, completed.cursor, label)
    expect(applied).toContain(`import java.util.${collection};`)
    expect(applied).toContain('import java.util.stream.Collectors;')
    expect(applied).toContain(`.collect(Collectors.toCollection(${collection}::new))`)
    const appliedState = applyState(completed.result!, completed.state, completed.cursor, label)
    expect(appliedState.sliceDoc(appliedState.selection.main.from, appliedState.selection.main.to)).toBe(`${collection}::new`)
  })

  it.each([
    'import java.util.stream.Collectors;\n',
    'import java.util.stream.*;\n',
  ])('reuses existing Collectors imports: %s', async (prefix) => {
    const completed = await complete(`${prefix}class Solution { void solve(String[] names) { Arrays.stream(names).coll| } }`, streamMetadata)
    const applied = apply(completed.result!, completed.state, completed.cursor, 'collect(Collectors.toList())')
    expect(applied.match(/import java\.util\.stream\.(?:Collectors|\*);/g)).toHaveLength(1)
  })

  it.each([
    ['import example.Collectors;\n', ''],
    ['class Collectors {}\n', ''],
    ['', 'Object Collectors = null;'],
  ])('qualifies conflicting collector names instead of adding an invalid import: %s %s', async (prefix, local) => {
    const completed = await complete(`${prefix}class Solution { void solve(String[] names) { ${local} Arrays.stream(names).coll| } }`, streamMetadata)
    const applied = apply(completed.result!, completed.state, completed.cursor, 'collect(Collectors.toList())')
    expect(applied).toContain('.collect(java.util.stream.Collectors.toList())')
    expect(applied).not.toContain('import java.util.stream.Collectors;')
  })

  it.each([
    'class Solution { void solve(int[] nums) { Arrays.stream(nums).coll| } }',
    'class Solution { void solve(String[] names) { Arrays.stream(names).| } }',
    'import java.util.stream.Stream;\nclass Solution { void solve() { Stream.coll| } }',
    'class Solution { void solve(String[] names) { assertThat(names).coll| } }',
  ])('does not offer collector recipes outside object-stream collect prefixes: %s', async (source) => {
    const completed = await complete(source, streamMetadata)
    expect(completed.result?.options.some((option) => option.label.startsWith('collect(Collectors.'))).toBe(false)
    expect(completed.inspect.mock.calls.flat(2)).not.toContain('java.util.stream.Collectors')
  })

  it('keeps raw collect methods when Collectors metadata is unavailable', async () => {
    const completed = await complete('class Solution { void solve(String[] names) { Arrays.stream(names).coll| } }', {
      ...streamMetadata,
      types: streamMetadata.types.filter((type) => type.typeName !== 'java.util.stream.Collectors'),
    })
    expect(completed.result?.options.map((option) => option.label)).toContain('collect(collector)')
    expect(completed.result?.options.some((option) => option.label.startsWith('collect(Collectors.'))).toBe(false)
  })

  it('keeps all raw Stream methods when optional Collectors inspection fails', async () => {
    let inspections = 0
    const completed = await complete('class Solution { void solve(String[] names) { Arrays.stream(names).coll| } }', async () => {
      if (++inspections === 3) throw new Error('Collectors inspection failed')
      return streamMetadata
    })
    expect(completed.result?.options.map((option) => option.label)).toEqual(expect.arrayContaining([
      'collect(collector)', 'collect(supplier, accumulator, combiner)', 'sorted()',
    ]))
  })

  it('refreshes cached Stream options when typing enters or leaves a collect prefix', async () => {
    const source = 'class Solution { void solve(String[] names) { Arrays.stream(names).| } }'
    const empty = await complete(source, streamMetadata)
    const typed = await complete(source.replace('.|', '.c|'), streamMetadata)
    const emptyValid = empty.result!.validFor
    const typedValid = typed.result!.validFor
    if (typeof emptyValid !== 'function' || typeof typedValid !== 'function') throw new Error('Expected dynamic validity predicate')
    expect(emptyValid('c', empty.result!.from, empty.cursor + 1, typed.state)).toBe(false)
    expect(emptyValid('b', empty.result!.from, empty.cursor + 1, typed.state)).toBe(true)
    expect(typedValid('coll', typed.result!.from, typed.cursor + 3, typed.state)).toBe(true)
    expect(typedValid('', typed.result!.from, typed.cursor - 1, typed.state)).toBe(false)
    expect(typedValid('sorted', typed.result!.from, typed.cursor + 5, typed.state)).toBe(false)
  })

  it('preserves unrelated custom collect parameter suggestions', async () => {
    const completed = await complete('import example.Widget;\nclass Solution { void solve(Widget value) { value.coll| } }', {
      fingerprint: 'custom',
      types: [{ typeName: 'example.Widget', available: true, fields: [], methods: [{
        name: 'collect', returnType: 'void', isStatic: false,
        parameters: [1, 2, 3].map(() => ({ name: null, typeName: 'int' })),
      }] }],
    })
    expect(completed.result?.options.map((option) => option.label)).toEqual(['collect(number, number2, number3)'])
  })
})

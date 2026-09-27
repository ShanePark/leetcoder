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

function apply(result: CompletionResult, state: EditorState, cursor: number, label: string): string {
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
  return nextState.doc.toString()
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
})

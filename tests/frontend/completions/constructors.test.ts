import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { applyCompletion, complete, labels } from './helpers'

/** Options in popup order for an empty prefix: boost first, then label. */
function ranked(source: string): string[] {
  const options = complete(source, true)?.options ?? []
  return [...options]
    .sort((left, right) => (right.boost ?? 0) - (left.boost ?? 0) || left.label.localeCompare(right.label))
    .map((option) => option.label)
}

function boosted(source: string): string[] {
  const options = complete(source, true)?.options ?? []
  return [...options]
    .filter((option) => (option.boost ?? 0) > 0)
    .sort((left, right) => (right.boost ?? 0) - (left.boost ?? 0))
    .map((option) => option.label)
}

function applyWithCursor(source: string, label: string): { text: string, cursor: number } {
  const marker = source.indexOf('|')
  const result = complete(source, true)!
  const completion = result.options.find((option) => option.label === label)!
  let state = EditorState.create({ doc: `${source.slice(0, marker)}${source.slice(marker + 1)}` })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state },
  } as unknown as EditorView
  if (typeof completion.apply !== 'function') throw new Error(`Expected an apply function for ${label}`)
  completion.apply(view, completion, result.from, marker)
  return { text: state.doc.toString(), cursor: state.selection.main.head }
}

function method(body: string): string {
  return `class Solution {\n    int solve(int[] nums) {\n        int answer = 0;\n        ${body}\n        return answer;\n    }\n}`
}

describe('completions after new', () => {
  it('offers only instantiable types, ranking implementations of the declared type first', () => {
    const source = method('List<Integer> list = new |')
    const options = labels(source, true)

    expect(ranked(source).slice(0, 3)).toEqual(['ArrayList<>', 'LinkedList<>', 'Stack<>'])
    expect(options).toContain('HashMap<>')
    expect(options).toContain('StringBuilder')
    expect(options).toContain('int')
    for (const unwanted of ['abstract', 'assert', 'answer', 'nums', 'solve(nums)', 'Arrays', 'Collections', 'Math',
      'List', 'Map', 'Comparator', 'System', 'assertThat(...).isEqualTo(...)', 'new ArrayList<>()', 'sout']) {
      expect(options).not.toContain(unwanted)
    }
  })

  it('ranks common implementations for collection interfaces', () => {
    expect(boosted(method('Map<String, Integer> counts = new |'))).toEqual(['HashMap<>', 'TreeMap<>', 'LinkedHashMap<>'])
    expect(boosted(method('Set<Integer> seen = new |'))).toEqual(['HashSet<>', 'TreeSet<>', 'LinkedHashSet<>'])
    expect(boosted(method('Deque<int[]> queue = new |'))).toEqual(['ArrayDeque<>', 'LinkedList<>'])
    expect(boosted(method('Queue<Integer> queue = new |'))).toEqual(['ArrayDeque<>', 'LinkedList<>', 'PriorityQueue<>'])
    expect(boosted(method('PriorityQueue<int[]> heap = new |'))).toEqual(['PriorityQueue<>'])
    expect(boosted(method('ArrayList<Integer> values = new |'))).toEqual(['ArrayList<>'])
    expect(boosted(method('java.util.List<Integer> values = new |'))[0]).toBe('ArrayList<>')
  })

  it('filters by a typed prefix', () => {
    const source = method('List<Integer> list = new Ar|')
    const result = complete(source)
    expect(result?.from).toBe(source.indexOf('Ar|'))
    expect(ranked(source)[0]).toBe('ArrayList<>')
    expect(labels(source)).not.toContain('Arrays')
  })

  it('uses field, assignment, and return types', () => {
    expect(boosted('class Solution {\n    private final Map<Integer, List<Integer>> graph = new |\n}')[0]).toBe('HashMap<>')
    expect(boosted(method('Set<String> words;\n        words = new |'))[0]).toBe('HashSet<>')
    expect(boosted('class Solution {\n    List<List<Integer>> solve() {\n        if (true) {\n            return new |\n        }\n    }\n}')[0])
      .toBe('ArrayList<>')
  })

  it('offers declared classes and the declared array type', () => {
    const source = 'class Solution {\n    static class Node { }\n    abstract class Shape { }\n    void solve() {\n        Node node = new |\n    }\n}'
    expect(ranked(source)[0]).toBe('Node')
    expect(labels(source, true)).not.toContain('Shape')
    expect(boosted(method('TreeNode root = new |'))).toEqual(['TreeNode'])
    expect(boosted(method('int[][] grid = new |'))).toEqual(['int[][]'])
  })

  it('does not offer anything special without an expected type or outside code', () => {
    expect(boosted(method('var list = new |'))).toEqual([])
    expect(labels(method('var list = new |'), true)).toContain('ArrayList<>')
    expect(labels(method('String text = "new |"'), true)).toContain('abstract')
    expect(complete(method('String text = "new |"'))).toBeNull()
  })

  it('infers the expected type after a condition or annotation', () => {
    expect(boosted(method('List<Integer> list = null;\n        if (answer == Integer.MAX_VALUE) list = new |'))[0])
      .toBe('ArrayList<>')
    expect(boosted(method('int[] dp = null;\n        if (Foo) dp = new |'))).toEqual(['int[]'])
    expect(boosted(method('@SuppressWarnings("unchecked") List<Integer>[] g = new |'))).toEqual(['List[]'])
    expect(boosted(method('@Deprecated Set<Integer> seen = new |'))[0]).toBe('HashSet<>')
    for (const body of [
      'List<Integer> list = null;\n        if (map.get(Key) == null) list = new |',
      'if (answer == Integer.MAX_VALUE) Foo = new |',
    ]) {
      expect(labels(method(body), true).every((label) => /^[\w$]+(?:<>)?(?:\[\])*$/.test(label))).toBe(true)
    }
  })

  it('offers wrapper types for array creation without inserting a constructor call', () => {
    const source = method('list.toArray(new Int|')
    expect(labels(source)).toContain('Integer')
    for (const boxed of ['Long', 'Character', 'Double', 'Boolean']) expect(labels(method('foo(new |'), true)).toContain(boxed)
    const { text, cursor } = applyWithCursor(source, 'Integer')
    expect(text).toContain('list.toArray(new Integer')
    expect(text).not.toContain('Integer(')
    expect(text.slice(0, cursor).endsWith('new Integer')).toBe(true)
    expect(boosted(method('List<Integer> list = new |'))).not.toContain('Integer')
  })

  it('does not offer a qualified expected type without its qualifier', () => {
    const options = labels(method('Map.Entry<Integer, Integer> entry = new |'), true)
    expect(options).not.toContain('Entry<>')
    expect(options).not.toContain('Entry')
  })

  it('does not rank by the enclosing method type for a return inside a lambda', () => {
    expect(boosted('class Solution {\n    List<Integer> f() {\n        Comparator<int[]> c = (a, b) -> {\n            return new |\n        };\n    }\n}'))
      .toEqual([])
  })

  it('ignores constructor references', () => {
    expect(complete(method('Supplier<List<Integer>> s = ArrayList::new |'))).toBeNull()
  })

  it('opens the constructor list while typing the space after new', () => {
    const source = method('List<Integer> list = new |')
    const result = complete(source)
    expect(result?.from).toBe(source.indexOf('|'))
    expect(labels(source)).toEqual(labels(source, true))
    expect(complete(method('List<Integer> list = |'))).toBeNull()
  })

  it('inserts the diamond with the cursor inside the parentheses and imports the type', () => {
    const source = `import java.util.List;\n\n${method('List<Integer> list = new Arr|')}`
    const { text, cursor } = applyWithCursor(source, 'ArrayList<>')
    expect(text).toContain('import java.util.ArrayList;\nimport java.util.List;')
    expect(text).toContain('List<Integer> list = new ArrayList<>()')
    expect(text.slice(0, cursor).endsWith('new ArrayList<>(')).toBe(true)
    expect(applyCompletion(method('StringBuilder builder = new Str|'), 'StringBuilder')).toContain('new StringBuilder()')
    const array = applyWithCursor(method('int[] counts = new i|'), 'int[]')
    expect(array.text).toContain('int[] counts = new int[]')
    expect(array.text.slice(0, array.cursor).endsWith('new int[')).toBe(true)
  })
})

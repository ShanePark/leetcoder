import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function apply(source: string, position = source.indexOf('node =')): string {
  const result = planJavaFieldInlining(source, position)
  if ('reason' in result) throw new Error(result.reason)
  return [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function run(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-object-creation-'))
  try {
    const file = join(directory, 'Solution.java')
    writeFileSync(file, source)
    try { execFileSync('javac', ['-d', directory, file], { stdio: 'pipe' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return execFileSync('java', ['-cp', directory, 'Solution'], { encoding: 'utf8' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

const members = 'static class Node { Node(int i, char c) {} Node(String label) {} } static class Box<T> { Box(T t) {} } int next() { return 0; }'
const wrap = (body: string, extra = ''): string =>
  `class Solution { ${members} ${extra} Object f(int n, int i, char c, String s, Node[] nodes, int[] a, java.util.List<Node> list, boolean flag) { ${body} return null; } }`

describe('Inline a class instance creation into the next statement', () => {
  const loop = `class Solution {
  static class Node { Node(int i, char c) {} }
  void f(int n, String s, Node[] nodes) {
    for (int i = 0; i < n; i++) {
      Node node = new Node(i, s.charAt(i));
      nodes[i] = node;
    }
  }
}`

  it('moves the creation into an array store and removes the declaration line', () => {
    expect(apply(loop)).toBe(loop.replace('      Node node = new Node(i, s.charAt(i));\n', '').replace('nodes[i] = node;', 'nodes[i] = new Node(i, s.charAt(i));'))
  })

  it('plans the same edit from the usage', () => {
    expect(planJavaFieldInlining(loop, loop.indexOf('node;'))).toEqual(planJavaFieldInlining(loop, loop.indexOf('node =')))
  })

  it('preserves construction order in compiled Java', (context) => {
    const program = `class Solution {
      static int created = 0;
      static class Node { final int i; final char c; Node(int i, char c) { this.i = i; this.c = c; created++; } }
      static String solve(String s) {
        int n = s.length();
        Node[] nodes = new Node[n];
        for (int i = 0; i < n; i++) {
          Node node = new Node(i, s.charAt(i));
          nodes[i] = node;
        }
        StringBuilder out = new StringBuilder();
        for (Node each : nodes) out.append(each.i).append(each.c);
        return out.append(created).toString();
      }
      public static void main(String[] args) { System.out.print(solve("abc")); }
    }`
    const expected = run(program)
    if (expected === null) context.skip()
    const output = apply(program)
    expect(output).toContain('nodes[i] = new Node(i, s.charAt(i));')
    expect(run(output)).toBe(expected)
  }, 20_000)

  it('inlines into a method argument', () => {
    const output = apply(wrap('Node node = new Node(i, c); list.add(node);'))
    expect(output).not.toContain('Node node')
    expect(output).toContain('list.add(new Node(i, c));')
  })

  it('inlines into a return statement', () => {
    expect(apply(wrap('Node node = new Node(i, c); return node;'))).toContain('return new Node(i, c);')
  })

  it('inlines a var declaration', () => {
    const output = apply(wrap('var node = new Node(i, c); nodes[0] = node;'))
    expect(output).not.toContain('var node')
    expect(output).toContain('nodes[0] = new Node(i, c);')
  })

  it('inlines explicit type arguments and String arguments', () => {
    expect(apply(wrap('Box<Integer> node = new Box<Integer>(i); return node;'))).toContain('return new Box<Integer>(i);')
    expect(apply(wrap('Node node = new Node("n" + i); list.add(node);'))).toContain('list.add(new Node("n" + i));')
  })

  it.each([
    ['two uses', wrap('Node node = new Node(i, c); nodes[0] = node; nodes[1] = node;')],
    ['a use in a later statement', wrap('Node node = new Node(i, c); n = 1; nodes[0] = node;')],
    ['a ternary use', wrap('Node node = new Node(i, c); nodes[0] = flag ? node : null;')],
    ['a short-circuit use', wrap('Node node = new Node(i, c); flag = flag && node != null;')],
    ['a nested statement use', wrap('Node node = new Node(i, c); if (flag) nodes[0] = node;')],
    ['a lambda use', wrap('Node node = new Node(i, c); Runnable r; r = () -> list.add(node);')],
    ['a diamond', wrap('Box<Integer> node = new Box<>(i); return node;')],
    ['a var diamond', wrap('var node = new Box<>(i); return node;')],
    ['a call before the use', wrap('Node node = new Node(i, c); nodes[next()] = node;')],
    ['an array read before the use', wrap('Node node = new Node(i, c); nodes[a[0]] = node;')],
    ['a nested array store target', wrap('Node node = new Node(i, c); grid[0][i] = node;', 'Node[][] grid;')],
    ['a field read before the use', wrap('Node node = new Node(i, c); this.nodes[i] = node;', 'Node[] nodes;')],
    ['a source type created before the use', wrap('Node node = new Node(i, c); list.add(new Wrapper(node).value);', 'static class Wrapper { Node value; Wrapper(Node n) { value = n; } }')],
    ['an update in the arguments', wrap('Node node = new Node(i++, c); nodes[0] = node;')],
    ['a call in the arguments', wrap('Node node = new Node(next(), c); nodes[0] = node;')],
    ['a field read in the arguments', wrap('Node node = new Node(k, c); nodes[0] = node;', 'int k;')],
    ['a dependency computed by a call', wrap('int m = next(); Node node = new Node(m, c); nodes[0] = node;')],
    ['an anonymous class body', wrap('Node node = new Node(i, c) { }; nodes[0] = node;')],
    ['a qualified creation', wrap('Node node = outer.new Node(i, c); nodes[0] = node;', 'Solution outer;')],
    ['several declarators', wrap('Node node = new Node(i, c), other = null; nodes[0] = node;')],
    ['a C-style array declarator', wrap('Node node[] = new Node(i, c); nodes[0] = node[0];')],
  ])('rejects %s', (_label, input) => {
    expect(planJavaFieldInlining(input, input.indexOf('node ='))).toHaveProperty('reason')
  })

  it('rejects a declared type that differs from the created type', () => {
    const input = wrap('Object o = new Node(i, c); list.add((Node) o);')
    expect(planJavaFieldInlining(input, input.indexOf('o ='))).toHaveProperty('reason')
  })

  it('rejects a field', () => {
    const input = wrap('nodes[0] = node;', 'Node node = new Node(1, \'a\');')
    expect(planJavaFieldInlining(input, input.indexOf('node ='))).toHaveProperty('reason')
  })

  it('rejects an enum creation', () => {
    const input = 'class Solution { enum Kind { A } Object f() { Kind node = new Kind(); return node; } }'
    expect(planJavaFieldInlining(input, input.indexOf('node ='))).toHaveProperty('reason')
  })

  it('keeps the existing reason for other class-typed initializers', () => {
    const input = wrap('Node node = nodes[0]; list.add(node);')
    expect(planJavaFieldInlining(input, input.indexOf('node ='))).toEqual({
      reason: 'The variable needs a safe initializer with stable primitive or String values.',
    })
  })
})

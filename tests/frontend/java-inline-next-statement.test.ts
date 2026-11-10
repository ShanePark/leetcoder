import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function apply(source: string, position = source.indexOf('cost =')): string {
  const result = planJavaFieldInlining(source, position)
  if ('reason' in result) throw new Error(result.reason)
  return [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function run(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-next-statement-'))
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

const wrap = (body: string, members = ''): string =>
  `class Solution { ${members} int f(int n, int k, int x, int[] a, int[] costs, int[] dp, boolean flag) { ${body} return 0; } }`

describe('Inline a local read into the next statement', () => {
  const source = wrap('int i = 0, j = 1;\n    int cost = costs[i + j - 1] + j * j;\n    dp[i + j] = Math.min(dp[i] + cost, dp[i + j]);\n')

  it('moves an array read into the single use without a cast', () => {
    const output = apply(source)
    expect(output).not.toContain('int cost')
    expect(output).toContain('dp[i + j] = Math.min(dp[i] + (costs[i + j - 1] + j * j), dp[i + j]);')
  })

  it('plans the same edit from the usage', () => {
    expect(planJavaFieldInlining(source, source.indexOf('cost, dp'))).toEqual(planJavaFieldInlining(source, source.indexOf('cost =')))
  })

  it('preserves the computed table in compiled Java', (context) => {
    const program = `class Solution {
      static int solve(int n, int[] costs) {
        int[] dp = new int[n + 1];
        java.util.Arrays.fill(dp, Integer.MAX_VALUE / 2);
        dp[0] = 0;
        for (int i = 0; i < n; i++) {
          for (int j = 1; i + j <= costs.length; j++) {
            int cost = costs[i + j - 1] + j * j;
            dp[i + j] = Math.min(dp[i] + cost, dp[i + j]);
          }
        }
        return dp[n];
      }
      public static void main(String[] args) { System.out.print(solve(4, new int[]{1, 2, 3, 4})); }
    }`
    const expected = run(program)
    if (expected === null) context.skip()
    expect(run(apply(program))).toBe(expected)
  }, 20_000)

  it('inlines into a return expression', () => {
    expect(apply(wrap('int cost = a[k] + 1; return x + cost;'))).toContain('return x + (a[k] + 1);')
  })

  it('inlines into a plain local assignment', () => {
    expect(apply(wrap('int cost = a[k]; x = cost;'))).toContain('x = (a[k]);')
  })

  it('keeps nested array element types exact', () => {
    const output = apply('class Solution { int f(int[][] g, int r) { int cost = g[r][0] + 1; return r + cost; } }')
    expect(output).toContain('return r + (g[r][0] + 1);')
  })

  it('keeps the cast when a C-style array hides the element type', () => {
    expect(apply('class Solution { int f(int costs[], int r) { int cost = costs[r]; return r + cost; } }'))
      .toContain('return r + ((int) costs[r]);')
  })

  it('reads a local receiver named like a standard class as an ordinary local', () => {
    expect(apply(wrap('Helper Math = helper(); int cost = a[0]; dp[0] = Math.min(cost, 1);')))
      .toContain('dp[0] = Math.min(a[0], 1);')
  })

  it('inlines arithmetic over loop variables without an array read', () => {
    expect(apply(wrap('for (int j = 1; j < n; j++) { int cost = j * j; dp[j] = Math.min(dp[0] + cost, dp[j]); }')))
      .toContain('dp[j] = Math.min(dp[0] + (j * j), dp[j]);')
  })

  it('keeps a widening cast for an element of a narrower type', () => {
    expect(apply('class Solution { long f(int[] a, long r) { long cost = a[0]; return r + cost; } }'))
      .toContain('return r + ((long) a[0]);')
  })

  it.each([
    ['two uses', wrap('int cost = a[k]; dp[0] = cost + cost;')],
    ['a use in a later statement', wrap('int cost = a[k]; x = 1; dp[0] = cost;')],
    ['a write in a statement between', wrap('int cost = a[k]; a[k] = 2; dp[0] = cost;')],
    ['an update to the left of the use', wrap('int cost = a[0]; a[k++] = cost;')],
    ['a call to the left of the use', wrap('int cost = a[0]; x = foo() + cost;', 'int foo() { return 1; }')],
    ['a nested assignment', wrap('int cost = a[0]; x = dp[0] = cost;')],
    ['a compound assignment', wrap('int cost = a[0]; x += cost;')],
    ['the assignment target', wrap('int cost = 0 + k; dp[cost + a[0]] = 1;')],
    ['a ternary use', wrap('int cost = a[0]; dp[0] = flag ? cost : 1;')],
    ['a short-circuit use', wrap('int cost = a[0]; flag = flag && cost > 0;')],
    ['a lambda use', wrap('int cost = a[0]; Runnable r; r = () -> use(cost);')],
    ['an anonymous class use', wrap('int cost = a[0]; run(new Object() { int g() { return cost; } });')],
    ['a nested statement use', wrap('int cost = a[0]; if (flag) dp[0] = cost;')],
    ['division in the initializer', wrap('int cost = a[0] / k; dp[0] = cost;')],
    ['remainder in the initializer', wrap('int cost = a[0] % k; dp[0] = cost;')],
    ['a call in the initializer', wrap('int cost = foo(); dp[0] = cost;', 'int foo() { return 1; }')],
    ['an update in the initializer', wrap('int cost = k++; dp[0] = cost;')],
    ['a field read in the initializer', wrap('int cost = data[0]; dp[0] = cost;', 'int[] data = new int[1];')],
    ['a String local', wrap('String cost = names[0]; use(1 + cost);', 'String[] names;')],
    ['several declarators', wrap('int cost = a[0], other = 1; dp[0] = cost;')],
    ['a user Math receiver', wrap('int cost = a[0]; dp[0] = Math.min(cost, 1);', 'static class Math { static int min(int p, int q) { return p; } }')],
    ['a field Math receiver', wrap('int cost = a[0]; dp[0] = Math.min(cost, 1);', 'Helper Math;')],
    ['an imported Math receiver', `import foo.Math; ${wrap('int cost = a[0]; dp[0] = Math.min(cost, 1);')}`],
    ['a dependency computed by a call', wrap('int m = foo(); int cost = a[m]; dp[0] = cost;', 'int foo() { return 1; }')],
  ])('rejects %s', (_label, input) => {
    expect(planJavaFieldInlining(input, input.indexOf('cost ='))).toHaveProperty('reason')
  })

  it('rejects a field target with a runtime initializer', () => {
    const field = 'class Solution { int[] a; int cost = a[0]; int f() { return 1 + cost; } }'
    expect(planJavaFieldInlining(field, field.indexOf('cost ='))).toHaveProperty('reason')
  })
})

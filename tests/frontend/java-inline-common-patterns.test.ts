import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string, name: string): string {
  const result = planJavaFieldInlining(source, source.search(new RegExp(`\\b${name}\\s*=`)))
  if ('reason' in result) throw new Error(result.reason)
  return [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function compileAndRun(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-common-'))
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

const method = (body: string, parameters = 'int[] a, int i, String s, int[] f, boolean flag', members = ''): string =>
  `class Solution { ${members} int solve(${parameters}) { ${body} } }`

describe('Inline common algorithm reads', () => {
  it.each([
    ['n', method('int n = a.length; int t = 0; for (int k = 0; k < n; k++) t += a[k] * n; return t + n;'),
      'int t = 0; for (int k = 0; k < (a.length); k++) t += a[k] * (a.length); return t + (a.length);'],
    ['m', method('int m = g.length, c = g[0].length; for (int r = 0; r < m; r++) c += r; return c;', 'int[][] g'),
      'c = g[0].length; for (int r = 0; r < (g.length); r++) c += r; return c;'],
    ['n', method('int n = a.length; int[] dp = new int[n + 1]; return dp[n];'),
      'int[] dp = new int[(a.length) + 1]; return dp[(a.length)];'],
    ['n', method('int n = s.length(); int t = 0; while (t < n) t += n; return t;'),
      'int t = 0; while (t < (s.length())) t += (s.length()); return t;'],
    ['n', method('int t = 0; for (String w : words) { int n = w.length(); t += n * n; } return t;', 'String[] words'),
      't += (w.length()) * (w.length());'],
    ['c', method('char c = s.charAt(i); if (c == 98) return c + 1; return c;'),
      "if ((s.charAt(i)) == 98) return (s.charAt(i)) + 1; return (s.charAt(i));"],
    ['x', method('int t = 0; for (int k = 0; k < 3; k++) { int x = k + 1; t += x * x; } return t;'), 't += (k + 1) * (k + 1);'],
    ['x', method('int t = 0; for (int v : a) { int x = v * 2; t += x + x; } return t;'), 't += (v * 2) + (v * 2);'],
    ['bit', method('int bit = 1 << i; return (mask & bit) != 0 ? mask ^ bit : mask | bit;', 'int mask, int i'),
      'return (mask & (1 << i)) != 0 ? mask ^ (1 << i) : mask | (1 << i);'],
    ['n', method('int n = v.length; return n + n;', 'int... v'), 'return (v.length) + (v.length);'],
    ['n', method('int n = v.length; return n + n;', 'int v[]'), 'return (v.length) + (v.length);'],
  ])('repeats the immutable read %s', (name, source, expected) => {
    expect(inline(source, name)).toContain(expected)
  })

  it.each([
    ['int cost = f[i] + 1; int next = a[i] + cost; return next;', 'cost', 'int next = a[i] + (f[i] + 1); return next;'],
    ['int cost = f[i] + 1; if (a[i] + cost > 2) return 1; return 0;', 'cost', 'if (a[i] + (f[i] + 1) > 2) return 1; return 0;'],
    ['int cost = a[i]; if (cost > 0 && flag) return 1; return 0;', 'cost', 'if ((a[i]) > 0 && flag) return 1; return 0;'],
    ['int c = a[i]; return c > 0 ? 1 : 2;', 'c', 'return (a[i]) > 0 ? 1 : 2;'],
    ['int x = a[i]; int[] r = new int[]{x, 1}; return r[0];', 'x', 'int[] r = new int[]{(a[i]), 1}; return r[0];'],
    ['int x = a[i] + 60; return new StringBuilder(x).capacity();', 'x', 'return new StringBuilder((a[i] + 60)).capacity();'],
    ['int idx = s.charAt(i) - 97; f[idx]++; return f[1];', 'idx', "f[(s.charAt(i) - 97)]++; return f[1];"],
    ['int idx = s.charAt(i) - 97; --f[idx]; return f[1];', 'idx', '--f[(s.charAt(i) - 97)]; return f[1];'],
    ['int mid = i + (a.length - i) / 2; return a[mid];', 'mid', 'return a[(i + (a.length - i) / 2)];'],
    ['int r = i % 10; return r * 2;', 'r', 'return (i % 10) * 2;'],
    ['int v = Math.max(a[0], a[1]); return v + 1;', 'v', 'return (Math.max(a[0], a[1])) + 1;'],
    ['int v = Math.abs(a[0] - i); return v * 2;', 'v', 'return (Math.abs(a[0] - i)) * 2;'],
    ['int n = s.length(); int c = a[n]; return c + 1;', 'c', 'return (a[n]) + 1;'],
  ])('moves one read into the next statement: %s', (body, name, expected) => {
    expect(inline(method(body), name)).toContain(expected)
  })

  it('resolves Math through a JDK wildcard import', () => {
    const source = `import java.util.*; ${method('int v = a[i] + 1; a[0] = Math.max(v, a[0]); return a[0];')}`
    expect(inline(source, 'v')).toContain('a[0] = Math.max(a[i] + 1, a[0]);')
  })

  it.each([
    ['long n = a.length; return n * n;', 'n', 'return ((long) a.length) * ((long) a.length);'],
    ['int c = s.charAt(0); return c + 1;', 'c', 'return ((int) s.charAt(0)) + 1;'],
    ['double avg = (i + i) / 2; return (int) avg;', 'avg', 'return (int) ((double) ((i + i) / 2));'],
    ['long v = Math.abs(a[0]); return (int) v;', 'v', 'return (int) ((long) Math.abs(a[0]));'],
  ])('keeps the declared numeric type: %s', (body, name, expected) => {
    expect(inline(method(body), name)).toContain(expected)
  })

  it.each([
    ['int n = a.length; return n + 1;', 'n', 'return (a.length) + 1;'],
    ['char c = s.charAt(i); return c + c;', 'c', 'return (s.charAt(i)) + (s.charAt(i));'],
    ['int v = Math.abs(a[0]); return v;', 'v', 'return (Math.abs(a[0]));'],
  ])('adds no cast for an exactly typed read: %s', (body, name, expected) => {
    expect(inline(method(body), name)).toContain(expected)
  })

  it('preserves normal and failing results in compiled Java', (context) => {
    const source = `import java.util.*;
    class Solution {
      static String f(int x){return "int";} static String f(long x){return "long";} static String f(char x){return "char";}
      static int lengths(int[] nums){int n = nums.length; int t = 0; for (int i = 0; i < n; i++) t += nums[i] * n; return t + n;}
      static int chars(String s, int i){char c = s.charAt(i); if (c == 'b') return c + 1; return c * 2;}
      static int table(int[] dp, int[] costs, int i, int j){int cost = costs[i + j - 1] + j * j; int next = dp[i] + cost; return next;}
      static int counts(String s, int[] f){for (int i = 0; i < s.length(); i++) {int idx = s.charAt(i) - 'a'; f[idx]++;} return f[1];}
      static int search(int[] a, int lo, int hi){int mid = lo + (hi - lo) / 2; return a[mid];}
      static String overloadLong(int[] a){long n = a.length; return f(n);}
      static String overloadChar(String s){char c = s.charAt(0); return f(c);}
      static String overloadInt(String s){int c = s.charAt(0); return f(c);}
      static int bits(int mask, int i){int bit = 1 << i; return (mask & bit) != 0 ? mask ^ bit : mask | bit;}
      static int loop(){int t = 0; for (int i = 0; i < 3; i++) {int x = i + 1; t += x * x;} return t;}
      static long widened(int a){long v = a; return v * 1000000L * 1000000L;}
      static void attempt(java.util.function.Supplier<Object> body){
        try { System.out.print(body.get() + ";"); }
        catch (RuntimeException error) { System.out.print(error.getClass().getSimpleName() + ";"); }
      }
      public static void main(String[] args){
        attempt(() -> lengths(new int[]{1, 2, 3})); attempt(() -> lengths(null));
        attempt(() -> chars("abc", 1)); attempt(() -> chars("abc", 5)); attempt(() -> chars(null, 0));
        attempt(() -> table(new int[]{1, 2}, new int[]{3, 4}, 0, 1)); attempt(() -> table(new int[]{1}, new int[]{3}, 0, 9));
        attempt(() -> counts("abcb", new int[3])); attempt(() -> search(new int[]{1, 2, 3}, 0, 2));
        attempt(() -> overloadLong(new int[3])); attempt(() -> overloadChar("x")); attempt(() -> overloadInt("x"));
        attempt(() -> bits(5, 2)); attempt(() -> loop()); attempt(() -> widened(7));
      }
    }`
    let output = source
    for (const name of ['n', 'c', 'cost', 'idx', 'mid', 'n', 'c', 'c', 'bit', 'x', 'v']) output = inline(output, name)
    expect(output).not.toMatch(/\bint (cost|mid|bit) =/)
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(expected).toContain('NullPointerException')
    expect(compileAndRun(output)).toBe(expected)
  }, 30_000)

  it.each([
    ['a reassigned array', 'int n = a.length; a = new int[9]; return n + a.length;', 'n'],
    ['a reassigned String', 'int n = s.length(); s = "zzz"; return n + s.length();', 'n'],
    ['a counter written in the block', 'char c = s.charAt(i); i++; return c + s.charAt(i);', 'c'],
    ['a dependency written later', 'int x = i + 1; i = 9; return x + i;', 'x'],
    ['an array element read used twice', 'int v = a[i]; a[i] = 9; return v + a[i];', 'v'],
    ['a replaceable row length', 'int n = g[0].length; g[0] = new int[5]; return n;', 'n'],
    ['a call before the first use', 'int n = a.length; int k = read(); return n + k;', 'n'],
    ['a branch before the first use', 'int n = a.length; if (flag) return 0; return n;', 'n'],
    ['a first use in a branch', 'int n = a.length; if (flag) { return n; } return 0;', 'n'],
    ['a first use on the right of ||', 'int n = a.length; return flag || n > 0 ? 1 : 0;', 'n'],
    ['a first use in a ternary branch', 'int n = a.length; return flag ? n : 0;', 'n'],
    ['a first use in a loop update', 'int n = a.length; int t = 0; for (int k = 0; k < 3; k += n) t++; return t;', 'n'],
    ['a first use in a loop body', 'int n = a.length; int t = 0; for (int k = 0; k < 2; k++) t += n; return t;', 'n'],
    ['an array read moved into a while condition', 'int c = a[0]; while (c > i) i++; return i;', 'c'],
    ['an array read moved into a for header', 'int c = a[0]; int t = 0; for (int k = 0; k < c; k++) t++; return t;', 'c'],
    ['an array read moved into a branch', 'int v = a[0]; if (flag) { return v; } return 0;', 'v'],
    ['a zero literal divisor', 'int v = i / 0; return v + 1;', 'v'],
    ['a zero hexadecimal divisor', 'int v = i / 0x0; return v + 1;', 'v'],
    ['a variable divisor', 'int v = 7 / i; return v + 1;', 'v'],
  ])('refuses %s', (_label, body, name) => {
    const source = method(body, 'int[] a, int i, String s, int[][] g, boolean flag', 'int read() { return 1; }')
    expect(planJavaFieldInlining(source, source.search(new RegExp(`\\b${name}\\s*=`)))).toHaveProperty('reason')
  })

  it.each([
    ['a loop counter captured by a lambda', 'class Solution { int f() { int t = 0; for (int i = 0; i < 3; i++) { int x = i + 1; java.util.function.IntSupplier g = () -> x; t += g.getAsInt(); } return t; } }', 'x'],
    ['a source class whose initializer may run first', 'class Solution { static class B { B(int v) {} } Object f(int[] a) { int v = a[0]; return new B(v); } }', 'v'],
    ['a foreign wildcard that may define Math', 'import custom.*; class Solution { int f(int[] a) { int v = a[0]; return Math.max(v, 1); } }', 'v'],
    ['a parameter call on the left', 'class Solution { int g() { return 1; } int f(int[] a) { int v = a[0]; return g() + v; } }', 'v'],
    ['an earlier declarator with an effect', 'class Solution { int g() { return 1; } int f(int[] a) { int v = a[0]; int p = g(), q = v; return p + q; } }', 'v'],
  ])('refuses %s', (_label, source, name) => {
    expect(planJavaFieldInlining(source, source.search(new RegExp(`\\b${name}\\s*=`)))).toHaveProperty('reason')
  })
})

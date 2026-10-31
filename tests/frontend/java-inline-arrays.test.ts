import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string): string {
  const result = planJavaFieldInlining(source, source.indexOf('arr'))
  if ('reason' in result) throw new Error(result.reason)
  return [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function run(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-array-'))
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

describe('Inline local array variables', () => {
  it.each(['int[] arr = {1, 2, 5, 2, 3}', 'int[] arr = new int[]{1, 2, 5, 2, 3}', 'int arr[] = {1, 2, 5, 2, 3}'])('inlines the nested assertion argument: %s', (declaration) => {
    const source = `class Solution { void test(){${declaration}; assertThat(targetIndices(arr, 2)).containsExactly(1, 2);} }`
    const output = inline(source)
    expect(output).not.toContain('arr')
    expect(output).toMatch(/targetIndices\(new int\[\]\s*\{1, 2, 5, 2, 3\}, 2\)/)
    expect(planJavaFieldInlining(source, source.indexOf('targetIndices(arr') + 'targetIndices('.length)).toEqual(planJavaFieldInlining(source, source.indexOf('arr')))
  })

  it('preserves array overloads, mutation by the called method, and argument evaluation order in compiled Java', (context) => {
    const source = `class Solution {
      static String trace="";
      static int before(){trace+="before:"; return 2;}
      static void use(int first, long[] values, int last){values[0]++; System.out.print(trace+first+":"+values[0]+":"+last);}
      static void use(int first, Object values, int last){throw new AssertionError();}
      public static void main(String[] args){long[] arr={1, 2}; use(before(), arr, 3);}
    }`
    const expected = run(source)
    if (expected === null) context.skip()
    expect(expected).toBe('before:2:2:3')
    expect(run(inline(source))).toBe(expected)
  })

  it('preserves stable local element dependencies and initializer comments', () => {
    const output = inline('class Solution { void f(){int value=3; int[] arr={/* keep */value, 2}; use(arr, 1);} }')
    expect(output).toContain('new int[] {/* keep */value, 2}')
  })

  it.each(['byte[] arr={1, 2}', 'String arr[]={"a", "b"}', 'String[] arr=new String[]{"a", "b"}'])('preserves narrow primitive and String array initializers in compiled Java: %s', (declaration, context) => {
    const source = `class Solution { public static void main(String[] args){${declaration}; System.out.print(java.util.Arrays.toString(arr));} }`
    const expected = run(source)
    if (expected === null) context.skip()
    expect(run(inline(source))).toBe(expected)
  })

  it.each([
    'int[] arr={1}; use(arr, arr);',
    'int[] arr={1}; use(arr); use(arr);',
    'int[] arr={1}; arr=new int[]{2}; use(arr);',
    'int[] arr={1}; arr[0]++;',
    'int[] arr={1}; arr[0]=2;',
    'int[] arr={1}; other(); use(arr);',
    'int[] arr={1}; if(flag) use(arr);',
    'int[] arr={1}; Runnable callback=()->use(arr);',
    'int[] arr={1}; use(flag ? arr : null);',
    'int[] arr={read()}; use(before(), arr);',
    'int[] arr=new int[read()]; use(arr);',
    'int value=1; int[] arr={value}; use(value++, arr);',
    'int[] arr={1}, other={2}; use(arr);',
    'Object[] arr=new String[]{"a"}; use(arr);',
    'int[] arr={read().value}; use(before(), arr);',
    'int[] arr={obj.value}; use(before(), arr);',
    'int[] arr=new int[][]{{1}}; use(arr);',
  ])('rejects changed identity, execution paths, mutations, or unstable elements: %s', (body) => {
    const source = `class Solution { void f(boolean flag){${body}} }`
    expect(planJavaFieldInlining(source, source.indexOf('arr'))).toHaveProperty('reason')
  })

  it('inlines a sized multidimensional array into the next return statement', () => {
    const source = `class Solution {
    public int minCost(int[][] grid) {
        int[][][] dp = new int[grid.length][grid[0].length][1024];
        return dfs(grid, 0, 0, grid[0][0], dp);
    }
}`
    const result = planJavaFieldInlining(source, source.indexOf('dp'))
    if ('reason' in result) throw new Error(result.reason)
    const output = [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
    expect(output).toBe(`class Solution {
    public int minCost(int[][] grid) {
        return dfs(grid, 0, 0, grid[0][0], new int[grid.length][grid[0].length][1024]);
    }
}`)
  })

  it.each([
    ['int[] arr={1, 2}; return sum(arr);', 'return sum(new int[] {1, 2});'],
    ['int arr[][]=new int[n][]; return sum(n, arr);', 'return sum(n, new int[n][]);'],
    ['int[] arr=new int[-n]; this.use(n, values[0], values.length, arr);', 'this.use(n, values[0], values.length, new int[-n]);'],
  ])('inlines into the next return or expression statement: %s', (body, expected) => {
    const source = `class Solution { int f(int n, int[] values){${body}} }`
    expect(inline(source)).toBe(`class Solution { int f(int n, int[] values){ ${expected}} }`)
  })

  it('preserves sized array allocation in compiled Java', (context) => {
    const source = `class Solution {
      static int use(int first, int[][] values){values[1][2]=first; return values.length*10+values[0].length+values[1][2];}
      static int f(int[][] grid){int[][] arr=new int[grid.length][grid[0].length]; return use(grid[0][0], arr);}
      public static void main(String[] args){System.out.print(f(new int[][]{{7, 8, 9}, {1, 2, 3}}));}
    }`
    const expected = run(source)
    if (expected === null) context.skip()
    expect(expected).toBe('30')
    expect(run(inline(source))).toBe(expected)
  })

  it.each([
    'int[][] arr=new int[n][n]; return use(read(), arr);',
    'int[][] arr=new int[n][n]; return use(values[read()], arr);',
    'int[][] arr=new int[n][n]; return use(n++, arr);',
    'int[][] arr=new int[n][n]; return read().use(arr);',
    'int[][] arr=new int[n][n]; return new Box(arr);',
    'int[][] arr=new int[n][read()]; return use(arr);',
    'int[][] arr=new int[n][n / 2]; return use(arr);',
    'int[][] arr=new int[n][field]; return use(arr);',
    'int[][] arr=new int[n][box.size]; return use(arr);',
    'int[][] arr=new int[n][n]; return use(arr, arr);',
    'int[][] arr=new int[n][n]; use(arr); return use(arr);',
    'int[][] arr=new int[n][n]; other(); return use(arr);',
    'int[][] arr=new int[n][n]; return flag ? use(arr) : 0;',
    'int[][] arr=new int[n][]; arr[0]=values; return use(arr);',
    'int[] arr=new int[n][n]; return use(arr);',
    'int[][] arr=new int[n]; return use(arr);',
    'int[][] arr=new int[][n]; return use(arr);',
    'Integer[][] arr=new Integer[n][n]; return use(arr);',
  ])('rejects sized arrays with effects, unstable dimensions, or other uses: %s', (body) => {
    const source = `class Solution { int field; int f(boolean flag, int n, int[] values, Box box){${body}} }`
    expect(planJavaFieldInlining(source, source.indexOf('arr'))).toHaveProperty('reason')
  })

  it('keeps array fields unsupported', () => {
    const source = 'class Solution { int[] arr={1}; void f(){use(arr);} }'
    expect(planJavaFieldInlining(source, source.indexOf('arr'))).toHaveProperty('reason')
  })
})

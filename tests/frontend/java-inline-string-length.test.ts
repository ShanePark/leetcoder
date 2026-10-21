import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string): string {
  const plan = planJavaFieldInlining(source, source.indexOf('n ='))
  if ('reason' in plan) throw new Error(plan.reason)
  return [...plan.changes].sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function compileAndRun(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-string-length-'))
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

describe('Inline a stable String length', () => {
  it('inlines repeated length reads in loops while preserving normal and exceptional results', (context) => {
    const source = `class Solution {
      static int f(String s) {
        int n = s.length();
        char min = s.charAt(0);
        char max = s.charAt(0);
        boolean isSorted = true;
        for (int i = 1; i < n; i++) {
          char c = s.charAt(i);
          if (c < s.charAt(i - 1)) isSorted = false;
          min = (char) Math.min(min, c);
          max = (char) Math.max(max, c);
        }
        if (isSorted) return 0;
        if (n == 2) return -1;
        if (s.charAt(0) == min || s.charAt(n - 1) == max) return 1;
        for (int i = 1; i < n - 1; i++) {
          if (s.charAt(i) == min || s.charAt(i) == max) return 2;
        }
        return 3;
      }
      public static void main(String[] args) {
        for (String input : new String[]{"a", "ab", "ba", "cba", "bac", "cab", "", null}) {
          try { System.out.print(f(input) + ";"); }
          catch (RuntimeException error) { System.out.print(error.getClass().getSimpleName() + ";"); }
        }
      }
    }`
    const output = inline(source)
    expect(output).not.toContain('int n =')
    expect(output).toContain('i < (s.length())')
    expect(output).toContain('if ((s.length()) == 2)')
    expect(output).not.toContain('(int)')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(expected).toContain('StringIndexOutOfBoundsException;NullPointerException;')
    expect(compileAndRun(output)).toBe(expected)
  }, 30_000)

  it.each(['String', 'java.lang.String'])('supports an unchanged local %s receiver and preserves the declared numeric type', (type) => {
    const source = `class Solution { long f(${type} input){${type} s=input; long n = s.length(); char first=s.charAt(0); return n << 40;} }`
    const output = inline(source)
    expect(output).toContain('return ((long) s.length()) << 40;')
    expect(output).not.toContain('long n =')
  })

  it('checks the first initializer of an adjacent multi-variable declaration', () => {
    const source = 'class Solution {int f(String s){int n = s.length(); char first=s.charAt(0), last=s.charAt(n-1); return n;} }'
    expect(inline(source)).toContain('char first=s.charAt(0), last=s.charAt((s.length())-1);')
  })

  it.each([
    's="changed"; int n = s.length(); char first=s.charAt(0); return n;',
    'int n = s.length(); char first=s.charAt(0); s="changed"; return n;',
    'int n = s.length(); if(flag) return 0; char first=s.charAt(0); return n;',
    'int n = s.length(); try {char first=s.charAt(0);} catch(NullPointerException error) {} return n;',
    'int n = s.length(); effect(); char first=s.charAt(0); return n;',
    'int n = s.length(); char first=s.charAt(index()); return n;',
    'int n = s.length(); char first=other.charAt(0); return n;',
    'int n = s.length(), otherValue=effect(); char first=s.charAt(0); return n;',
    'int n = s.length(); int value=effect(); char first=s.charAt(0); return n;',
    'int n = s.length(); int value=effect(), first=s.charAt(0); return n;',
    'int n = s.length(); char first=s.charAt(0); class Inner {String s="other"; int read(){return n;}} return n;',
    'int n = read(); char first=s.charAt(0); return n;',
  ])('refuses mutation, deferred null checks, effects, shadowing, or other methods: %s', (body) => {
    const source = `class Solution {int effect(){return 0;} int index(){return 0;} int read(){return 1;} int f(String s,String other,boolean flag){${body}}}`
    expect(planJavaFieldInlining(source, source.indexOf('n ='))).toHaveProperty('reason')
  })

  it.each([
    'class Solution {int f(StringBuilder s){int n = s.length(); char first=s.charAt(0); return n;} }',
    'class Solution {String s; int f(){int n = s.length(); char first=s.charAt(0); return n;} }',
    'class Solution {static class String {int length(){return 1;} char charAt(int i){return 0;}} int f(String s){int n = s.length(); char first=s.charAt(0); return n;} }',
    'import custom.String; class Solution {int f(String s){int n = s.length(); char first=s.charAt(0); return n;} }',
    'import custom.*; class Solution {int f(String s){int n = s.length(); char first=s.charAt(0); return n;} }',
    'class Solution {int f(String... s){int n = s.length(); char first=s.charAt(0); return n;} }',
    'class Solution {int f(String s[]){int n = s.length(); char first=s.charAt(0); return n;} }',
  ])('requires a scalar standard String local or parameter: %s', (source) => {
    expect(planJavaFieldInlining(source, source.indexOf('n ='))).toHaveProperty('reason')
  })
})

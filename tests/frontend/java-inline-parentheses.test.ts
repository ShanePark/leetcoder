import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string, name = 'value'): { output: string; replacements: string[] } {
  const result = planJavaFieldInlining(source, source.indexOf(`${name}=`))
  if ('reason' in result) throw new Error(result.reason)
  const replacements = result.changes.filter((change) => source.slice(change.from, change.to) === name)
    .map((change) => change.insert)
  expect(replacements).toHaveLength(result.usageCount)
  const output = [...result.changes].sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
  expect(output).not.toContain(`${name}=`)
  return { output, replacements }
}

function argumentFixture(type: string, initializer: string, usage = 'value'): string {
  return `class Solution {
    final int BASE=7;
    static int read(){return 7;}
    void f(int sum,Integer boxed){StringBuilder sb=new StringBuilder(); ${type} value=${initializer}; sb.append(${usage});}
  }`
}

describe('Inline expressions into argument delimiters', () => {
  it('produces the requested Math.min append without any new cast or grouping', () => {
    const source = 'class Solution {String f(int sum,int num){StringBuilder sb=new StringBuilder(); for(;num>0;num--,sum-=9){int value=Math.min(9,sum); sb.append(value);} return sb.toString();}}'
    const { output, replacements } = inline(source)
    expect(replacements).toEqual(['Math.min(9,sum)'])
    expect(output).toContain('sb.append(Math.min(9,sum));')
  })

  it.each([
    ['int', '7'],
    ['long', '7L'],
    ['float', '1.1f'],
    ['double', '1.1'],
    ['char', "'a'"],
    ['boolean', 'true'],
    ['int', 'BASE'],
    ['int', 'this.BASE'],
    ['int', 'read()'],
    ['int', 'Math.min(9,sum)'],
    ['int', '1+2'],
    ['int', 'true?1:2'],
    ['int', '-1'],
    ['int', '+1'],
    ['int', '(int) 1.9'],
  ])('does not group a complete %s argument initialized with %s', (type, initializer) => {
    const { output, replacements } = inline(argumentFixture(type, initializer))
    expect(replacements).toEqual([initializer])
    expect(output).toContain(`sb.append(${initializer});`)
  })

  it.each([
    ['Math.min(9,sum)', '(value)', 'sb.append((Math.min(9,sum)));'],
    ['(Math.min(9,sum))', 'value', 'sb.append((Math.min(9,sum)));'],
    ['(Math.min(9,sum))', '(value)', 'sb.append(((Math.min(9,sum))));'],
    ['((Math.min(9,sum)))', '((value))', 'sb.append(((((Math.min(9,sum))))));'],
    ['1+2', '(value)', 'sb.append((1+2));'],
  ])('preserves explicit initializer and usage parentheses: %s in %s', (initializer, usage, expected) => {
    expect(inline(argumentFixture('int', initializer, usage)).output).toContain(expected)
  })

  it('preserves argument and statement comments without adding a grouping pair', () => {
    const source = 'class Solution {void f(int sum){StringBuilder sb=new StringBuilder(); int value=Math.min(9,/* limit */sum); /* next */ sb.append(/* argument */value/* end */);}}'
    const { output, replacements } = inline(source)
    expect(replacements).toEqual(['Math.min(9,/* limit */sum)'])
    expect(output).toContain('/* next */ sb.append(/* argument */Math.min(9,/* limit */sum)/* end */);')
  })
})

describe('Inline required conversion grouping', () => {
  it.each([
    ['long', 'read()', '(long) read()'],
    ['long', '1', '(long) 1'],
    ['byte', '1', '(byte) 1'],
    ['short', '2', '(short) 2'],
    ['char', '65', '(char) 65'],
    ['float', '16777217', '(float) 16777217'],
    ['int', 'boxed', '(int) boxed'],
    ['long', '1+2', '(long) (1+2)'],
    ['long', '-1', '(long) (-1)'],
    ['long', 'true?1:2', '(long) (true?1:2)'],
    ['long', '(1+2)', '(long) (1+2)'],
    ['long', '(int) 1.9', '(long) ((int) 1.9)'],
  ])('keeps the %s conversion while grouping only its necessary operand: %s', (type, initializer, expected) => {
    const { output, replacements } = inline(argumentFixture(type, initializer))
    expect(replacements).toEqual([expected])
    expect(output).toContain(`sb.append(${expected});`)
  })

  it('preserves existing argument parentheses around a generated cast', () => {
    expect(inline(argumentFixture('long', 'read()', '(value)')).output).toContain('sb.append(((long) read()));')
  })
})

describe('Inline grouping outside argument delimiters', () => {
  it.each([
    ['int', '1+2', 'value*3', '(1+2)*3'],
    ['int', '1+2', '10-value', '10-(1+2)'],
    ['int', '1<<2', 'value+1', '(1<<2)+1'],
    ['int', 'true?1:2', 'value*3', '(true?1:2)*3'],
    ['int', '-1', '-value', '-(-1)'],
    ['int', '+1', '+value', '+(+1)'],
    ['boolean', 'true&&false', '!value', '!(true&&false)'],
    ['long', '1', 'value<<40', '((long) 1)<<40'],
    ['long', '1+2', 'value*3', '((long) (1+2))*3'],
    ['int', '(1+2)', 'value*3', '(1+2)*3'],
  ])('keeps precedence and lexical safety for %s %s used as %s', (type, initializer, usage, expected) => {
    const source = `class Solution {${type} f(){final ${type} value=${initializer}; return ${usage};}}`
    expect(inline(source).output).toContain(`return ${expected};`)
  })

  it('renders each usage according to its own surrounding delimiters', () => {
    const source = 'class Solution {int f(){final int value=1+2; StringBuilder sb=new StringBuilder(); sb.append(value); return value*3;}}'
    const { output, replacements } = inline(source)
    expect(replacements).toEqual(['1+2', '(1+2)'])
    expect(output).toContain('sb.append(1+2); return (1+2)*3;')
  })

  it.each([
    ['consume(value;', 'consume((7);'],
    ['return (value;', 'return ((7);'],
  ])('keeps conservative grouping inside an unfinished delimiter: %s', (usage, expected) => {
    const source = `class Solution {int f(){int value=7; ${usage}}}`
    expect(inline(source).output).toContain(expected)
  })

  it('uses a complete existing inner pair while preserving an unfinished outer argument list', () => {
    const source = 'class Solution {int f(){int value=7; consume((value);}}'
    expect(inline(source).output).toContain('consume((7);')
  })
})

function compileAndRun(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-parentheses-'))
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

it('preserves compiled precedence, conversions, overloads and evaluation effects across delimiter contexts', (context) => {
  const source = `class Solution {
    static int calls;
    static class Sink {
      StringBuilder text=new StringBuilder();
      void append(byte n){text.append("byte:"+n+";");}
      void append(char n){text.append("char:"+n+";");}
      void append(int n){text.append("int:"+n+";");}
      void append(long n){text.append("long:"+n+";");}
      void append(float n){text.append("float:"+n+";");}
      void append(Integer n){text.append("boxed:"+n+";");}
    }
    static int read(Sink sink){calls++; sink.text.append("read;"); return 7;}
    static void run(Sink sink,int sum,Integer boxed){
      int call=Math.min(9,sum); sink.append(call);
      int compound=1+2; sink.append(compound);
      int conditional=true?1:2; sink.append(conditional);
      int explicit=(Math.min(9,sum)); sink.append(explicit);
      int usage=read(sink); sink.append((usage));
      long widened=read(sink); sink.append(widened);
      byte narrow=1; sink.append(narrow);
      char character=65; sink.append(character);
      float rounded=16777217; sink.append(rounded);
      int unboxed=boxed; sink.append(unboxed);
      int precedence=1+2; sink.append(precedence*3);
      int subtraction=1+2; sink.append(10-subtraction);
      int negative=-1; sink.append(-negative);
      int positive=+1; sink.append(+positive);
      long shifted=1; sink.append(shifted<<40);
      int grouped=(1+2); sink.append(grouped*3);
      long promoted=1+2; sink.append(promoted*3);
      final int branch=true?1:2; sink.append(branch*3);
    }
    public static void main(String[] args){Sink sink=new Sink(); run(sink,7,8); System.out.print(sink.text+"calls="+calls);}
  }`
  let output = source
  for (const name of ['call', 'compound', 'conditional', 'explicit', 'usage', 'widened', 'narrow', 'character', 'rounded', 'unboxed', 'precedence', 'subtraction', 'negative', 'positive', 'shifted', 'grouped', 'promoted', 'branch']) {
    output = inline(output, name).output
  }
  expect(output).toContain('sink.append(Math.min(9,sum));')
  expect(output).toContain('sink.append((long) read(sink));')
  expect(output).toContain('sink.append((1+2)*3);')
  expect(output).toContain('sink.append(-(-1));')
  const before = compileAndRun(source)
  if (before === null) context.skip()
  expect(before).toBe('int:7;int:3;int:1;int:7;read;int:7;read;long:7;byte:1;char:A;float:1.6777216E7;int:8;int:9;int:7;int:1;int:1;long:1099511627776;int:9;long:9;int:3;calls=2')
  expect(compileAndRun(output)).toBe(before)
}, 20_000)

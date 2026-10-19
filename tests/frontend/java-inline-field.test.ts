import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining, type JavaFieldInliningPlan } from '../../src/java-refactor/inline-field'

function plan(source: string, name = 'MOD', occurrence = 0): JavaFieldInliningPlan {
  let position = -1
  for (let index = 0; index <= occurrence; index++) position = source.indexOf(name, position + 1)
  const result = planJavaFieldInlining(source, position, position + name.length)
  if ('reason' in result) throw new Error(result.reason)
  return result
}

function apply(source: string, result: JavaFieldInliningPlan): string {
  return [...result.changes].sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

function compileAndRun(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-field-'))
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

function expectFailure(source: string, name = 'MOD'): void {
  const declaration = source.indexOf(` ${name}=`)
  expect(planJavaFieldInlining(source, declaration >= 0 ? declaration + 1 : source.indexOf(name))).toHaveProperty('reason')
}

describe('Java Inline Field planner', () => {
  it('inlines all current-file usages and removes the field without changing comments or strings', () => {
    const source = 'class Solution { private static final int MOD = 7; int f(int n) { // MOD\n String s="MOD"; return n % MOD + this.MOD + Solution.MOD; } }'
    const result = plan(source)
    const output = apply(source, result)
    expect(result.usageCount).toBe(3)
    expect(output).not.toContain('int MOD =')
    expect(output).toContain('// MOD\n String s="MOD"')
    expect(output).toContain('n % (7) + (7) + (7)')
  })

  it('accepts a caret or exact field reference selection and excludes shadowing locals and parameters', () => {
    const source = 'class Solution { static final int MOD=7; int f(int MOD) {return MOD + this.MOD;} int g(){int MOD=2; return MOD + Solution.MOD;} }'
    const position = source.indexOf('this.MOD') + 6
    const result = planJavaFieldInlining(source, position)
    expect(result).not.toHaveProperty('reason')
    const output = apply(source, result as JavaFieldInliningPlan)
    expect(output).toContain('return MOD + (7)')
    expect((result as JavaFieldInliningPlan).usageCount).toBe(2)
    expect(planJavaFieldInlining(source, source.indexOf('return MOD') + 7)).toHaveProperty('reason')
  })

  it('resolves nested lexical reads and outer-this qualification while preserving another class field', () => {
    const source = 'class Solution { final int MOD=7; class Inner { int f(){return MOD + Solution.this.MOD;} } } class Other { int MOD=3; int f(){return this.MOD;} }'
    const result = plan(source)
    expect(result.usageCount).toBe(2)
    const output = apply(source, result)
    expect(output).toContain('int MOD=3; int f(){return this.MOD;}')
  })

  it('preserves lambda, catch, loop, and nested-field shadowing', () => {
    const source = 'class Solution { final int MOD=7; int f(){ java.util.function.IntUnaryOperator fn=MOD -> MOD; for(int MOD=0;MOD<2;MOD++){} for(int MOD:new int[]{1}){} try{}catch(Exception MOD){MOD.hashCode();} return MOD; } class Inner { int MOD=2; int f(){return MOD;} } }'
    const result = plan(source)
    expect(result.usageCount).toBe(1)
    expect(apply(source, result)).toContain('fn=MOD -> MOD')
  })

  it('removes one declarator, inlines other initializers, and preserves CRLF/comments', () => {
    for (const declaration of ['MOD=7, OTHER=MOD', 'OTHER=MOD, MOD=7', 'A=1, MOD=7, OTHER=MOD']) {
      const source = `class Solution {\r\n static final int ${declaration}; // retained\r\n int f(){return OTHER;}\r\n}`
      const result = plan(source)
      const output = apply(source, result)
      expect(output).toContain('OTHER=(7)')
      expect(output).not.toContain('MOD=7')
      expect(output).toContain('// retained\r\n')
      expect(output.replace(/\r\n/g, '')).not.toContain('\n')
    }
  })

  it('keeps declaration comments when removing the last field', () => {
    const source = 'class Solution { final /* keep */ int MOD=/* initializer */7; int f(){return MOD;} }'
    const output = apply(source, plan(source))
    expect(output).toContain('/* keep */')
    expect(output).toContain('/* initializer */')
  })

  it('preserves precedence, primitive conversion, overflow, overload resolution, and String identity in compiled Java', (context) => {
    const source = `class Solution {
      static final long MOD = 1;
      static final byte SMALL = 2;
      static final int SUM = 1 + 2;
      static final String TEXT = "a" + "b";
      static String pick(int x){return "int";}
      static String pick(long x){return "long";}
      public static void main(String[] args){System.out.print(pick(MOD)+":"+(MOD<<40)+":"+(SUM*3)+":"+SMALL+":"+(TEXT=="ab"));}
    }`
    let output = source
    for (const name of ['MOD', 'SMALL', 'SUM', 'TEXT']) output = apply(output, plan(output, name))
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('supports unassigned nonfinal primitive fields in ordinary arithmetic reads', () => {
    const source = 'class Solution { int MOD=7; int f(int n){return n%MOD;} }'
    expect(plan(source).usageCount).toBe(1)
  })

  it.each([
    'package p; import static p.Solution.MOD; class Solution { static final int MOD=7; } class Other {int f(){return MOD;}}',
    'package p; import static p.Solution.*; class Solution { static final int MOD=7; } class Other {int f(){return MOD;}}',
    'class Solution { /* final */ int MOD=7; String f(){return \"\"+MOD;} }',
    'class Solution { final int MOD=1/0; }',
    'class Solution { final int MOD=7; String f(){return \"\"+this.MOD;} }',
    'class Solution extends Base { int MOD=7; int f(){return MOD;} } class Base {}',
    'class Solution { final int MOD=7; int f(){return new Base(){int g(){return MOD;}}.g();} } class Base {int MOD=2;}',
    'class Solution { int MOD; int f(){return MOD;} }',
    'class Solution { int MOD=read(); int read(){return 7;} }',
    'class Solution { int n=7; int MOD=n; }',
    'class Solution { int[] MOD={7}; }',
    'class Solution { int MOD=7; void f(){MOD=8;} }',
    'class Solution { int MOD=7; void f(){this.MOD+=8;} }',
    'class Solution { int MOD=7; void f(){++MOD;} }',
    'class Solution { int MOD=7; void f(){(this.MOD)++;} }',
    'class Solution { static int x=Solution.MOD; static int MOD=7; }',
    'class Solution { int x=f(); int MOD=7; int f(){return MOD;} }',
    'class Solution { int x=f(), MOD=7; int f(){return MOD;} }',
    'class Solution { int x; {x=f();} int MOD=7; int f(){return MOD;} }',
    'class Solution { int x=MOD, MOD=7; }',
    'class Solution { volatile int MOD=7; int f(){return MOD;} }',
    'class Solution { boolean MOD=false; void f(){while(MOD){}} }',
    'class Solution { int MOD=7; String f(){return ""+MOD;} }',
    'class Solution { int MOD=7; int f(boolean b, byte n){return b?MOD:n;} }',
    'class Solution { static final int MOD=7; int f(Solution s){return s.MOD;} }',
    'class Solution { final int MOD=7; int f(Other o){return o.MOD;} }',
  ])('rejects an unsafe initializer, write, or unresolved usage atomically: %s', (source) => {
    expectFailure(source)
  })

  it('rejects a parameter, partial selection, and syntax error', () => {
    expectFailure('class Solution { int f(int MOD){return MOD;} }')
    const source = 'class Solution { int MOD=7; }'
    const position = source.indexOf('MOD')
    expect(planJavaFieldInlining(source, position, position + 1)).toHaveProperty('reason')
    expectFailure('class Solution { int MOD=7; int f( { return MOD; } }')
  })
})


describe('Java Inline local variable planner', () => {
  it('inlines the screenshot declaration from its name or usage and preserves compiled results', (context) => {
    const source = `class Solution {
      static int f() { final int MOD = (int) 1e9 + 7; int a = MOD + 1; return a; }
      public static void main(String[] args) { System.out.print(f()); }
    }`
    const declarationPlan = plan(source)
    const usagePosition = source.indexOf('MOD + 1')
    expect(planJavaFieldInlining(source, usagePosition + 1)).toEqual(declarationPlan)
    const output = apply(source, declarationPlan)
    expect(output).not.toContain('final int MOD')
    expect(output).toContain('int a = ((int) 1e9 + 7) + 1;')
    expect(declarationPlan.usageCount).toBe(1)
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('inlines mutable-but-unassigned locals in a loop body and return expression', () => {
    const source = 'class Solution { int f(int[] nums){int MOD=1_000_000_007; int result=0; for(int n:nums){result=(result+n)%MOD;} return result%MOD;} }'
    const result = plan(source)
    expect(result.usageCount).toBe(2)
    expect(apply(source, result)).not.toContain('MOD')
  })

  it('preserves same-named fields, sibling-block locals, other methods, and nested declarations', (context) => {
    const source = `class Solution {
      int MOD=11;
      int f(){
        { final int MOD=7; class Inner { int MOD=2; int value(int MOD){return MOD+this.MOD;} }
          java.util.function.IntSupplier captured=()->MOD;
          int answer=MOD+this.MOD+new Inner().value(3)+captured.getAsInt();
          return answer;
        }
      }
      int g(){int MOD=3; return MOD;}
      public static void main(String[] args){System.out.print(new Solution().f()+":"+new Solution().g());}
    }`
    const result = plan(source, 'MOD', 1)
    const output = apply(source, result)
    expect(result.usageCount).toBe(2)
    expect(output).toContain('int MOD=11;')
    expect(output).toContain('int MOD=2; int value(int MOD){return MOD+this.MOD;}')
    expect(output).toContain('int g(){int MOD=3; return MOD;}')
    expect(output).toContain('this.MOD')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('removes one local declarator and inlines subsequent initializers with CRLF/comments preserved', () => {
    for (const declaration of ['MOD=7, other=MOD', 'first=1, MOD=7, other=MOD', 'other=1, MOD=7']) {
      const source = `class Solution { int f(){\r\n final int ${declaration}; // retained\r\n return MOD+other;\r\n} }`
      const result = plan(source)
      const output = apply(source, result)
      expect(output).not.toContain('MOD=7')
      expect(output).not.toContain('return MOD')
      expect(output).toContain('// retained\r\n')
      expect(output.replace(/\r\n/g, '')).not.toContain('\n')
      if (declaration.includes('other=MOD')) expect(output).toContain('other=(7)')
    }
  })

  it('bounds each local binding to its block while preserving strings and comments', () => {
    const source = 'class Solution { int f(){ {int MOD=7; System.out.println(MOD);} {int MOD=3; // MOD\n String text="MOD"; return MOD;} } }'
    const output = apply(source, plan(source))
    expect(output).toContain('System.out.println(7)')
    expect(output).toContain('int MOD=3; // MOD\n String text="MOD"; return MOD;')
  })

  it('does not apply field-only superclass or earlier-initializer restrictions to locals', () => {
    const source = 'class Solution extends Base { int x=f(); int f(){int MOD=7; return MOD;} } class Base {}'
    expect(plan(source).usageCount).toBe(1)
  })

  it.each([
    'class Solution { int f(){int MOD; return MOD;} }',
    'class Solution { int f(){int MOD=read(); return MOD;} int read(){return 7;} }',
    'class Solution { int f(){int MOD=7; MOD=8; return MOD;} }',
    'class Solution { int f(){int MOD=7; MOD+=8; return MOD;} }',
    'class Solution { int f(){int MOD=7; return ++MOD;} }',
    'class Solution { int f(){int MOD=7; Runnable r=()->{MOD++;}; return MOD;} }',
    'class Solution { int f(){for(int MOD=7;MOD<10;MOD++){} return 1;} }',
    'class Solution { int f(){for(final int MOD=7;;){return MOD;}} }',
    'class Solution { void f(){try(AutoCloseable MOD=null){MOD.close();}catch(Exception e){}} }',
    'class Solution { int f(){int MOD=7; byte n=1; return true?MOD:n;} }',
    'class Solution { void f(){boolean MOD=false; while(MOD){}} }',
    'class Solution { String f(){int MOD=7; return ""+MOD;} }',
    'class Solution { int f(){final int MOD=1/0; return MOD;} }',
    'class Solution { int f(){final int MOD=7; return new Base(){int g(){return MOD;}}.g();} } class Base {int MOD=2;}',
  ])('rejects unsafe writes, evaluation, or declaration positions atomically: %s', (source) => {
    expectFailure(source)
  })
})


describe('Inline initializer type preservation', () => {
  it('groups existing int casts and promoted expressions without adding another cast', () => {
    for (const declaration of ['static final int MOD=(int) 1e9 + 7;', '']) {
      const source = declaration
        ? `class Solution { ${declaration} int f(){return MOD;} }`
        : 'class Solution { int f(){final int MOD=(int) 1e9 + 7; return MOD;} }'
      expect(apply(source, plan(source))).toContain('return ((int) 1e9 + 7);')
    }
    const initializers = ['1 + 2', '(1 + 2)', '+\'a\'', '1 << 2L', '1 & 2']
    for (const initializer of initializers) {
      const source = `class Solution { int f(){final int MOD=${initializer}; return MOD;} }`
      expect(apply(source, plan(source))).toContain(`return ${initializer === '(1 + 2)' ? initializer : `(${initializer})`};`)
    }
  })

  it.each([
    ['long', '1', '(long) 1'],
    ['byte', '2', '(byte) 2'],
    ['short', '3', '(short) 3'],
    ['char', '65', '(char) 65'],
    ['long', '1L', '1L'],
    ['float', '1.0f', '1.0f'],
    ['double', '1.0', '1.0'],
    ['char', "'a'", "'a'"],
    ['boolean', 'true && false', 'true && false'],
    ['boolean', '1 < 2', '1 < 2'],
    ['int', 'true ? 1 : 2', 'true ? 1 : 2'],
  ])('keeps only type-preserving casts for %s initialized with %s', (type, initializer, replacement) => {
    const source = `class Solution { void f(){final ${type} MOD=${initializer}; System.out.println(MOD);} }`
    expect(apply(source, plan(source))).toContain(`System.out.println(${replacement})`)
  })
})


describe('Inline resource shadowing', () => {
  it('keeps resource reads in later resources and the try body while resolving catch/finally reads to the field', (context) => {
    const source = `class Solution {
      static final int MOD=7;
      static int f(){
        try(java.io.Reader MOD=new java.io.StringReader(""); java.io.Reader next=new java.io.BufferedReader(MOD)){
          MOD.read(); next.read();
        } catch(Exception e){return MOD;} finally {System.out.print(MOD);}
        return MOD;
      }
      public static void main(String[] args){System.out.print(f());}
    }`
    const result = plan(source)
    const output = apply(source, result)
    expect(result.usageCount).toBe(3)
    expect(output).toContain('new java.io.BufferedReader(MOD)')
    expect(output).toContain('MOD.read(); next.read();')
    expect(output).toContain('catch(Exception e){return (7);} finally {System.out.print(7);}')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('resolves catch and finally reads to a captured local instead of a closed resource', () => {
    const source = 'class Solution { int f(){final int MOD=7; class Inner {int g(){try(java.io.Reader MOD=new java.io.StringReader("")){} catch(Exception e){return MOD;} finally {System.out.println(MOD);} return MOD;}} return new Inner().g();} }'
    const result = plan(source)
    expect(result.usageCount).toBe(3)
    const output = apply(source, result)
    expect(output).toContain('try(java.io.Reader MOD=')
    expect(output).toContain('catch(Exception e){return (7);} finally {System.out.println(7);}')
  })
})


describe('Inline stable initializer dependencies', () => {
  it('inlines screenshot a from its declaration or usage while keeping the final MOD field', (context) => {
    const source = `class Solution {
      final int MOD = (int)1e9+7;
      int f(){int a = MOD + 1; int b = a + MOD - 1; return a;}
      public static void main(String[] args){System.out.print(new Solution().f());}
    }`
    const from = source.indexOf('a = MOD')
    const result = planJavaFieldInlining(source, from, from + 1)
    if ('reason' in result) throw new Error(result.reason)
    expect(planJavaFieldInlining(source, source.indexOf('return a') + 7)).toEqual(result)
    expect(result.usageCount).toBe(2)
    const output = apply(source, result)
    expect(output).toContain('final int MOD = (int)1e9+7;')
    expect(output).not.toContain('int a =')
    expect(output).toContain('int b = (MOD + 1) + MOD - 1; return (MOD + 1);')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('proves recursively final primitive and String dependencies without expanding or recasting them', (context) => {
    const source = `class Solution {
      static final int BASE=3;
      static final long LIMIT=BASE+1;
      static long f(){final long offset=LIMIT+1; long a=offset+1; return a;}
      static String g(){final String prefix="v"; final String a=prefix+BASE; return a;}
      public static void main(String[] args){System.out.print(f()+":"+g());}
    }`
    let output = source
    for (let iteration = 0; iteration < 2; iteration++) {
      const position = output.indexOf(' a=') + 1
      const result = planJavaFieldInlining(output, position)
      if ('reason' in result) throw new Error(result.reason)
      output = apply(output, result)
    }
    expect(output).toContain('return (offset+1);')
    expect(output).toContain('return (prefix+BASE);')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('retains necessary declared-type conversion for a constant dependency', () => {
    const source = 'class Solution { final int BASE=1; long f(){long a=BASE; return a<<40;} }'
    const result = planJavaFieldInlining(source, source.indexOf('a=BASE'))
    if ('reason' in result) throw new Error(result.reason)
    expect(apply(source, result)).toContain('return ((long) BASE)<<40;')
  })

  it('allows stable dependency references in captured lambda reads', (context) => {
    const source = 'class Solution { static int f(){final int BASE=7; int a=BASE+1; java.util.function.IntSupplier fn=()->a; return fn.getAsInt();} public static void main(String[] args){System.out.print(f());} }'
    const position = source.indexOf('a=BASE')
    const result = planJavaFieldInlining(source, position)
    if ('reason' in result) throw new Error(result.reason)
    expect(apply(source, result)).toContain('fn=()->(BASE+1)')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(apply(source, result))).toBe(expected)
  }, 20_000)

  it.each([
    'class Solution { int MOD=7; int f(){int a=MOD+1; MOD=9; return a;} }',
    'class Solution { final int MOD=read(); int read(){return 7;} int f(){int a=MOD+1; return a;} }',
    'class Solution { final int MOD=7; int f(){int a=MOD+1; {int MOD=99; return a;}} }',
    'class Solution { final int MOD=7; int f(){int a=MOD+1; class Inner{int MOD=99; int g(){return a;}} return new Inner().g();} }',
    'class Solution { final int MOD=7; int f(){int a=this.MOD+1; return a;} }',
    'class Solution { final int MOD=7; int f(){int a=MOD+1; a=9; return a;} }',
    'class Solution { final int MOD=7; int f(){MOD=9; int a=MOD+1; return a;} }',
    'class Solution { final int FIRST=SECOND; final int SECOND=FIRST; int f(){int a=FIRST+1; return a;} }',
    'class Solution { final int MOD=1/0; int f(){int a=MOD+1; return a;} }',
    'class Solution { final String TEXT="v"; String f(){String a=TEXT; return a+"x";} }',
  ])('refuses mutable, effectful, cyclic, shadowed, or reassigned dependencies atomically: %s', (source) => {
    const result = planJavaFieldInlining(source, source.indexOf('a='))
    expect(result).toHaveProperty('reason')
  })
})


describe('Inline dependency proof reuse', () => {
  it('handles a branched chain of shared constant dependencies without repeated proof expansion', (context) => {
    const constants = ['final int C0=1;']
    for (let index = 1; index <= 64; index++) constants.push(`final int C${index}=C${index - 1}+C${index - 1};`)
    const source = `class Solution {
      static int f(){${constants.join('')} int a=C64+1; return a;}
      public static void main(String[] args){System.out.print(f());}
    }`
    const result = planJavaFieldInlining(source, source.indexOf('a=C64'))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(1)
    const output = apply(source, result)
    expect(output).toContain('return (C64+1);')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)
})


describe('Inline with unrelated unfinished code', () => {
  it.each([
    'class Solution { int f(){int a=7; int b=a+1; return a;} void broken(){int x=;} }',
    'class Solution { int f(){int a=7; int b=a+1; int broken=; return a;} }',
    'class Solution { int f(){int broken=; int a=7; int b=a+1; return a;} }',
    'class Solution { int f(){int a=7; int b=a+1; return a;} void unfinished(',
    'class Solution { int f(){int a=7; int b=a+1; return a;',
    'class Solution { int f(){int a=7; int b=a+1; return a;} } class Other extends {',
    'class Solution { int f(){int a=7; int b=a+1; return a;} void unfinished(){String text="unfinished',
  ])('inlines understood local usages despite unrelated syntax errors: %s', (source) => {
    const result = planJavaFieldInlining(source, source.indexOf('a=7'))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(2)
    const output = apply(source, result)
    expect(output).toContain('int b=(7)+1;')
    expect(output).toContain('return (7);')
    expect(output).not.toContain('int a=7;')
    expect(output.replace('int b=(7)+1;', 'int b=a+1;').replace('return (7);', 'return a;'))
      .toBe(source.replace('int a=7;', ''))
  })

  it('allows a field and constant-dependent local with an unrelated malformed method', () => {
    const source = 'class Solution { final int MOD=7; int f(){int a=MOD+1; return a;} void broken(){int x=;} }'
    const localResult = planJavaFieldInlining(source, source.indexOf('a=MOD'))
    if ('reason' in localResult) throw new Error(localResult.reason)
    expect(apply(source, localResult)).toContain('return (MOD+1);')
    const fieldResult = plan(source)
    expect(fieldResult.usageCount).toBe(1)
    expect(apply(source, fieldResult)).toContain('int a=(7)+1;')
  })

  it('allows known comments and strings containing the name while unrelated syntax remains unfinished', () => {
    const source = 'class Solution { int f(){int a=7; // a\n String text="a"; return a;} void broken(){int x=;} }'
    const result = planJavaFieldInlining(source, source.indexOf('a=7'))
    if ('reason' in result) throw new Error(result.reason)
    const output = apply(source, result)
    expect(output).toContain('// a\n String text="a"; return (7);')
  })

  it.each([
    'class Solution { int f(){int a=7+; return a;} }',
    'class Solution { int f( {int a=7; return a;} }',
    'class Solution { int a=7; int f(){Object a ???; return a;} }',
    'class Solution { final int a=7; int f(){int ??? a; return a;} }',
    'class Solution { final int a=7; int f(){String ??? a; return a;} }',
    'class Solution { final int a=7; int f(){Object<String> ??? a; return a;} }',
    'class Solution { final int MOD=7; int f(){int a=MOD+1; int ??? MOD; return a;} }',
    'class Solution { int a=7; int f(){return object..a;} }',
    'class Solution { int a=7; int f(){new a+;} }',
    'class Solution { int a=7; String text="a',
    'class Solution { int a=7; /* a',
    'class Solution { int a=7; String text="""\n a',
    'class Solution { final int MOD=7+; int f(){int a=MOD+1; return a;} }',
  ])('refuses relevant malformed declarations, ownership, references, or hidden occurrences atomically: %s', (source) => {
    const position = source.includes('a=MOD') ? source.indexOf('a=MOD') : source.indexOf('a=7')
    expect(planJavaFieldInlining(source, position)).toHaveProperty('reason')
  })
})


describe('Inline recognized reads while surrounding expressions are incomplete', () => {
  it.each([
    ['return a+;', 'return (7)+;'],
    ['consume(a;', 'consume((7);'],
    ['return a', 'return (7)'],
  ])('replaces a bound local reference in %s while preserving unfinished syntax', (statement, expected) => {
    const source = `class Solution { int f(){int a=7; ${statement}} }`
    const result = planJavaFieldInlining(source, source.indexOf('a=7'))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(1)
    expect(apply(source, result)).toBe(`class Solution { int f(){ ${expected}} }`)
  })

  it('inlines a constant field in an incomplete return expression', () => {
    const source = 'class Solution { final int MOD=7; int f(){return MOD+;} }'
    const result = plan(source)
    expect(apply(source, result)).toContain('return (7)+;')
  })
})


describe('Inline syntax evidence follows local scope', () => {
  it.each([
    'void broken(int a = ;){}',
    'void broken(){String text="a',
    'void broken(){/* a',
    'void broken(){Object<String> ??? a;}',
  ])('ignores malformed same-spelled text outside the closed local scope: %s', (suffix) => {
    const source = `class Solution { int f(){int a=7; return a;} ${suffix} }`
    const result = planJavaFieldInlining(source, source.indexOf('a=7'))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(1)
    expect(apply(source, result)).toBe(`class Solution { int f(){ return (7);} ${suffix} }`)
  })

  it.each([
    'void broken(int MOD = ;){}',
    'void broken(){String text="MOD',
    'void broken(){/* MOD',
    'void broken(){Object<String> ??? MOD;}',
  ])('limits dependency spelling evidence to the copied local scope: %s', (suffix) => {
    const source = `class Solution { final int MOD=7; int f(){int a=MOD+1; return a;} ${suffix} }`
    const result = planJavaFieldInlining(source, source.indexOf('a=MOD'))
    if ('reason' in result) throw new Error(result.reason)
    expect(apply(source, result)).toBe(`class Solution { final int MOD=7; int f(){ return (MOD+1);} ${suffix} }`)
  })

  it('retains conservative document coverage for a field target and an unclosed local scope', () => {
    const field = 'class Solution { final int a=7; int f(){return a;} void broken(int a = ;){} }'
    expect(planJavaFieldInlining(field, field.indexOf('a=7'))).toHaveProperty('reason')
    const local = 'class Solution { int f(){int a=7; return a; void broken(int a = ;){} }'
    expect(planJavaFieldInlining(local, local.indexOf('a=7'))).toHaveProperty('reason')
  })
})


describe('Inline syntax evidence distinguishes numeric literal text', () => {
  it.each([
    ['b1', 'int', '0b1'],
    ['e9', 'double', '1e9'],
    ['x7', 'int', '0x7'],
  ])('ignores %s inside a valid numeric literal while replacing real reads', (name, type, literal) => {
    const source = `class Solution { int f(){int ${name}=7; ${type} number=${literal}; int answer=${name}+1; return ${name};} void broken(){int unfinished=;} }`
    const result = planJavaFieldInlining(source, source.indexOf(`${name}=7`))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(2)
    expect(apply(source, result)).toBe(`class Solution { int f(){ ${type} number=${literal}; int answer=(7)+1; return (7);} void broken(){int unfinished=;} }`)
  })

  it.each([
    ['x', 'int', '0x'],
    ['e', 'double', '1e'],
    ['b', 'int', '0b'],
  ])('refuses a recovered fake %s reference inside an unfinished numeric token', (name, type, literal) => {
    const source = `class Solution { int f(){int ${name}=7; ${type} number=${literal}; return ${name};} void broken(){int unfinished=;} }`
    expect(planJavaFieldInlining(source, source.indexOf(`${name}=7`))).toHaveProperty('reason')
  })
})


it('keeps complete string and comment text containing a digit-prefixed target name', () => {
  const source = 'class Solution { int f(){int x=7; String text="1x"; /* 0x */ return x;} void broken(){int unfinished=;} }'
  const result = planJavaFieldInlining(source, source.indexOf('x=7'))
  if ('reason' in result) throw new Error(result.reason)
  expect(result.usageCount).toBe(1)
  expect(apply(source, result)).toContain('String text="1x"; /* 0x */ return (7);')
})


describe('Inline never-written primitive local dependencies', () => {
  it('inlines referenced screenshot a and refuses unused b while leaving an unrelated unfinished assertion unchanged', () => {
    const source = 'class Solution { long f(){long MOD=1; long a=MOD<<40; long b=a<<40; return -1;} void test(){assertThat()} }'
    const a = planJavaFieldInlining(source, source.indexOf('a=MOD'))
    if ('reason' in a) throw new Error(a.reason)
    expect(a.usageCount).toBe(1)
    expect(apply(source, a)).toBe('class Solution { long f(){long MOD=1;  long b=(MOD<<40)<<40; return -1;} void test(){assertThat()} }')
    const b = planJavaFieldInlining(source, source.indexOf('b=a'))
    expect(b).toEqual({ reason: 'Variable b is never used.' })
  })

  it('preserves long shifts and remains nonconstant in runtime concatenation and conditional typing', (context) => {
    const source = `class Solution {
      static long f(){long MOD=1; long a=MOD<<40; long b=a<<40; return a+b;}
      static String g(){int n=1; final int a=n+1; String left=""+a; String right=""+a; return ""+(left==right);}
      static String h(){int n=1; final int a=n+1; byte small=1; var value=true?small:a; return ((Object)value).getClass().getName();}
      public static void main(String[] args){System.out.print(f()+":"+g()+":"+h());}
    }`
    let output = source
    while (output.includes(' a=')) {
      const result = planJavaFieldInlining(output, output.indexOf(' a=') + 1)
      if ('reason' in result) throw new Error(result.reason)
      output = apply(output, result)
    }
    expect(output).toContain('long b=(MOD<<40)<<40; return (MOD<<40)+b;')
    expect(output).toContain('String left=""+(n+1);')
    expect(output).toContain('var value=true?small:(n+1);')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('allows a final boolean initialized from a never-written nonconstant local in a loop condition', (context) => {
    const source = 'class Solution { static int f(){boolean flag=false; final boolean a=flag; while(a){return 1;} return 2;} public static void main(String[] args){System.out.print(f());} }'
    const result = planJavaFieldInlining(source, source.indexOf('a=flag'))
    if ('reason' in result) throw new Error(result.reason)
    expect(apply(source, result)).toContain('while(flag)')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(compileAndRun(apply(source, result))).toBe(expected)
  }, 20_000)

  it.each([
    'class Solution { int f(){int n=1; int a=n+1; n=2; return a;} }',
    'class Solution { int f(){int n=1; int a=n+1; n++; return a;} }',
    'class Solution { int f(){int n=1; {int a=n+1; System.out.println(a);} n=2; return 1;} }',
    'class Solution { int f(){int n=1; {int a=n+1; System.out.println(a);} n=; return 1;} }',
    'class Solution { int f(){int n=1; {int a=n+1; System.out.println(a);} int ??? n; return 1;} }',
    'class Solution { boolean f(){int n=1; final String a=""+n; return a==a;} }',
    'class Solution { int n=1; int f(){int a=n+1; return a;} }',
    'class Solution { int f(){int n=read(); int a=n+1; return a;} int read(){return 1;} }',
    'class Solution { int f(){int n=1; class Inner{final int FIELD=n+1; int g(){int a=FIELD+1; return a;}} return new Inner().g();} }',
  ])('refuses writes, recovered write uncertainty, runtime String identity, mutable fields, or effectful dependency initializers: %s', (source) => {
    expect(planJavaFieldInlining(source, source.indexOf('a='))).toHaveProperty('reason')
  })
})


describe('Inline unused target refusal', () => {
  it.each([
    'class Solution { int f(){int b=7; return -1;} }',
    'class Solution { int f(){int b=7; String text="b"; /* b */ return -1;} }',
    'class Solution { int f(){int b=7; class Inner{int b=3; int g(){return b;}} return new Inner().g();} }',
    'class Solution { int f(){int b=7; return -1;} int g(){int b=3; return b;} }',
    'class Solution { int f(){int b=7; return b();} int b(){return 1;} }',
  ])('returns only a failure for a local with no actual bound reads: %s', (source) => {
    expect(planJavaFieldInlining(source, source.indexOf('b=7'))).toEqual({ reason: 'Variable b is never used.' })
  })

  it.each([
    'class Solution { final int UNUSED=7; }',
    'class Solution { final int UNUSED=7; String text="UNUSED"; /* UNUSED */ }',
    'class Solution { final int UNUSED=7; int f(int UNUSED){return UNUSED;} }',
    'class Solution { final int UNUSED=7; class Inner{int UNUSED=3; int f(){return UNUSED;}} }',
  ])('returns only a failure for a field with no actual bound reads: %s', (source) => {
    expect(planJavaFieldInlining(source, source.indexOf('UNUSED=7'))).toEqual({ reason: 'Field UNUSED is never used.' })
  })

  it('still inlines a referenced b and counts references before removing the declaration', () => {
    const source = 'class Solution { long f(){long MOD=1; long a=MOD<<40; long b=a<<40; return b;} }'
    const result = planJavaFieldInlining(source, source.indexOf('b=a'))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(1)
    expect(apply(source, result)).toContain('return (a<<40);')
  })
})

describe('Inline an adjacent method argument', () => {
  it('moves the screenshot Math.min initializer into append once per loop iteration', (context) => {
    const source = `class Solution {
      static String f(int sum, int num) {
        StringBuilder sb = new StringBuilder();
        for (; num > 0; num--, sum -= 9) {
          int max = Math.min(9, sum);
          sb.append(max);
        }
        return sb.toString();
      }
      public static void main(String[] args) { System.out.print(f(20, 3)); }
    }`
    const result = planJavaFieldInlining(source, source.indexOf('max ='))
    if ('reason' in result) throw new Error(result.reason)
    expect(result.usageCount).toBe(1)
    expect(planJavaFieldInlining(source, source.indexOf('append(max') + 7)).toEqual(result)
    const output = apply(source, result)
    expect(output).not.toContain('int max =')
    expect(output).toContain('sb.append(Math.min(9, sum));')
    expect(output).not.toContain('(int)')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(expected).toBe('992')
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it('preserves side effects, evaluation count, parameter receivers, and the declared overload type', (context) => {
    const source = `class Solution {
      static int calls;
      static class Sink {
        String value="";
        void append(int value){this.value+="int:"+value;}
        void append(long value){this.value+="long:"+value;}
      }
      static int read(Sink sink){calls++; sink.value+="read:"; return 9;}
      static String f(Sink sink){long max=read(sink); sink.append((max)); return sink.value+":"+calls;}
      public static void main(String[] args){System.out.print(f(new Sink()));}
    }`
    const result = planJavaFieldInlining(source, source.indexOf('max=read'))
    if ('reason' in result) throw new Error(result.reason)
    const output = apply(source, result)
    expect(output).toContain('sink.append(((long) read(sink)));')
    const expected = compileAndRun(source)
    if (expected === null) context.skip()
    expect(expected).toBe('read:long:9:1')
    expect(compileAndRun(output)).toBe(expected)
  }, 20_000)

  it.each([
    'int max=read(); if(flag) sb.append(max);',
    'int max=read(); Runnable task=()->sb.append(max);',
    'int max=read(); while(flag) sb.append(max);',
    'int max=read(); update(); sb.append(max);',
    'int max=read(); sb.append(max); sb.append(max);',
    'int max=read(); builder().append(max);',
    'int max=read(); this.sb.append(max);',
    'int max=read(); sb.append(before(), max);',
    'int max=read(); sb.append(1+max);',
    'int max=read(), other=read(); sb.append(max);',
    'int max=(sb=new StringBuilder()).length(); sb.append(max);',
    'int max=read(); return max;',
    'int max=read(); sb.append(max++);',
    'int max=read(); sb.append(max); max=2;',
  ])('refuses delayed, duplicated, or reordered evaluation: %s', (body) => {
    const source = `class Solution { StringBuilder sb; int f(boolean flag){StringBuilder sb=new StringBuilder(); ${body} return 0;} }`
    expect(planJavaFieldInlining(source, source.indexOf('max='))).toHaveProperty('reason')
  })

  it('keeps method-call field initializers unsupported even with an adjacent argument use', () => {
    const source = 'class Solution { int max=read(); {StringBuilder sb=new StringBuilder(); sb.append(max);} int read(){return 9;} }'
    expect(planJavaFieldInlining(source, source.indexOf('max='))).toHaveProperty('reason')
  })
})

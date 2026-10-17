import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string, name = 'value'): { output: string; replacement: string } {
  const result = planJavaFieldInlining(source, source.indexOf(`${name}=`))
  if ('reason' in result) throw new Error(result.reason)
  expect(result.usageCount).toBe(1)
  const replacement = result.changes.find((change) => change.insert !== '')?.insert
  if (!replacement) throw new Error('Missing initializer replacement')
  const output = [...result.changes].sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
  expect(output).not.toContain(`${name}=`)
  return { output, replacement }
}

function fixture(type: string, expression: string, declarations = ''): string {
  return `class Solution {
    ${declarations}
    void f(int i, long l, float f, double d, byte b, short s, char c) {
      StringBuilder sink=new StringBuilder(); ${type} value=${expression}; sink.append(value);
    }
  }`
}

const mathArguments = [
  ['int', 'i, 9'],
  ['int', 'b, s'],
  ['int', 'c, b'],
  ['long', 'i, l'],
  ['long', 'l, i'],
  ['long', 'l, 9L'],
  ['float', 'i, f'],
  ['float', 'f, l'],
  ['float', 'f, 9.0f'],
  ['double', 'f, d'],
  ['double', 'd, i'],
  ['double', 'd, 9.0'],
] as const

describe('Inline exact Math return types', () => {
  it.each(['min', 'max'])('omits added casts for every primitive %s overload and argument promotion', (method) => {
    for (const [type, arguments_] of mathArguments) {
      const expression = `Math.${method}(${arguments_})`
      expect(inline(fixture(type, expression)).replacement).toBe(expression)
    }
  })

  it.each([
    ['long', 'Math.min(i, 9)'],
    ['float', 'Math.max(i, 9)'],
    ['double', 'Math.min(i, l)'],
    ['double', 'Math.max(f, l)'],
  ])('retains the declared %s conversion for %s', (type, expression) => {
    expect(inline(fixture(type, expression)).replacement).toBe(`(${type}) ${expression}`)
  })

  it.each([
    ['int', 'Math.min(i, Math.max(9, i))'],
    ['long', '(Math.max(l, 9L))'],
    ['int', 'Math.min(i + b, +s)'],
    ['long', 'Math.max(i << 2L, l)'],
    ['int', 'Math.max((int) d, i)'],
    ['int', 'java.lang.Math.min(i, 9)'],
  ])('recursively infers %s from %s without adding a cast', (type, expression) => {
    expect(inline(fixture(type, expression)).replacement).toBe(expression)
  })

  it.each([
    ['int i=7;', '', 'Math.min(i, 9)'],
    ['', 'final int BASE=7;', 'Math.max(BASE, 9)'],
    ['', 'final int BASE=7;', 'Math.min(this.BASE, 9)'],
    ['', 'static final long BASE=7L;', 'Math.max(Solution.BASE, 9)'],
  ])('uses resolved local and field types: %s %s %s', (local, field, expression) => {
    const type = expression.includes('Solution.BASE') ? 'long' : 'int'
    const source = `class Solution { ${field} void f(){StringBuilder sink=new StringBuilder(); ${local} ${type} value=${expression}; sink.append(value);} }`
    expect(inline(source).replacement).toBe(expression)
  })

  it('uses the parameter shadowing a same-named long field', () => {
    const source = fixture('int', 'Math.min(i, 9)', 'long i=7L;')
    expect(inline(source).replacement).toBe('Math.min(i, 9)')
  })

  it('trusts an explicit java.lang wildcard import', () => {
    expect(inline(`import java.lang.*; ${fixture('int', 'Math.min(i, 9)')}`).replacement).toBe('Math.min(i, 9)')
  })

  it('trusts an explicit java.lang.Math import', () => {
    expect(inline(`import java.lang.Math; ${fixture('int', 'Math.min(i, 9)')}`).replacement).toBe('Math.min(i, 9)')
  })

  it('refuses a qualified initializer dependency shadowed by an unrelated same-named field', () => {
    const source = 'class Solution {static final long BASE=7L; void f(){StringBuilder sink=new StringBuilder(); int value=Math.min(Other.BASE, 9); sink.append(value);}} class Other {static final int BASE=3;}'
    expect(planJavaFieldInlining(source, source.indexOf('value='))).toHaveProperty('reason')
  })
})

describe('Inline exact source-method and expression types', () => {
  it.each(['byte', 'short', 'char', 'int', 'long', 'float', 'double', 'boolean'])('omits an added %s cast for a resolved source-method return', (type) => {
    const literal = type === 'boolean' ? 'true' : type === 'char' ? "'a'" : '1'
    const source = fixture(type, 'read()', `${type} read(){return ${literal};}`)
    expect(inline(source).replacement).toBe('read()')
  })

  it.each([
    ['this.read()', 'int read(){return 7;}'],
    ['read(i)', 'int read(int n){return n;} int read(long n){return (int)n;}'],
    ['Provider.read()', 'static class Provider {static int read(){return 7;}}'],
  ])('omits an added cast for a resolved method owner: %s', (expression, declarations) => {
    expect(inline(fixture('int', expression, declarations)).replacement).toBe(expression)
  })

  it.each([
    ['int', '1 + 2'],
    ['int', '+\'a\''],
    ['int', '1 << 2L'],
    ['long', '1L >>> 2'],
    ['float', '1.0f + 2L'],
    ['double', '1.0 + 2.0f'],
    ['boolean', '1 < 2'],
    ['boolean', 'true ^ false'],
    ['int', '(int) 1.9'],
  ])('preserves the exact %s expression type without another cast: %s', (type, expression) => {
    expect(inline(fixture(type, expression)).replacement).toBe(expression)
  })

  it.each([
    ['byte', 'i > 0 ? b : b'],
    ['short', 'i > 0 ? s : s'],
    ['char', "i > 0 ? 'a' : 'b'"],
    ['int', 'i > 0 ? i : 9'],
    ['long', 'i > 0 ? l : 9L'],
    ['float', 'i > 0 ? f : 9.0f'],
    ['double', 'i > 0 ? d : 9.0'],
    ['boolean', 'i > 0 ? true : false'],
    ['int', 'i > 0 ? read() : read()', 'int read(){return 7;}'],
  ])('proves equal primitive %s conditional branches without adding a cast: %s', (type, expression, declarations = '') => {
    expect(inline(fixture(type, expression, declarations)).replacement).toBe(expression)
  })

  it.each([
    ['int', 'i > 0 ? b : 1'],
    ['int', 'i > 0 ? c : 65'],
    ['long', 'i > 0 ? i : l'],
  ])('retains conservative target conversions for mixed conditional branches: %s %s', (type, expression) => {
    expect(inline(fixture(type, expression)).replacement).toBe(`(${type}) (${expression})`)
  })

  it.each([
    ['byte', '1', '(byte) 1'],
    ['short', '2', '(short) 2'],
    ['char', '65', '(char) 65'],
    ['long', '1 + 2', '(long) (1 + 2)'],
    ['float', '1 + 2', '(float) (1 + 2)'],
    ['double', '1.0f + 2', '(double) (1.0f + 2)'],
    ['long', '(int) 1.9', '(long) ((int) 1.9)'],
  ])('keeps a necessary %s conversion for %s', (type, expression, replacement) => {
    expect(inline(fixture(type, expression)).replacement).toBe(replacement)
  })
})

describe('Inline conservative return-type evidence', () => {
  it.each([
    ['Math.min(i, 9)', 'static class Math {static short min(int a,int b){return (short)a;}}'],
    ['Math.min(i, 9)', 'static class Custom {short min(int a,int b){return (short)a;}}', 'Custom Math=new Custom();'],
    ['read(i)', 'int read(int n){return n;} long read(long n){return n;}'],
    ['read()', 'Integer read(){return 7;}'],
    ['external.read()', '', 'External external=new External();'],
    ['this.read()', 'int read(){return 7;}', '', 'extends Base'],
  ])('keeps the int conversion when %s lacks exact primitive type evidence', (expression, declarations, local = '', superclass = '') => {
    const source = `class Solution ${superclass} { ${declarations} void f(int i){StringBuilder sink=new StringBuilder(); ${local} int value=${expression}; sink.append(value);} }`
    expect(inline(source).replacement).toBe(`(int) ${expression}`)
  })

  it.each([
    'import custom.Math;',
    'import custom.*;',
    'import unrelated.*;',
    'import static custom.Owner.Math;',
    'import static custom.Owner.*;',
  ])('keeps casts for ambiguous Math imports: %s', (imports) => {
    expect(inline(`${imports} ${fixture('int', 'Math.min(i, 9)')}`).replacement).toBe('(int) Math.min(i, 9)')
  })

  it.each([
    ['Byte', 'int'],
    ['Short', 'int'],
    ['Character', 'int'],
    ['Integer', 'int'],
    ['Long', 'long'],
    ['Float', 'float'],
    ['Double', 'double'],
    ['java.lang.Integer', 'int'],
  ])('omits target casts after %s argument unboxing inside standard Math', (wrapper, type) => {
    for (const method of ['min', 'max']) {
      const expression = `Math.${method}(n, 9)`
      const source = `class Solution {void f(${wrapper} n){StringBuilder sink=new StringBuilder(); ${type} value=${expression}; sink.append(value);}}`
      expect(inline(source).replacement).toBe(expression)
    }
  })

  it.each([
    ['int', 'Byte left,Short right'],
    ['long', 'Integer left,Long right'],
    ['float', 'Long left,Float right'],
    ['double', 'Float left,Double right'],
  ])('promotes two unboxed Math arguments to %s: %s', (type, parameters) => {
    const source = `class Solution {void f(${parameters}){StringBuilder sink=new StringBuilder(); ${type} value=Math.min(left,right); sink.append(value);}}`
    expect(inline(source).replacement).toBe('Math.min(left,right)')
  })

  it.each([
    ['', 'Integer n=7;', 'Math.min(n,9)'],
    ['final Integer n=7;', '', 'Math.min(this.n,9)'],
    ['static final Integer n=7;', '', 'Math.min(Solution.n,9)'],
  ])('uses resolved boxed local and own-field argument types: %s %s %s', (field, local, expression) => {
    const source = `class Solution {${field} void f(){StringBuilder sink=new StringBuilder(); ${local} int value=${expression}; sink.append(value);}}`
    expect(inline(source).replacement).toBe(expression)
  })

  it.each([
    ['n', '(int) n'],
    ['true ? n : n', '(int) (true ? n : n)'],
    ['true ? n : 1', '(int) (true ? n : 1)'],
  ])('preserves direct or conditional boxed-value conversion: %s', (expression, replacement) => {
    const source = `class Solution {void f(Integer n){StringBuilder sink=new StringBuilder(); int value=${expression}; sink.append(value);}}`
    expect(inline(source).replacement).toBe(replacement)
  })

  it('keeps casts when a source value shadows the fully qualified Math root', () => {
    const source = 'class Solution {void f(Custom java){StringBuilder sink=new StringBuilder(); int value=java.lang.Math.min(7,9); sink.append(value);}}'
    expect(inline(source).replacement).toBe('(int) java.lang.Math.min(7,9)')
  })

  it('continues refusing boxed inline targets', () => {
    const source = 'class Solution { void f(){StringBuilder sink=new StringBuilder(); Integer value=7; sink.append(value);} }'
    expect(planJavaFieldInlining(source, source.indexOf('value='))).toHaveProperty('reason')
  })

  it.each([
    ['int numbers[]', ''],
    ['', 'int numbers[]={7};'],
  ])('keeps conversion casts with post-name array dimensions: %s %s', (parameter, local) => {
    const source = `class Solution {
      int choose(int n){return n;} short choose(int[] n){return (short)n[0];}
      void f(${parameter}){StringBuilder sink=new StringBuilder(); ${local} int value=choose(numbers); sink.append(value);}
    }`
    expect(inline(source).replacement).toBe('(int) choose(numbers)')
  })

  it('does not prove a shared primitive return type from post-parameter array dimensions', () => {
    const source = fixture('int', 'read(l)', 'int read(int n)[]{return new int[]{n};} int read(long n){return (int)n;}')
    expect(inline(source).replacement).toBe('(int) read(l)')
  })

  it('retains the long conversion for an inherited Object method beside a source overload', () => {
    const source = fixture('long', 'hashCode()', 'long hashCode(int n){return n;}')
    expect(inline(source).replacement).toBe('(long) hashCode()')
  })

  it('does not assume standard Math when an inherited field can shadow it', () => {
    const source = 'class Solution extends Base {void f(){StringBuilder sink=new StringBuilder(); int value=Math.min(7,9); sink.append(value);}} class Base {static Custom Math=new Custom();} class Custom {Integer min(int a,int b){return a;}}'
    expect(inline(source).replacement).toBe('(int) Math.min(7,9)')
  })

  it('does not infer a receiver from a same-named source class shadowed by a type parameter', () => {
    const source = 'class Solution {static class Helper {int read(){return 7;}} static class Other {Integer read(){return 7;}} <Helper extends Other> void f(Helper helper){StringBuilder sink=new StringBuilder(); int value=helper.read(); sink.append(value);}}'
    expect(inline(source).replacement).toBe('(int) helper.read()')
  })

  it('resolves a receiver type where the parameter was declared, before a same-named local class', () => {
    const source = 'import java.util.Random; class Solution {void f(Random random){class Random {long nextInt(){return 7L;}} StringBuilder sink=new StringBuilder(); long value=random.nextInt(); sink.append(value);}}'
    expect(inline(source).replacement).toBe('(long) random.nextInt()')
  })

  it('does not confuse an inherited member type with a same-named source class', () => {
    const source = 'class Solution extends Base {void f(Helper helper){StringBuilder sink=new StringBuilder(); int value=helper.read(); sink.append(value);}} class Base {static class Helper {Integer read(){return 7;}}} class Helper {int read(){return 7;}}'
    expect(inline(source).replacement).toBe('(int) helper.read()')
  })
})

function compileAndRun(source: string): string | null {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-inline-cast-types-'))
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

it('preserves compiled overloads, numeric values, unboxing, evaluation count and order in one matrix', (context) => {
  const cases = [
    ...mathArguments.map(([type, arguments_]) => [type, `Math.min(${arguments_})`]),
    ...mathArguments.map(([type, arguments_]) => [type, `Math.max(${arguments_})`]),
    ['long', 'Math.min(i, 9)'],
    ['float', 'Math.max(i, 9)'],
    ['double', 'Math.min(f, l)'],
    ['int', 'read(sink)'],
    ['long', 'read(sink)'],
    ['int', 'boxed()'],
    ['long', 'overloaded(i)'],
    ['byte', '1'],
    ['short', '2'],
    ['char', '65'],
    ['long', '1'],
    ['float', '16777217'],
    ['double', '1.1f'],
    ['int', '(int) 1.9'],
    ['long', '(int) 1.9'],
  ]
  const methods = cases.map(([type, expression], index) => `static void case${index}(Sink sink,int i,long l,float f,double d,byte b,short s,char c){${type} value${index}=${expression}; sink.append(value${index});}`)
  const source = `import java.util.Random; class Solution {
    static int calls;
    static class Sink {
      StringBuilder text=new StringBuilder();
      void append(byte x){text.append("byte:"+x+";");}
      void append(short x){text.append("short:"+x+";");}
      void append(char x){text.append("char:"+x+";");}
      void append(int x){text.append("int:"+x+";");}
      void append(long x){text.append("long:"+x+";");}
      void append(float x){text.append("float:"+x+";");}
      void append(double x){text.append("double:"+x+";");}
      void append(Integer x){text.append("boxed:"+x+";");}
    }
    static int read(Sink sink){calls++; sink.text.append("read;"); return 7;}
    static Integer boxed(){return 8;}
    static int overloaded(int x){return x;}
    static long overloaded(long x){return x;}
    static int choose(int n){return n;}
    static short choose(int[] n){return (short)n[0];}
    static void arrays(Sink sink,int numbers[]){int arrayValue=choose(numbers); sink.append(arrayValue);}
    static class Shadowed {
      static class Math {static short min(int a,int b){return (short)a;}}
      static void run(Sink sink){int shadowed=Math.min(7,9); sink.append(shadowed);}
    }
    static class Custom {short min(int a,int b){return (short)a;}}
    static void localMath(Sink sink){Custom Math=new Custom(); int localValue=Math.min(7,9); sink.append(localValue);}
    static class Base {static BoxedMath Math=new BoxedMath();}
    static class BoxedMath {Integer min(int a,int b){return a;}}
    static class Inherited extends Base {static void run(Sink sink){int inheritedValue=Math.min(7,9); sink.append(inheritedValue);}}
    static class Helper {int read(){return 7;}}
    static class Other {Integer read(){return 7;}}
    static class TypeBase {static class Helper {Integer read(){return 7;}}}
    static class InheritedTypes extends TypeBase {static void run(Sink sink,Helper helper){int inheritedTypeValue=helper.read(); sink.append(inheritedTypeValue);}}
    static <Helper extends Other> void generic(Sink sink,Helper helper){int genericValue=helper.read(); sink.append(genericValue);}
    static void imported(Sink sink,Random random){class Random {long nextInt(){return 7L;}} long importedValue=random.nextInt(); sink.append(importedValue);}
    static void boxedMath(Sink sink,Integer n){int boxedMathValue=Math.min(n,9); sink.append(boxedMathValue);}
    static void directBoxed(Sink sink,Integer n){int directBoxedValue=n; sink.append(directBoxedValue);}
    static void conditional(Sink sink,boolean flag,byte small,Integer boxed){
      int sameConditional=flag?read(sink):read(sink); sink.append(sameConditional);
      int narrowConditional=flag?small:1; sink.append(narrowConditional);
      int boxedConditional=flag?boxed:boxed; sink.append(boxedConditional);
      int mixedBoxedConditional=flag?boxed:1; sink.append(mixedBoxedConditional);
    }
    static String nullMath(Sink sink){Integer n=null; try {int mathNull=Math.min(n,9); sink.append(mathNull);} catch(NullPointerException error){return "math-null;";} return "unexpected;";}
    static String nullDirect(Sink sink){Integer n=null; try {int directNull=n; sink.append(directNull);} catch(NullPointerException error){return "direct-null;";} return "unexpected;";}
    static class Marker {
      String text="";
      void append(int n){text="hash-int;";}
      void append(long n){text="hash-long;";}
    }
    long hashCode(int n){return n;}
    String hashCase(){Marker sink=new Marker(); long hashValue=hashCode(); sink.append(hashValue); return sink.text;}
    ${methods.join('\n')}
    public static void main(String[] args){Sink sink=new Sink();
      ${cases.map((_, index) => `case${index}(sink,7,10L,1.1f,2.2,(byte)3,(short)4,'A');`).join('\n')}
      arrays(sink,new int[]{11}); Shadowed.run(sink); localMath(sink); Inherited.run(sink); generic(sink,new Other());
      imported(sink,new Random(42));
      InheritedTypes.run(sink,new TypeBase.Helper());
      boxedMath(sink,8); directBoxed(sink,8); conditional(sink,true,(byte)3,8);
      String nulls=nullMath(sink)+nullDirect(sink);
      System.out.print(sink.text+nulls+new Solution().hashCase()+"calls="+calls);
    }
  }`
  let output = source
  for (let index = 0; index < cases.length; index++) output = inline(output, `value${index}`).output
  output = inline(output, 'shadowed').output
  output = inline(output, 'localValue').output
  output = inline(output, 'arrayValue').output
  output = inline(output, 'inheritedValue').output
  output = inline(output, 'genericValue').output
  output = inline(output, 'hashValue').output
  output = inline(output, 'importedValue').output
  output = inline(output, 'inheritedTypeValue').output
  for (const name of ['boxedMathValue', 'directBoxedValue', 'sameConditional', 'narrowConditional', 'boxedConditional', 'mixedBoxedConditional', 'mathNull', 'directNull']) {
    output = inline(output, name).output
  }
  const before = compileAndRun(source)
  if (before === null) context.skip()
  expect(before).toContain('read;int:7;read;long:7;int:8;long:7;')
  expect(before).toContain('byte:1;short:2;char:A;long:1;float:1.6777216E7;double:1.100000023841858;')
  expect(before).toContain('int:11;int:7;int:7;int:7;int:7;long:-1170105035;int:7;int:8;int:8;read;int:7;int:3;int:8;int:8;math-null;direct-null;hash-long;calls=3')
  expect(before).not.toContain('boxed:')
  expect(compileAndRun(output)).toBe(before)
}, 20_000)

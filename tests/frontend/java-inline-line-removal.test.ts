import { describe, expect, it } from 'vitest'
import { planJavaFieldInlining } from '../../src/java-refactor/inline-field'

function inline(source: string): string {
  const result = planJavaFieldInlining(source, source.indexOf('value ='))
  if ('reason' in result) throw new Error(result.reason)
  return [...result.changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source)
}

describe('Inline declaration line removal', () => {
  it.each(['\n', '\r\n'])('removes an array declaration together with its indentation and %j newline', (newline) => {
    const source = ['class Solution {', '  void test() {', '    int[] value = {1, 2};', '    use(value);', '  }', '}'].join(newline)
    expect(inline(source)).toBe(['class Solution {', '  void test() {', '    use(new int[] {1, 2});', '  }', '}'].join(newline))
  })

  it.each(['    ', '\t\t'])('removes a scalar declaration and trailing whitespace with %j indentation', (indentation) => {
    const source = `class Solution {\n  int f() {\n${indentation}int value = 7; \t\n${indentation}return value;\n  }\n}`
    expect(inline(source)).toBe(`class Solution {\n  int f() {\n${indentation}return (7);\n  }\n}`)
  })

  it('preserves intentional surrounding blank lines and standalone comments', () => {
    const source = 'class Solution {\n  int f() {\n\n    // before\n    int value = 7;\n\n    // after\n    return value;\n  }\n}'
    expect(inline(source)).toBe('class Solution {\n  int f() {\n\n    // before\n\n    // after\n    return (7);\n  }\n}')
  })

  it.each(['// keep', '/* keep */'])('preserves a trailing comment: %s', (comment) => {
    const source = `class Solution {\n  int f() {\n    int value = 7; ${comment}\n    return value;\n  }\n}`
    expect(inline(source)).toBe(`class Solution {\n  int f() {\n     ${comment}\n    return (7);\n  }\n}`)
  })

  it('preserves an internal declaration comment on its line', () => {
    const source = 'class Solution {\n  int f() {\n    int /* keep */ value = 7;\n    return value;\n  }\n}'
    expect(inline(source)).toBe('class Solution {\n  int f() {\n    /* keep */ \n    return (7);\n  }\n}')
  })

  it('removes all occupied lines of a multiline array declaration', () => {
    const source = 'class Solution {\n  void test() {\n    int[] value = {\n      1, 2\n    };\n    use(value);\n  }\n}'
    expect(inline(source)).toBe('class Solution {\n  void test() {\n    use(new int[] {\n      1, 2\n    });\n  }\n}')
  })

  it.each([
    ['class Solution { int f() { int value = 7; return value; } }', 'class Solution { int f() {  return (7); } }'],
    ['class Solution {\n  int f() {\n    int value = 7; return value;\n  }\n}', 'class Solution {\n  int f() {\n     return (7);\n  }\n}'],
    ['class Solution {\n  int f() { int value = 7;\n    return value;\n  }\n}', 'class Solution {\n  int f() { \n    return (7);\n  }\n}'],
  ])('preserves sibling code on either side of a declaration', (source, expected) => {
    expect(inline(source)).toBe(expected)
  })

  it('preserves other declarators on the same line', () => {
    const source = 'class Solution {\n  int f() {\n    int value = 7, other = 3;\n    return value + other;\n  }\n}'
    expect(inline(source)).toBe('class Solution {\n  int f() {\n    int  other = 3;\n    return (7) + other;\n  }\n}')
  })
})

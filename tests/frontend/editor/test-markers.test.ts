import { describe, expect, it } from 'vitest'
import {
  buildTestRunMarkers,
  findJavaTestMethodAt,
  findJavaTestMethodMarkers,
  testRunShortcutLabel,
} from '../../../src/editor'
import { renderJavaProblemSource } from '../../../src/domain/template'
import { findBareJavaTest } from '../../../src/editor/test-markers'
import { javaState } from './helpers'

describe('Java test method lookup', () => {
  it('finds a test from its annotation, declaration, or nested body', () => {
    const source = [
      'class Solution {',
      '    @Test',
      '    public void test1() {',
      '        if (true) {',
      '            String brace = "}";',
      '        }',
      '    }',
      '    @Test',
      '    public void test2() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('@Test') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('test1') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('String brace') + 2)).toBe('test1')
    expect(findJavaTestMethodAt(state, source.indexOf('test2') + 2)).toBe('test2')
  })

  it('returns null between methods and outside test methods', () => {
    const source = [
      'class Solution {',
      '    @Test void test1() {}',
      '',
      '    void helper() {}',
      '',
      '    @Test void test2() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('helper'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('helper()') + 'helper()'.length)).toBeNull()
    const gapBeforeTest2 = source.indexOf('\n\n    @Test', source.indexOf('helper')) + 1
    expect(findJavaTestMethodAt(state, gapBeforeTest2)).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('}') + 1)).toBeNull()
  })

  it('ignores annotation-looking text in comments and strings', () => {
    const source = [
      'class Solution {',
      '    // @Test void fakeComment() {}',
      '    String text = "@Test void fakeString() {}";',
      '    @Test void actual_test() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('fakeComment'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('fakeString'))).toBeNull()
    expect(findJavaTestMethodAt(state, source.indexOf('actual_test') + 2)).toBe('actual_test')
  })

  it('supports qualified Test annotations and keeps Java identifier names intact', () => {
    const source = [
      'class Solution {',
      '    @org.junit.jupiter.api.Test',
      '    void test_2$() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodAt(state, source.indexOf('junit'))).toBe('test_2$')
  })

  it('extracts one gutter marker per real test annotation and skips comments, strings, and helpers', () => {
    const source = [
      'class Solution {',
      '    // @Test void fakeComment() {}',
      '    String text = "@Test void fakeString() {}";',
      '    @DisplayName("qualified")',
      '    @org.junit.jupiter.api.Test',
      '    void test_2$() {}',
      '    void helper() {}',
      '    @Test void testInline() {}',
      '    @Test void 테스트() {}',
      '}',
    ].join('\n')
    const state = javaState(source)

    expect(findJavaTestMethodMarkers(state)).toEqual([
      {
        methodName: 'test_2$',
        from: source.lastIndexOf('\n', source.indexOf('@org.junit.jupiter.api.Test')) + 1,
        line: 5,
      },
      {
        methodName: 'testInline',
        from: source.lastIndexOf('\n', source.indexOf('@Test void testInline')) + 1,
        line: 8,
      },
      {
        methodName: '테스트',
        from: source.lastIndexOf('\n', source.indexOf('@Test void 테스트')) + 1,
        line: 9,
      },
    ])
  })

  it('recomputes marker positions after document edits and builds sorted gutter ranges', () => {
    const source = [
      'class Solution {',
      '    @Test void first() {}',
      '}',
    ].join('\n')
    const state = javaState(source)
    const inserted = state.update({
      changes: { from: 0, insert: '// heading\n' },
    }).state
    const markers = findJavaTestMethodMarkers(inserted)

    expect(markers).toEqual([{
      methodName: 'first',
      from: inserted.doc.line(3).from,
      line: 3,
    }])
    const gutterMarkers = buildTestRunMarkers(markers, 'Ctrl+R')
    const cursor = gutterMarkers.iter()
    expect(gutterMarkers.size).toBe(1)
    expect(cursor.from).toBe(markers[0].from)
    expect(cursor.to).toBe(markers[0].from)
    cursor.next()
    expect(cursor.value).toBeNull()
  })

  it('uses the platform-specific selected-test shortcut label', () => {
    expect(testRunShortcutLabel('other')).toBe('Ctrl+Shift+R')
    expect(testRunShortcutLabel('mac')).toBe('⌃⇧R')
  })
})

describe('bare test stub lookup', () => {
  const withBody = (body: string, annotation = '@Test') => (
    `class Solution {\n    ${annotation}\n    public void test() {${body}}\n}\n`
  )

  it.each([
    ['the template statement without a semicolon', '\n        assertThat()\n    '],
    ['the statement with a semicolon', '\n        assertThat();\n    '],
    ['spaces inside the statement', ' assertThat ( ) ; '],
    ['an empty body', ''],
    ['a blank body', '\n\n    '],
  ])('treats %s as bare and returns the range between the braces', (_label, body) => {
    const source = withBody(body)
    const from = source.indexOf('test() {') + 'test() {'.length
    expect(findBareJavaTest(source)).toEqual({
      status: 'bare',
      body: { from, to: from + body.length },
    })
  })

  it('finds the stub in the generated problem template', () => {
    const source = renderJavaProblemSource('example', 'Q1Example', 'public int example(int[] nums) {')
    const lookup = findBareJavaTest(source)
    expect(lookup.status).toBe('bare')
    if (lookup.status === 'bare') {
      expect(source.slice(lookup.body.from, lookup.body.to)).toBe('\n        assertThat()\n    ')
    }
  })

  it.each([
    ['a line comment', ' // keep\n '],
    ['a block comment', ' /* keep */ '],
    ['a comment after the statement', ' assertThat() // keep\n '],
    ['a comment between the call and its semicolon', ' assertThat() /* keep */ ; '],
    ['a comment inside the arguments', ' assertThat(/* keep */) '],
    ['a partial assertion', ' assertThat(x) '],
    ['an unfinished argument list', ' assertThat( '],
    ['a chained assertion', ' assertThat().isEqualTo(1); '],
    ['a qualified call', ' Assertions.assertThat(); '],
    ['another method name', ' assertThatCode(); '],
    ['two stubs', ' assertThat(); assertThat(); '],
    ['an extra empty statement', ' assertThat();; '],
    ['a lone empty statement', ' ; '],
    ['a local declaration', ' int x = 1; '],
    ['an empty inner block', ' {} '],
  ])('treats %s as filled', (_label, body) => {
    expect(findBareJavaTest(withBody(body))).toEqual({ status: 'filled' })
  })

  it('accepts a qualified @Test and ignores other method names and non-test methods', () => {
    expect(findBareJavaTest(withBody('', '@org.junit.jupiter.api.Test')).status).toBe('bare')
    expect(findBareJavaTest(withBody('', '@Disabled'))).toEqual({ status: 'missing' })
    expect(findBareJavaTest('class S {\n    @Test void test2() {}\n    @Test void testing() {}\n}'))
      .toEqual({ status: 'missing' })
    expect(findBareJavaTest('class S {\n    @Test void test2() { x(); }\n    @Test void test() {}\n}').status)
      .toBe('bare')
  })

  it('ignores a test method named only in a comment or a string', () => {
    const source = 'class S {\n    // @Test void test() {}\n    String s = "@Test void test() {}";\n}'
    expect(findBareJavaTest(source)).toEqual({ status: 'missing' })
  })

  it('treats a body it cannot trust as filled', () => {
    expect(findBareJavaTest('abstract class S {\n    @Test abstract void test();\n}')).toEqual({ status: 'filled' })
    expect(findBareJavaTest('class S {\n    @Test void test() {\n        assertThat()\n'))
      .toEqual({ status: 'filled' })
    expect(findBareJavaTest('class S {\n    @Test void test() {}\n    class T { @Test void test() {} }\n}'))
      .toEqual({ status: 'filled' })
  })

  it('still finds the stub beside a syntax error in another method', () => {
    const source = 'class S {\n    int a() { int x = ; }\n    @Test void test() {\n        assertThat()\n    }\n}'
    expect(findBareJavaTest(source).status).toBe('bare')
  })
})

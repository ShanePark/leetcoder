import { describe, expect, it } from 'vitest'
import {
  buildTestRunMarkers,
  findJavaTestMethodAt,
  findJavaTestMethodMarkers,
  testRunShortcutLabel,
} from '../../../src/editor'
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

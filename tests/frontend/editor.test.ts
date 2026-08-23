import { describe, expect, it } from 'vitest'

import {
  formatJavaDocClipboard,
  isJavaDocAltShortcut,
  planJavaDocInsertion,
} from '../../src/editor'

describe('JavaDoc editor helpers', () => {
  it('plans an indented JavaDoc above a class and places the cursor after the body prefix', () => {
    const source = 'package demo;\n\n    public class Solution {\n}'
    const position = source.indexOf('Solution')
    const edit = planJavaDocInsertion(source, position)

    expect(edit).toEqual({
      from: source.indexOf('    public class'),
      insert: '    /**\n     * \n     */\n',
      cursor: source.indexOf('    public class') + '    /**\n     * '.length,
    })
  })

  it('preserves CRLF line endings', () => {
    const source = 'public class Solution {\r\n}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('/**\r\n * \r\n */\r\n')
  })

  it('uses the class line separator when a source contains mixed line endings', () => {
    const source = 'package demo;\npublic class Solution {\r\n}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('/**\r\n * \r\n */\r\n')
  })

  it('does nothing when the cursor is not on a class declaration line', () => {
    const source = 'public class Solution {\n    void solve() {}\n}'

    expect(planJavaDocInsertion(source, source.indexOf('solve'))).toBeNull()
    expect(planJavaDocInsertion('// class Ignored {}', 3)).toBeNull()
  })

  it('does not treat a class-looking line inside a block comment as a declaration', () => {
    const source = '/*\nclass Fake {}\n*/\nclass Real {}'

    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('does not treat a class-looking line inside a Java text block as a declaration', () => {
    const source = 'String text = """\nThis contains a " quote\nclass Fake {}\n""";\nclass Real {}'

    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('keeps escaped triple quotes inside a Java text block', () => {
    const source = 'String text = """\nescaped \\"""\nclass Fake {}\n""";\nclass Real {}'

    expect(source).toContain('escaped \\"""')
    expect(planJavaDocInsertion(source, source.indexOf('Fake'))).toBeNull()
    expect(planJavaDocInsertion(source, source.indexOf('Real'))?.insert).toBe('/**\n * \n */\n')
  })

  it('matches only the exact Shift+Option+J shortcut', () => {
    const shortcut = { code: 'KeyJ', shiftKey: true, altKey: true, metaKey: false, ctrlKey: false }

    expect(isJavaDocAltShortcut(shortcut)).toBe(true)
    expect(isJavaDocAltShortcut({ ...shortcut, code: 'KeyK' })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, shiftKey: false })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, metaKey: true })).toBe(false)
    expect(isJavaDocAltShortcut({ ...shortcut, ctrlKey: true })).toBe(false)
  })

  it('does not create a duplicate and targets an existing JavaDoc body', () => {
    const source = '/**\n * Existing description\n */\npublic class Solution {}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('')
    expect(edit?.cursor).toBe(source.indexOf('Existing description'))
  })

  it('recognizes a compact JavaDoc immediately above the class', () => {
    const source = '/** Existing description */\nclass Solution {}'
    const edit = planJavaDocInsertion(source, source.indexOf('Solution'))

    expect(edit?.insert).toBe('')
    expect(edit?.cursor).toBe(source.indexOf('Existing description'))
  })

  it('formats multiline JavaDoc clipboard input with the current prefix', () => {
    const source = '/**\n * |\n */\npublic class Solution {}'
    const position = source.indexOf('|')
    const document = source.replace('|', '')

    expect(formatJavaDocClipboard('Runtime\r\n0\r\nms\r\nBeats\r\n100.00%\r\n', document, position))
      .toBe('Runtime\n * 0\n * ms\n * Beats\n * 100.00%')
  })

  it('preserves internal blank lines while removing trailing newlines', () => {
    const source = '/**\n * text\n */\nclass Solution {}'
    const position = source.indexOf('text') + 4

    expect(formatJavaDocClipboard('one\n\ntwo\n\n', source, position))
      .toBe('one\n * \n * two')
  })

  it('leaves ordinary code, non-JavaDoc comments, and single-line pastes unchanged', () => {
    const code = 'class Solution {\n    String value;\n}'
    expect(formatJavaDocClipboard('a\nb', code, code.indexOf('value'))).toBe('a\nb')

    const blockComment = '/*\n * text\n */\nclass Solution {}'
    expect(formatJavaDocClipboard('a\nb', blockComment, blockComment.indexOf('text') + 4)).toBe('a\nb')

    const javaDoc = '/**\n * text\n */\nclass Solution {}'
    const position = javaDoc.indexOf('text') + 4
    expect(formatJavaDocClipboard('single line', javaDoc, position)).toBe('single line')
  })
})

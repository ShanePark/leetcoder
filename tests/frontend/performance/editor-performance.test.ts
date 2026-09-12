import { describe, expect, it } from 'vitest'

import { maskJavaCommentsAndLiterals } from '../../../src/completions/source'
import { removeUnusedJavaTypeImports } from '../../../src/java-format'

function legacyMaskJavaCommentsAndLiterals(source: string): string {
  const chars = source.split('')
  let state: 'normal' | 'lineComment' | 'blockComment' | 'string' | 'char' | 'textBlock' = 'normal'
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]
    if (state === 'lineComment') {
      if (current === '\n' || current === '\r') state = 'normal'
      else chars[index] = ' '
      continue
    }
    if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'string' || state === 'char') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
        chars[index] = ' '
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'textBlock') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
        chars[index] = ' '
        chars[index + 1] = ' '
        chars[index + 2] = ' '
        index += 2
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (current === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'lineComment'
    } else if (current === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'blockComment'
    } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
      chars[index] = '\u0001'
      chars[index + 1] = ' '
      chars[index + 2] = ' '
      index += 2
      state = 'textBlock'
    } else if (current === '"') {
      chars[index] = '\u0001'
      state = 'string'
    } else if (current === "'") {
      chars[index] = '\u0001'
      state = 'char'
    }
  }
  return chars.join('')
}

describe('editor performance regressions', () => {
  it('keeps masking output and UTF-16 offsets identical across literal/comment forms', () => {
    const sources = [
      'class S { String value = "a\\\"b"; /* block\r\ncomment */ int x; }',
      'class S { char c = \'\\\'\'; // line comment\r\n String text = "emoji 😀"; }',
      'class S { String text = """\n  escaped \\\"""\n  😀\n"""; }',
      'class S { /* unclosed 😀\n String fake; ',
      'class S { String fake = "unclosed 😀\n int value; ',
    ]
    for (const source of sources) {
      const actual = maskJavaCommentsAndLiterals(source)
      expect(actual).toBe(legacyMaskJavaCommentsAndLiterals(source))
      expect(actual.length).toBe(source.length)
    }
  })

  it('keeps a catalog import when a longer hand-written type contains its name', () => {
    const source = [
      'import custom.List$Extra;',
      'import java.util.List;',
      '',
      'class S { List$Extra value; }',
      '',
    ].join('\n')
    expect(removeUnusedJavaTypeImports(source)).toContain('import java.util.List;')
  })
})

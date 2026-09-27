import { matchBrackets, type MatchResult } from '@codemirror/language'
import { describe, expect, it } from 'vitest'
import { renderJavaBracketMatch } from '../../../src/editor/bracket-matching'
import { javaState } from './helpers'

function matchAt(
  source: string,
  bracket: string,
  from = 0,
  direction: -1 | 1 = 1,
): { match: MatchResult; state: ReturnType<typeof javaState> } {
  const state = javaState(source)
  const position = source.indexOf(bracket, from)
  expect(position).toBeGreaterThanOrEqual(0)
  const cursorPosition = position + (direction < 0 ? bracket.length : 0)
  const match = matchBrackets(state, cursorPosition, direction)
  if (!match) {
    throw new Error(`No bracket match result at ${cursorPosition}`)
  }
  return { match, state }
}

describe('Java bracket matching', () => {
  it('does not render matched or unmatched brackets inside literals', () => {
    const cases = [
      { source: 'String value = "()";', bracket: '(', matched: true },
      { source: String.raw`String value = "\"()\"";`, bracket: '(', matched: true },
      { source: 'String value = "()";', bracket: ')', direction: -1, matched: true },
      { source: 'String value = "{";', bracket: '{', matched: false },
      { source: "char value = '(';", bracket: '(', matched: false },
      { source: 'String value = """\n()\n""";', bracket: '(', matched: true },
    ]

    for (const testCase of cases) {
      const { match, state } = matchAt(testCase.source, testCase.bracket, 0, testCase.direction ?? 1)
      expect(match.matched, testCase.source).toBe(testCase.matched)
      expect(renderJavaBracketMatch(match, state), testCase.source).toEqual([])
    }
  })

  it('keeps code parentheses matched when a string literal contains a parenthesis', () => {
    const source = 'assertThat("(")'
    const open = source.indexOf('(')
    const close = source.lastIndexOf(')')
    const { match, state } = matchAt(source, '(', open)

    expect(match).toMatchObject({
      matched: true,
      end: { from: close, to: close + 1 },
    })
    expect(renderJavaBracketMatch(match, state).map((range) => ({
      from: range.from,
      to: range.to,
      className: range.value.spec.class,
    }))).toEqual([
      { from: open, to: open + 1, className: 'cm-matchingBracket' },
      { from: close, to: close + 1, className: 'cm-matchingBracket' },
    ])
  })

  it('keeps unmatched code brackets marked after skipping a string literal', () => {
    const source = 'call("(" + value'
    const open = source.indexOf('(')
    const { match, state } = matchAt(source, '(', open)

    expect(match.matched).toBe(false)
    expect(renderJavaBracketMatch(match, state).map((range) => ({
      from: range.from,
      to: range.to,
      className: range.value.spec.class,
    }))).toEqual([
      { from: open, to: open + 1, className: 'cm-nonmatchingBracket' },
    ])
  })
})

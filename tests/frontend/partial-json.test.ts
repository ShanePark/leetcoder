import { describe, expect, it } from 'vitest'

import { parsePartialJson } from '../../src/partial-json'

describe('parsePartialJson', () => {
  it('parses a whole document as JSON.parse does', () => {
    const document = {
      verdict: 'incorrect',
      summary: 'Quote " slash \\ tab \t line\n unicode é 😀',
      failureCause: null,
      issues: ['a', 'b'],
      missedCases: [{ input: '[3,3]', reason: 'dup' }],
      efficiency: { time: 'O(n)', space: 'O(1)', assessment: '' },
      flags: [true, false, -1.5e3, 0],
    }
    const text = JSON.stringify(document, null, 2)
    expect(parsePartialJson(text)).toEqual(JSON.parse(text))
  })

  it('returns nothing before a value starts', () => {
    expect(parsePartialJson('')).toBeUndefined()
    expect(parsePartialJson('  \n')).toBeUndefined()
  })

  it('keeps an open string and closes open containers where the text stops', () => {
    expect(parsePartialJson('{"summary":"The ind')).toEqual({ summary: 'The ind' })
    expect(parsePartialJson('{"issues":["one","tw')).toEqual({ issues: ['one', 'tw'] })
    expect(parsePartialJson('{"efficiency":{"time":"O(n)","space":"O(')).toEqual({
      efficiency: { time: 'O(n)', space: 'O(' },
    })
    expect(parsePartialJson('[')).toEqual([])
    expect(parsePartialJson('{')).toEqual({})
  })

  it('leaves out a key without a value and a dangling comma', () => {
    expect(parsePartialJson('{"verdict":"correct","summ')).toEqual({ verdict: 'correct' })
    expect(parsePartialJson('{"verdict":"correct","summary"')).toEqual({ verdict: 'correct' })
    expect(parsePartialJson('{"verdict":"correct","summary":')).toEqual({ verdict: 'correct' })
    expect(parsePartialJson('{"verdict":"correct",')).toEqual({ verdict: 'correct' })
    expect(parsePartialJson('{"issues":["a",')).toEqual({ issues: ['a'] })
  })

  it('leaves out a literal or number that could still grow', () => {
    expect(parsePartialJson('{"failureCause":nu')).toEqual({})
    // A whole literal cannot grow, so it counts at once.
    expect(parsePartialJson('{"failureCause":null')).toEqual({ failureCause: null })
    expect(parsePartialJson('[tr')).toEqual([])
    expect(parsePartialJson('[1')).toEqual([])
    expect(parsePartialJson('[12,')).toEqual([12])
    expect(parsePartialJson('[-')).toEqual([])
  })

  it('drops a cut escape instead of showing half of it', () => {
    expect(parsePartialJson('["a\\')).toEqual(['a'])
    expect(parsePartialJson('["a\\u00')).toEqual(['a'])
    expect(parsePartialJson('["a\\n')).toEqual(['a\n'])
    expect(parsePartialJson('["a\\ud83d')).toEqual(['a'])
    expect(parsePartialJson('["a\\ud83d\\ude00')).toEqual(['a😀'])
  })

  it('reads every prefix of a document, each showing at least the complete fields of the one before', () => {
    const document = { verdict: 'correct', summary: 'Two "pointers"', issues: ['x', 'y'], efficiency: { time: 'O(n)' } }
    const text = JSON.stringify(document)
    let fields = 0
    for (let end = 1; end <= text.length; end += 1) {
      const parsed = parsePartialJson(text.slice(0, end)) as Record<string, unknown>
      expect(parsed).toBeTypeOf('object')
      expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(fields)
      fields = Object.keys(parsed).length
    }
    expect(parsePartialJson(text)).toEqual(document)
  })

  it('returns nothing for text that is not JSON', () => {
    for (const text of ['x', '{a', '{"a" 1', '{"a":1 "b"', '[1 2]', '{"a":1,}', '"\\q"', '"\\uZZZZ"', '{"a":1}x', 'nulx']) {
      expect(parsePartialJson(text)).toBeUndefined()
    }
  })
})

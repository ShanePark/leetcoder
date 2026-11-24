import { describe, expect, it } from 'vitest'

import { lineDocumentChanges } from '../../src/editor/editing'
import { diffLines, lineDiffStats, splitLines } from '../../src/line-diff'

function apply(before: string, changes: Array<{ from: number; to: number; insert: string }>): string {
  let text = before
  for (const change of [...changes].reverse()) {
    text = text.slice(0, change.from) + change.insert + text.slice(change.to)
  }
  return text
}

describe('line diff', () => {
  it('splits text into lines that keep their breaks', () => {
    expect(splitLines('a\nb\r\nc')).toEqual(['a\n', 'b\r\n', 'c'])
    expect(splitLines('a\n')).toEqual(['a\n'])
    expect(splitLines('')).toEqual([])
  })

  it('aligns unchanged lines and lists each run as deletions then insertions', () => {
    const entries = diffLines('a\nb\nc\nd\n', 'a\nB\nX\nc\nd\ne\n')
    expect(entries).toEqual([
      { kind: 'equal', line: 'a\n' },
      { kind: 'delete', line: 'b\n' },
      { kind: 'insert', line: 'B\n' },
      { kind: 'insert', line: 'X\n' },
      { kind: 'equal', line: 'c\n' },
      { kind: 'equal', line: 'd\n' },
      { kind: 'insert', line: 'e\n' },
    ])
    expect(lineDiffStats(entries)).toEqual({ added: 3, removed: 1 })
  })

  it('handles empty sides and identical text', () => {
    expect(diffLines('', 'a\n')).toEqual([{ kind: 'insert', line: 'a\n' }])
    expect(diffLines('a\n', '')).toEqual([{ kind: 'delete', line: 'a\n' }])
    expect(lineDiffStats(diffLines('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 })
  })

  it('a missing final line break changes the last line', () => {
    expect(diffLines('a\nb\n', 'a\nb')).toEqual([
      { kind: 'equal', line: 'a\n' },
      { kind: 'delete', line: 'b\n' },
      { kind: 'insert', line: 'b' },
    ])
  })

  it('turns the diff into document changes that touch only the differing runs', () => {
    const before = 'class A {\n  int x;\n  void f() {\n    x++;\n  }\n}\n'
    const after = 'class A {\n  // note\n  int x;\n  void f() {\n    ++x;\n  }\n}\n'
    const changes = lineDocumentChanges(before, after)
    expect(changes).toEqual([
      { from: 10, to: 10, insert: '  // note\n' },
      { from: 36, to: 39, insert: '++x' },
    ])
    expect(apply(before, changes)).toBe(after)
    expect(lineDocumentChanges(before, before)).toEqual([])
  })
})

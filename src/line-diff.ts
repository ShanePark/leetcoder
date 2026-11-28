export type LineDiffKind = 'equal' | 'delete' | 'insert'

/** One line of a line diff, with its line break when it has one. */
export interface LineDiffEntry {
  kind: LineDiffKind
  line: string
}

/** Lines that keep their `\n`, so joining them gives the text back. */
export function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/).filter((line) => line !== '')
}

/**
 * The lines of `before` and `after`, aligned by a longest common subsequence of
 * lines. Each run of differing lines lists its deleted lines before its
 * inserted ones.
 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const a = splitLines(before)
  const b = splitLines(after)
  // common[i][j] is the LCS length of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1])
    }
  }
  const entries: LineDiffEntry[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      entries.push({ kind: 'equal', line: a[i] })
      i += 1
      j += 1
      continue
    }
    const inserted: LineDiffEntry[] = []
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break
      if (j >= b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) {
        entries.push({ kind: 'delete', line: a[i++] })
      } else {
        inserted.push({ kind: 'insert', line: b[j++] })
      }
    }
    entries.push(...inserted)
  }
  return entries
}

export function lineDiffStats(entries: readonly LineDiffEntry[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const entry of entries) {
    if (entry.kind === 'insert') added += 1
    else if (entry.kind === 'delete') removed += 1
  }
  return { added, removed }
}

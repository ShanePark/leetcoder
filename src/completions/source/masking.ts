/**
 * Keep source offsets stable while hiding comments and literals from the
 * lightweight Java scanners below. This prevents strings from looking like
 * declarations or clickable calls.
 */
export function maskJavaCommentsAndLiterals(source: string): string {
  // Keep source offsets in UTF-16 code units, as CodeMirror does. Record only
  // masked runs, then assemble the unchanged source around them so ordinary
  // completion requests avoid a full per-character copy.
  const maskedRanges: Array<{ from: number; to: number; literal: boolean }> = []
  let index = 0
  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]
    if (current === '/' && next === '/') {
      const from = index
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      maskedRanges.push({ from, to: index, literal: false })
      continue
    }
    if (current === '/' && next === '*') {
      const from = index
      index += 2
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2
          break
        }
        index += 1
      }
      maskedRanges.push({ from, to: index, literal: false })
      continue
    }
    if (current === '"' && next === '"' && source[index + 2] === '"') {
      const from = index
      index += 3
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 1
          if (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
          continue
        }
        if (source[index] === '"' && source[index + 1] === '"' && source[index + 2] === '"') {
          index += 3
          break
        }
        index += 1
      }
      maskedRanges.push({ from, to: index, literal: true })
      continue
    }
    if (current === '"' || current === "'") {
      const quote = current
      const from = index
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 1
          if (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      maskedRanges.push({ from, to: index, literal: true })
      continue
    }
    index += 1
  }

  if (maskedRanges.length === 0) return source

  const maskRange = (range: typeof maskedRanges[number]): string => {
    const value = source.slice(range.from, range.to).replace(/[^\r\n]/g, ' ')
    return range.literal ? `\u0001${value.slice(1)}` : value
  }
  const parts: string[] = []
  let cursor = 0
  for (const range of maskedRanges) {
    parts.push(source.slice(cursor, range.from), maskRange(range))
    cursor = range.to
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

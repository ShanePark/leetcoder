export interface ProjectSearchLocation {
  readonly line: number
  readonly column: number
}

/** Find the current UTF-16 location of a literal, case-insensitive query. */
export function findProjectSearchLocation(
  source: string,
  query: string,
): ProjectSearchLocation | null {
  const foldedQuery = query.toLowerCase()
  if (!foldedQuery) {
    return null
  }

  const lines = source.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const foldedOffset = line.toLowerCase().indexOf(foldedQuery)
    if (foldedOffset >= 0) {
      return {
        line: lineIndex + 1,
        column: originalColumnForFoldedOffset(line, foldedOffset),
      }
    }
  }

  return null
}

function originalColumnForFoldedOffset(line: string, foldedOffset: number): number {
  let foldedColumn = 0
  let sourceColumn = 1
  for (const character of line) {
    const foldedLength = character.toLowerCase().length
    if (foldedOffset < foldedColumn + foldedLength) {
      return sourceColumn
    }
    foldedColumn += foldedLength
    sourceColumn += character.length
  }
  return sourceColumn
}

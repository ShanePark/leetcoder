import type { ProjectSearchMatch, ProjectSearchResult } from '../contracts'
import { isRecord } from './common'

export function normalizeProjectSearchResult(value: unknown): ProjectSearchResult {
  if (
    !isRecord(value)
    || !Array.isArray(value.matches)
    || typeof value.truncated !== 'boolean'
    || !isNonNegativeInteger(value.skippedFiles)
  ) {
    throw new Error('The project search response was invalid.')
  }

  const matches = value.matches.map((match): ProjectSearchMatch => {
    if (
      !isRecord(match)
      || typeof match.path !== 'string'
      || !isPositiveInteger(match.line)
      || !isPositiveInteger(match.column)
      || typeof match.preview !== 'string'
    ) {
      throw new Error('The project search result contained an invalid match.')
    }
    return {
      path: match.path,
      line: match.line,
      column: match.column,
      preview: match.preview,
    }
  })

  return {
    matches,
    truncated: value.truncated,
    skippedFiles: value.skippedFiles,
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

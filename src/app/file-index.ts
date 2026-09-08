import type { ProblemFileEntry } from '../backend'
import { normalizeSourcePath } from './path-helpers'

/**
 * Index problem files by the same canonical path key used by sameFilePath.
 * The first entry wins so lookups preserve Array.find's existing semantics
 * when a backend reports equivalent paths more than once.
 */
export function indexProblemFiles(
  files: readonly ProblemFileEntry[],
): Map<string, ProblemFileEntry> {
  const index = new Map<string, ProblemFileEntry>()
  for (const file of files) {
    const key = normalizeSourcePath(file.path)
    if (!index.has(key)) {
      index.set(key, file)
    }
  }
  return index
}

export function findIndexedProblemFile(
  index: ReadonlyMap<string, ProblemFileEntry>,
  path: string,
): ProblemFileEntry | undefined {
  return index.get(normalizeSourcePath(path))
}

import type { ProblemFileContent, ProblemFileEntry, RepositoryFilesChanged } from '../contracts'
import { isRecord, stringValue } from './common'

export function normalizeRepositoryFilesChanged(payload: unknown): RepositoryFilesChanged | null {
  if (!isRecord(payload) || !Array.isArray(payload.paths)) {
    return null
  }
  const paths = payload.paths.filter((path): path is string => typeof path === 'string')
  if (paths.length === 0) {
    return null
  }
  return { paths, structural: payload.structural === true }
}

export function normalizeProblemFiles(value: unknown): ProblemFileEntry[] {
  const rawFiles = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.files ?? value.paths ?? value.entries
      : undefined

  if (!Array.isArray(rawFiles)) {
    throw new Error('The repository file-list response was invalid.')
  }

  return rawFiles
    .map((file) => {
      if (typeof file === 'string') {
        return createFileEntry(file)
      }
      if (!isRecord(file)) {
        return null
      }
      const path = stringValue(file.path) ?? stringValue(file.relativePath) ?? stringValue(file.relative_path)
      return path ? createFileEntry(path) : null
    })
    .filter((file): file is ProblemFileEntry => file !== null)
    // Keep Kotlin entries in the result: the domain uses both Java and Kotlin
    // source names when choosing a collision-free suffix. The sidebar filters
    // this list to Java files at render time.
    .filter((file) => /\.(?:java|kt)$/i.test(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
}

export function normalizeProblemFileContent(value: unknown, operation: 'duplicate' | 'rename'): ProblemFileContent {
  if (!isRecord(value)) {
    throw new Error(`The file ${operation} response was invalid.`)
  }
  const relativePath = stringValue(value.relativePath)
    ?? stringValue(value.relative_path)
    ?? stringValue(value.path)
  const content = stringValue(value.content) ?? stringValue(value.source)
  if (!relativePath || content === undefined) {
    throw new Error(`The file ${operation} response was missing path or source content.`)
  }
  return { relativePath, content }
}

export function normalizeProblemFileSource(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (isRecord(value)) {
    const content = value.content ?? value.source
    if (typeof content === 'string') {
      return content
    }
  }
  throw new Error('The selected file did not contain readable source text.')
}

export function createFileEntry(path: string): ProblemFileEntry {
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const packageMatch = /(?:^|\/)(easy|medium|xhard)(?:\/|$)/i.exec(normalized)
  const packageSegment = packageMatch
    ? (packageMatch[1].toLowerCase() as ProblemFileEntry['packageSegment'])
    : 'other'
  return { path, name, packageSegment }
}

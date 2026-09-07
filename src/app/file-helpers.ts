import { classNameFromProblem } from '../domain'
import type { DailyProblem, ProblemFileEntry } from '../backend'
import type { GitChangedFile } from './types'
import {
  gitDirectoryPath,
  normalizeSourcePath,
  sameFilePath,
} from './path-helpers'

export function filterProblemFiles(files: ProblemFileEntry[], query: string): ProblemFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return files
  }
  return files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
}

export function filterProblemFilesByGroup(
  files: ProblemFileEntry[],
  group: ProblemFileEntry['packageSegment'],
  query: string,
): ProblemFileEntry[] {
  return filterProblemFiles(files, query).filter((file) => file.packageSegment === group)
}

/**
 * Find the sidebar entry that already solves today's problem: the class name
 * must be the problem's base class name or the base name plus a numeric
 * collision suffix (the repository convention for repeat solves).
 */
export function findTodayProblemFile(
  files: ProblemFileEntry[],
  problem: Pick<DailyProblem, 'frontendId' | 'title'>,
): ProblemFileEntry | null {
  let base: string
  try {
    base = classNameFromProblem(problem.frontendId, problem.title)
  } catch {
    return null
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}\\d*$`)
  return files.find((file) => /\.java$/i.test(file.path)
    && pattern.test(file.name.replace(/\.java$/i, ''))) ?? null
}

/** Return a safe Java basename, adding `.java` when the user omits it. */
export function normalizeJavaFileName(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    return null
  }
  const withExtension = /\.java$/i.test(trimmed) ? trimmed : `${trimmed}.java`
  if (!/^[^<>:"|?*\u0000-\u001f]+\.java$/i.test(withExtension)) {
    return null
  }
  return withExtension
}

export function deleteFileConfirmationMessage(fileName: string): string {
  return `Delete ${fileName}?\n\nThis cannot be undone.`
}

/**
 * Produces the next collision-free duplicate name used by the file explorer.
 * Numeric suffixes are appended immediately before the extension, matching
 * the repository's `Q123Problem2.java`, `Q123Problem3.java` convention.
 */
export function duplicateFileName(fileName: string, existingNames: Iterable<string> = []): string {
  const extensionMatch = fileName.match(/(\.[^.]+)$/)
  const extension = extensionMatch?.[1] ?? ''
  const stem = extension ? fileName.slice(0, -extension.length) : fileName
  const occupied = new Set([...existingNames].map((name) => name.toLocaleLowerCase()))
  let suffix = 2
  let candidate = `${stem}${suffix}${extension}`
  while (occupied.has(candidate.toLocaleLowerCase())) {
    suffix += 1
    candidate = `${stem}${suffix}${extension}`
  }
  return candidate
}

export function joinFilePath(directory: string, name: string): string {
  return directory ? `${directory.replace(/[\\/]$/, '')}/${name}` : name
}

/**
 * Backends can return a path, a file DTO, or a wrapper around either. Keep the
 * UI tolerant while the native bridge rolls out the file-operation commands.
 */
export function fileMutationResultPath(value: unknown, originalPath: string): string | null {
  const candidate = fileMutationResultString(value, ['path', 'newPath', 'new_path', 'filePath', 'file_path', 'relativePath', 'relative_path'])
    ?? fileMutationResultString(value, ['name', 'fileName', 'file_name', 'newName', 'new_name'])
  if (!candidate) {
    return null
  }
  if (/[\\/]/.test(candidate)) {
    return candidate.replace(/\\/g, '/').replace(/^\.\//, '')
  }
  return joinFilePath(gitDirectoryPath(originalPath), candidate)
}

function fileMutationResultString(value: unknown, keys: string[]): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    // A duplicate response may be the source text. Only treat strings that
    // look like paths or Java basenames as operation results.
    return /\.java$/i.test(value.trim()) || /[\\/]/.test(value.trim()) ? value.trim() : null
  }
  if (!isRecordValue(value)) {
    return null
  }
  for (const key of keys) {
    const result = fileMutationResultString(value[key], keys)
    if (result) {
      return result
    }
  }
  for (const nestedKey of ['file', 'entry', 'result', 'created', 'renamed', 'duplicate']) {
    const result = fileMutationResultString(value[nestedKey], keys)
    if (result) {
      return result
    }
  }
  return null
}

export function findFileAfterDuplicate(
  files: ProblemFileEntry[],
  existingPaths: Set<string>,
  original: ProblemFileEntry,
  result: unknown,
): ProblemFileEntry | null {
  const resultPath = fileMutationResultPath(result, original.path)
  const exact = resultPath
    ? files.find((file) => normalizeSourcePath(file.path) === normalizeSourcePath(resultPath))
    : null
  if (exact && exact.path !== original.path) {
    return exact
  }
  const siblingNames = files
    .filter((file) => gitDirectoryPath(file.path) === gitDirectoryPath(original.path))
    .map((file) => file.name)
  const fallbackName = duplicateFileName(original.name, siblingNames)
  const fallbackPath = joinFilePath(gitDirectoryPath(original.path), fallbackName)
  return files.find((file) => !existingPaths.has(file.path) && file.path === fallbackPath)
    ?? files.find((file) => !existingPaths.has(file.path)
      && gitDirectoryPath(file.path) === gitDirectoryPath(original.path)
      && file.name !== original.name
      && file.name.toLocaleLowerCase().startsWith(original.name.replace(/\.java$/i, '').toLocaleLowerCase()))
    ?? null
}

export function findRestoredFileAfterGitRename(
  files: ProblemFileEntry[],
  change: Pick<GitChangedFile, 'path' | 'originalPath'>,
): ProblemFileEntry | null {
  const originalPath = change.originalPath?.trim()
  if (!originalPath || sameFilePath(originalPath, change.path)) {
    return null
  }
  return files.find((file) => sameFilePath(file.path, originalPath)) ?? null
}

export function findFileAfterRename(
  files: ProblemFileEntry[],
  original: ProblemFileEntry,
  newName: string,
  result: unknown,
): ProblemFileEntry | null {
  const resultPath = fileMutationResultPath(result, original.path)
  const requestedPath = joinFilePath(gitDirectoryPath(original.path), newName)
  return files.find((file) => resultPath && normalizeSourcePath(file.path) === normalizeSourcePath(resultPath))
    ?? files.find((file) => normalizeSourcePath(file.path) === normalizeSourcePath(requestedPath))
    ?? files.find((file) => file.path !== original.path
      && gitDirectoryPath(file.path) === gitDirectoryPath(original.path)
      && file.name.toLocaleLowerCase() === newName.toLocaleLowerCase())
    ?? null
}

export function discardGitChangesConfirmationMessage(filePath: string): string {
  return `Discard changes to ${filePath}?\n\n${discardGitChangesWarningMessage()}`
}

export function discardGitChangesWarningMessage(): string {
  return 'This permanently discards all staged and unstaged changes. Untracked/new files will be deleted. This cannot be undone.'
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { gitDirectoryPath, normalizeSourcePath, sameFilePath }

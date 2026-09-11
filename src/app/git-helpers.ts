import {
  normalizeGitCommitResult,
  normalizeGitPushResult,
  type GitCommitResult,
  type GitPushResult,
} from '../backend'
import type { GitChangedFile, GitStatusSnapshot } from './types'
import { gitFileName } from './path-helpers'

/**
 * Auto commit message chosen by change kind: brand-new files read `Add …`,
 * anything touching an existing file reads `Update …`.
 */
export function defaultGitCommitMessage(files: Array<Pick<GitChangedFile, 'path' | 'status'>>): string {
  const normalized = files.filter((file) => file.path.trim().length > 0)
  if (normalized.length === 0) {
    return 'Update files'
  }
  const isNew = (status: string): boolean => status === 'added' || status === 'untracked'
  const allNew = normalized.every((file) => isNew(file.status))
  if (normalized.length === 1) {
    return `${allNew ? 'Add' : 'Update'} ${gitFileName(normalized[0].path)}`
  }
  return `${allNew ? 'Add' : 'Update'} ${normalized.length} files`
}

/** Best-effort commit-result parse; older backends may return anything. */
export function asGitCommitResult(value: unknown): GitCommitResult | null {
  try {
    return normalizeGitCommitResult(value)
  } catch {
    return null
  }
}

/** Best-effort push-result parse; older backends may return anything. */
export function asGitPushResult(value: unknown): GitPushResult | null {
  try {
    return normalizeGitPushResult(value)
  } catch {
    return null
  }
}

/**
 * Success toast for commit / commit-and-push, e.g. `Committed a1b2c3d · 2 files`
 * or `Committed a1b2c3d · Pushed to origin/main`. Falls back gracefully when a
 * backend response could not be parsed.
 */
export function gitResultToastMessage(
  fileCount: number,
  pushed: boolean,
  commit: GitCommitResult | null,
  push: GitPushResult | null,
): string {
  const files = `${fileCount} file${fileCount === 1 ? '' : 's'}`
  const committed = commit?.commitHash
    ? `Committed ${commit.commitHash.slice(0, 7)}`
    : 'Committed'
  if (!pushed) {
    return `${committed} · ${files}`
  }
  const pushedLabel = push?.branch ? `Pushed to origin/${push.branch}` : 'Pushed'
  return `${committed} · ${pushedLabel}`
}

/** Normalize the backend's Git status payload into the fields the UI needs. */
export function normalizeGitStatus(value: unknown): GitStatusSnapshot {
  if (typeof value === 'string') {
    return {
      branch: null,
      files: value.split(/\r?\n/).map(parseGitStatusLine).filter((file): file is GitChangedFile => file !== null),
    }
  }
  const record = isRecordValue(value) ? value : null
  const rawFiles = Array.isArray(value)
    ? value
    : record
      ? record.files ?? record.changes ?? record.entries ?? record.statuses ?? record.paths
      : undefined
  const files = Array.isArray(rawFiles)
    ? rawFiles.map((entry) => normalizeGitFile(entry)).filter((file): file is GitChangedFile => file !== null)
    : []
  const branch = record
    ? stringValueForGit(record.branch) ?? stringValueForGit(record.currentBranch) ?? stringValueForGit(record.head)
    : null
  return { branch, files: dedupeGitFiles(files) }
}

/** Normalize a Git diff payload to one diff string per repository-relative path. */
export function normalizeGitDiff(value: unknown, requestedPaths: string[] = []): Record<string, string> {
  const diffs: Record<string, string> = {}
  const assign = (path: string | null, diff: string): void => {
    const text = diff.trimEnd()
    if (!text) {
      return
    }
    if (path) {
      diffs[path] = text
      return
    }
    const parsed = splitUnifiedDiff(text)
    if (Object.keys(parsed).length > 0) {
      Object.assign(diffs, parsed)
      return
    }
    for (const requestedPath of requestedPaths) {
      diffs[requestedPath] = text
    }
  }

  if (typeof value === 'string') {
    assign(null, value)
    return diffs
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        assign(null, item)
        continue
      }
      if (!isRecordValue(item)) {
        continue
      }
      const path = stringValueForGit(item.path) ?? stringValueForGit(item.relativePath) ?? stringValueForGit(item.relative_path)
      const diff = stringValueForGit(item.diff) ?? stringValueForGit(item.patch) ?? stringValueForGit(item.content)
      if (diff) {
        assign(path, diff)
      }
    }
    return diffs
  }
  if (!isRecordValue(value)) {
    return diffs
  }
  const nested = value.files ?? value.diffs ?? value.changes
  if (Array.isArray(nested)) {
    Object.assign(diffs, normalizeGitDiff(nested, requestedPaths))
  }
  const rawDiff = stringValueForGit(value.diff) ?? stringValueForGit(value.patch) ?? stringValueForGit(value.content)
  if (rawDiff) {
    const path = stringValueForGit(value.path) ?? stringValueForGit(value.relativePath) ?? stringValueForGit(value.relative_path)
    assign(path, rawDiff)
  }
  return diffs
}

function parseGitStatusLine(line: string): GitChangedFile | null {
  const raw = line.replace(/\r$/, '')
  if (!raw.trim()) {
    return null
  }
  // Porcelain v1: XY path, with a quoted path only in unusual filenames.
  const match = /^(?<index>.)(?<worktree>.)\s+(?<path>.+)$/.exec(raw)
  if (!match?.groups?.path) {
    return null
  }
  const index = match.groups.index ?? ' '
  const worktree = match.groups.worktree ?? ' '
  const status = statusFromGitCodes(index, worktree)
  return {
    path: unquoteGitPath(match.groups.path),
    status,
    staged: isGitIndexStaged(index),
    additions: null,
    deletions: null,
    originalPath: null,
  }
}

function normalizeGitFile(value: unknown): GitChangedFile | null {
  if (typeof value === 'string') {
    return { path: value, status: 'modified', staged: false, additions: null, deletions: null, originalPath: null }
  }
  if (!isRecordValue(value)) {
    return null
  }
  const path = stringValueForGit(value.path)
    ?? stringValueForGit(value.relativePath)
    ?? stringValueForGit(value.relative_path)
    ?? stringValueForGit(value.name)
  if (!path) {
    return null
  }
  const index = stringValueForGit(value.indexStatus) ?? stringValueForGit(value.index_status) ?? stringValueForGit(value.index)
  const worktree = stringValueForGit(value.worktreeStatus) ?? stringValueForGit(value.worktree_status) ?? stringValueForGit(value.worktree)
  const rawStatus = stringValueForGit(value.status) ?? stringValueForGit(value.state) ?? stringValueForGit(value.statusCode) ?? stringValueForGit(value.status_code)
  const additions = numberValueForGit(value.additions ?? value.insertions ?? value.added)
  const deletions = numberValueForGit(value.deletions ?? value.removals ?? value.deleted)
  const originalPath = stringValueForGit(value.originalPath)
    ?? stringValueForGit(value.original_path)
  const staged = typeof value.staged === 'boolean'
    ? value.staged
    : isGitIndexStaged(index)
  return {
    path: unquoteGitPath(path),
    status: rawStatus ? normalizeGitStatusLabel(rawStatus) : statusFromGitCodes(index ?? ' ', worktree ?? ' '),
    staged,
    additions,
    deletions,
    originalPath: originalPath ? unquoteGitPath(originalPath) : null,
  }
}

function isGitIndexStaged(index: string | null): boolean {
  if (!index) {
    return false
  }
  const normalized = index.trim()
  return normalized.length > 0 && normalized !== '.' && normalized !== '?'
}

function dedupeGitFiles(files: GitChangedFile[]): GitChangedFile[] {
  const byPath = new Map<string, GitChangedFile>()
  for (const file of files) {
    if (!file.path) {
      continue
    }
    const previous = byPath.get(file.path)
    byPath.set(file.path, previous ? {
      ...previous,
      ...file,
      additions: file.additions ?? previous.additions,
      deletions: file.deletions ?? previous.deletions,
      originalPath: file.originalPath ?? previous.originalPath,
    } : file)
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function splitUnifiedDiff(diff: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = diff.split(/\r?\n/)
  let currentPath: string | null = null
  let current: string[] = []
  const flush = (): void => {
    if (currentPath && current.length > 0) {
      result[currentPath] = current.join('\n').trimEnd()
    }
  }
  for (const line of lines) {
    const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line)
    if (match) {
      flush()
      currentPath = match[2] || match[1]
      current = [line]
      continue
    }
    if (currentPath) {
      current.push(line)
    }
  }
  flush()
  return result
}

function statusFromGitCodes(index: string, worktree: string): string {
  const code = `${index}${worktree}`.trim()
  if (code === '??' || index === '?' || worktree === '?') return 'untracked'
  if (code.includes('U')) return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  if (code.includes('M')) return 'modified'
  return 'modified'
}

export function normalizeGitStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'm' || normalized.includes('modif')) return 'modified'
  if (normalized === 'a' || normalized.includes('add') || normalized.includes('new')) return 'added'
  if (normalized === 'd' || normalized.includes('delet') || normalized.includes('remov')) return 'deleted'
  if (normalized === 'r' || normalized.includes('renam')) return 'renamed'
  if (normalized === 'u' || normalized.includes('conflict')) return 'conflicted'
  if (normalized === '?' || normalized === '??' || normalized.includes('?') || normalized.includes('untrack')) return 'untracked'
  return status.trim() || 'modified'
}

export function gitStatusGlyph(status: string): string {
  switch (normalizeGitStatusLabel(status)) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'conflicted':
      return 'U'
    case 'untracked':
      return '?'
    default:
      return 'M'
  }
}

export function isGitNewFile(status: string): boolean {
  const normalized = normalizeGitStatusLabel(status)
  return normalized === 'added' || normalized === 'untracked'
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1')
  }
  return trimmed
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValueForGit(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function numberValueForGit(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return null
}

export type UnifiedDiffLineKind = 'context' | 'addition' | 'deletion' | 'hunk' | 'no-newline'

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind
  oldLine: number | null
  newLine: number | null
  marker: '' | '+' | '-'
  content: string
}

/**
 * Converts a raw Git unified diff into only the lines useful in the file
 * viewer. Git's file headers and index/mode metadata are already represented
 * by the file heading and status badge, so showing them again makes the code
 * harder to scan. The returned line numbers are the source line numbers from
 * each side of every hunk.
 */
export function parseUnifiedDiffLines(diff: string): UnifiedDiffLine[] {
  const lines: UnifiedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let hasHunk = false

  const rawLines = diff.split(/\r\n|\n|\r/)
  for (const [lineIndex, line] of rawLines.entries()) {
    // A final line ending is not an additional blank source line. Actual
    // blank context lines retain their required unified-diff space prefix.
    if (lineIndex === rawLines.length - 1 && line.length === 0) {
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      hasHunk = true
      lines.push({
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        marker: '',
        content: line,
      })
      continue
    }

    // Everything before the first hunk is a file header or a diff metadata
    // line. A metadata line after a hunk can occur for binary/rename diffs;
    // it is intentionally omitted as well.
    if (isUnifiedDiffMetadataLine(line, hasHunk) || !hasHunk) {
      continue
    }

    if (line === '\\ No newline at end of file') {
      lines.push({
        kind: 'no-newline',
        oldLine: null,
        newLine: null,
        marker: '',
        content: line,
      })
      continue
    }

    if (line.startsWith('+')) {
      lines.push({
        kind: 'addition',
        oldLine: null,
        newLine: newLine++,
        marker: '+',
        content: line.slice(1),
      })
      continue
    }

    if (line.startsWith('-')) {
      lines.push({
        kind: 'deletion',
        oldLine: oldLine++,
        newLine: null,
        marker: '-',
        content: line.slice(1),
      })
      continue
    }

    // A normal unified-diff context line starts with one space. Keeping the
    // fallback makes the renderer tolerant of backend payloads that omit the
    // prefix while still preserving an actually blank context line (" ").
    const content = line.startsWith(' ') ? line.slice(1) : line
    lines.push({
      kind: 'context',
      oldLine: oldLine++,
      newLine: newLine++,
      marker: '',
      content,
    })
  }

  return lines
}

function isUnifiedDiffMetadataLine(line: string, hasHunk = false): boolean {
  return line.startsWith('diff --git ')
    || /^(?:new|deleted|old) file mode\s/.test(line)
    || /^(?:old|new) mode\s/.test(line)
    || /^(?:similarity|dissimilarity) index\s/.test(line)
    || /^(?:rename|copy) (?:from|to)\s/.test(line)
    || line.startsWith('index ')
    || (!hasHunk && /^(?:---|\+\+\+)(?:\s|$)/.test(line))
    || line === 'GIT binary patch'
    || /^(?:literal|delta) \d+$/.test(line)
    || line.startsWith('Binary files ')
}

export { gitFileName }

import type { GitCommitResult, GitFileChange, GitPushResult } from '../contracts'
import { isRecord, stringValue } from './common'

export function normalizeGitChanges(value: unknown): GitFileChange[] {
  const rawChanges = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.changes ?? value.files ?? value.entries
      : undefined
  if (!Array.isArray(rawChanges)) {
    throw new Error('The Git status response was invalid.')
  }

  const normalized = rawChanges
    .map((entry) => {
      if (!isRecord(entry)) {
        return null
      }
      const path = stringValue(entry.path) ?? stringValue(entry.relativePath) ?? stringValue(entry.relative_path)
      if (!path || path.trim().length === 0) {
        return null
      }
      const indexStatus = stringValue(entry.indexStatus) ?? stringValue(entry.index_status) ?? '.'
      const worktreeStatus = stringValue(entry.worktreeStatus) ?? stringValue(entry.worktree_status) ?? '.'
      const status = stringValue(entry.status) ?? compactGitStatus(indexStatus, worktreeStatus)
      return {
        path,
        status,
        indexStatus,
        worktreeStatus,
        originalPath: stringValue(entry.originalPath) ?? stringValue(entry.original_path) ?? null,
      }
    })
  return normalized.filter((entry): entry is Exclude<typeof normalized[number], null> => entry !== null)
}

export function normalizeGitDiff(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (isRecord(value)) {
    const diff = value.diff ?? value.patch ?? value.content
    if (typeof diff === 'string') {
      return diff
    }
  }
  throw new Error('The Git diff response was invalid.')
}

export function normalizeGitCommitResult(value: unknown): GitCommitResult {
  if (!isRecord(value)) {
    throw new Error('The Git commit response was invalid.')
  }
  const commitHash = stringValue(value.commitHash)
    ?? stringValue(value.commit_hash)
    ?? stringValue(value.hash)
  if (!commitHash) {
    throw new Error('The Git commit response did not contain a commit hash.')
  }
  const rawPaths = value.paths ?? value.files
  const paths = Array.isArray(rawPaths)
    ? rawPaths.filter((path): path is string => typeof path === 'string')
    : []
  return {
    commitHash,
    message: stringValue(value.message) ?? '',
    paths,
  }
}

export function normalizeGitPushResult(value: unknown): GitPushResult {
  if (typeof value === 'string') {
    return { output: value, branch: null }
  }
  if (!isRecord(value)) {
    throw new Error('The Git push response was invalid.')
  }
  return {
    output: stringValue(value.output) ?? stringValue(value.stdout) ?? '',
    branch: stringValue(value.branch) ?? null,
  }
}

function compactGitStatus(indexStatus: string, worktreeStatus: string): string {
  if (indexStatus === '?' && worktreeStatus === '?') {
    return '??'
  }
  const status = `${indexStatus === '.' ? '' : indexStatus}${worktreeStatus === '.' ? '' : worktreeStatus}`
  return status || '.'
}

import type { DailyProblem, ProjectValidation, UpdateStatus } from '../contracts'
import { isRecord, stringValue } from './common'

export function normalizeValidation(value: unknown): ProjectValidation {
  if (typeof value === 'boolean') {
    return { valid: value }
  }
  if (isRecord(value)) {
    const valid = value.valid ?? value.isValid ?? value.ok
    if (typeof valid === 'boolean') {
      return {
        valid,
        message: stringValue(value.message) ?? stringValue(value.reason),
      }
    }
  }
  throw new Error('The project validation response was invalid.')
}

export function normalizeUpdateStatus(value: unknown): UpdateStatus {
  if (!isRecord(value)) {
    throw new Error('The update status response was invalid.')
  }
  const currentCommit = stringValue(value.currentCommit) ?? stringValue(value.current_commit) ?? ''
  const latestCommit = stringValue(value.latestCommit) ?? stringValue(value.latest_commit) ?? ''
  const supported = typeof value.supported === 'boolean'
    ? value.supported
    : currentCommit.length > 0 && latestCommit.length > 0
  const available = typeof value.available === 'boolean'
    ? value.available
    : supported && commitsDiffer(currentCommit, latestCommit)
  return { supported, available, currentCommit, latestCommit }
}

function commitsDiffer(currentCommit: string, latestCommit: string): boolean {
  return currentCommit.length > 0 && latestCommit.length > 0 && currentCommit !== latestCommit
}

export function normalizeDailyProblem(value: unknown): DailyProblem {
  if (!isRecord(value)) {
    throw new Error('The daily problem response was invalid.')
  }

  const frontendId = value.frontendId ?? value.frontend_id ?? value.number ?? value.id
  const title = stringValue(value.title)
  const difficulty = stringValue(value.difficulty)
  const url = stringValue(value.url)
  if (frontendId === undefined || !title || !difficulty || !url) {
    throw new Error('The daily problem response was missing required fields.')
  }

  const content = stringValue(value.content)
  return {
    date: stringValue(value.date) ?? '',
    frontendId: String(frontendId),
    title,
    titleSlug: stringValue(value.titleSlug) ?? stringValue(value.title_slug) ?? '',
    difficulty,
    url,
    javaSnippet: stringValue(value.javaSnippet) ?? stringValue(value.java_snippet),
    // Trim only to test emptiness; the description HTML itself is kept intact.
    content: content !== undefined && content.trim().length > 0 ? content : null,
  }
}

import { isRecord } from './normalizers/common'

/** An error raised for a create race that can safely be retried. */
export class BackendError extends Error {
  readonly conflict: boolean

  constructor(message: string, conflict = false) {
    super(message)
    this.name = 'BackendError'
    this.conflict = conflict
  }
}

export function isConflictError(error: unknown): boolean {
  if (error instanceof BackendError) {
    return error.conflict
  }

  const message = errorMessage(error).toLowerCase()
  return /(already exists|file exists|path exists|collision|duplicate|conflict)/.test(message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  if (isRecord(error)) {
    for (const key of ['message', 'error', 'reason']) {
      const value = error[key]
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
    }
  }
  return 'An unexpected leetcoder error occurred.'
}

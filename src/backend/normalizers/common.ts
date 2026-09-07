/** Shared guards and primitive coercions used by backend response adapters. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function countValue(value: unknown): number | undefined {
  const number = numberValue(value)
  if (number !== undefined) {
    return number
  }
  return Array.isArray(value) ? value.length : undefined
}

export function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

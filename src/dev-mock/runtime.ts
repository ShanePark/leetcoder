/**
 * Browser-preview mock backend for visual verification (`vite dev` +
 * `?mock`). Inert in the desktop app: activation requires the absence of the
 * Tauri bridge AND the explicit `mock` query parameter.
 *
 * Scenarios via the parameter value: `?mock` (one failing test),
 * `?mock=pass`, `?mock=compile`, `?mock=notests`.
 */
export function isDevMockActive(): boolean {
  if (typeof window === 'undefined' || '__TAURI_INTERNALS__' in window) {
    return false
  }
  return new URLSearchParams(window.location.search).has('mock')
}

type MockScenario = 'fail' | 'pass' | 'compile' | 'notests'

export function activeScenario(): MockScenario {
  const value = new URLSearchParams(window.location.search).get('mock')
  if (value === 'pass' || value === 'compile' || value === 'notests') {
    return value
  }
  return 'fail'
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

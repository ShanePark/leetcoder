import { describe, expect, it, vi } from 'vitest'
import { AutosaveCoordinator } from '../../../src/app'

describe('AutosaveCoordinator', () => {
  it('debounces edits and coalesces them to the newest content', async () => {
    vi.useFakeTimers()
    try {
      const saved: string[] = []
      const coordinator = new AutosaveCoordinator(async ({ source }) => {
        saved.push(source)
      }, { delayMs: 500 })

      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'a' })
      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'ab' })
      await vi.advanceTimersByTimeAsync(499)
      expect(saved).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await coordinator.flush()
      expect(saved).toEqual(['ab'])
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves an edit made during an in-flight save after the first write', async () => {
    const saved: string[] = []
    let releaseFirst: (() => void) | undefined
    const coordinator = new AutosaveCoordinator(({ source }) => {
      saved.push(source)
      if (source === 'a') {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve()
    }, { delayMs: 0 })

    coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'a' })
    const firstFlush = coordinator.flush()
    await Promise.resolve()
    coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'ab' })
    releaseFirst?.()
    await firstFlush
    await coordinator.flush()
    expect(saved).toEqual(['a', 'ab'])
    coordinator.dispose()
  })

  it('flushes a pending edit immediately for a transition', async () => {
    vi.useFakeTimers()
    try {
      const saved: string[] = []
      const coordinator = new AutosaveCoordinator(async ({ source }) => {
        saved.push(source)
      }, { delayMs: 500 })
      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'latest' })
      await coordinator.flush()
      expect(saved).toEqual(['latest'])
      expect(coordinator.hasPendingChanges).toBe(false)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

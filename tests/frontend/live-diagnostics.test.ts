import { describe, expect, it, vi } from 'vitest'

import { LiveDiagnosticsScheduler, type LiveDiagnosticsSnapshot } from '../../src/live-diagnostics'

const firstSnapshot: LiveDiagnosticsSnapshot = {
  repoPath: '/repo',
  relativePath: 'src/main/java/shane/Q1.java',
  fullyQualifiedClassName: 'shane.Q1',
  source: 'class Q1 {}',
}

function snapshot(source: string): LiveDiagnosticsSnapshot {
  return { ...firstSnapshot, source }
}

describe('LiveDiagnosticsScheduler', () => {
  it('debounces edits and checks only the newest snapshot', async () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn().mockResolvedValue([])
      const onResult = vi.fn()
      const scheduler = new LiveDiagnosticsScheduler({ check, onResult, delayMs: 700 })

      scheduler.schedule(snapshot('first'))
      scheduler.schedule(snapshot('latest'))
      await vi.advanceTimersByTimeAsync(699)
      expect(check).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(check).toHaveBeenCalledTimes(1)
      expect(check).toHaveBeenCalledWith(snapshot('latest'))
      await vi.runOnlyPendingTimersAsync()
      expect(onResult).toHaveBeenCalledWith(snapshot('latest'), [])
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one native request in flight and follows it with the latest pending snapshot', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst: ((diagnostics: never[]) => void) | null = null
      const check = vi.fn((request: LiveDiagnosticsSnapshot) => {
        if (request.source === 'first') {
          return new Promise<never[]>((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve([])
      })
      const scheduler = new LiveDiagnosticsScheduler({ check, onResult: vi.fn(), delayMs: 700 })

      scheduler.schedule(snapshot('first'))
      await vi.advanceTimersByTimeAsync(700)
      expect(check).toHaveBeenCalledTimes(1)

      scheduler.schedule(snapshot('latest'))
      await vi.advanceTimersByTimeAsync(700)
      expect(check).toHaveBeenCalledTimes(1)

      resolveFirst?.([])
      await vi.runOnlyPendingTimersAsync()
      expect(check).toHaveBeenCalledTimes(2)
      expect(check).toHaveBeenLastCalledWith(snapshot('latest'))
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an in-flight response after the source, file, or repository changes', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst: ((diagnostics: never[]) => void) | null = null
      const onResult = vi.fn()
      const check = vi.fn(() => new Promise<never[]>((resolve) => {
        resolveFirst = resolve
      }))
      const scheduler = new LiveDiagnosticsScheduler({ check, onResult, delayMs: 0 })

      scheduler.schedule(snapshot('first'))
      await vi.advanceTimersByTimeAsync(0)
      scheduler.schedule({
        ...snapshot('latest'),
        repoPath: '/other-repo',
        relativePath: 'src/main/java/shane/Q2.java',
        fullyQualifiedClassName: 'shane.Q2',
      })
      resolveFirst?.([])
      await vi.runOnlyPendingTimersAsync()

      expect(onResult).not.toHaveBeenCalled()
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('defers checks while blocked by a running test and resumes the latest snapshot', async () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn().mockResolvedValue([])
      const scheduler = new LiveDiagnosticsScheduler({ check, onResult: vi.fn(), delayMs: 700 })

      scheduler.setBlocked(true)
      scheduler.schedule(snapshot('while running'))
      await vi.advanceTimersByTimeAsync(2000)
      expect(check).not.toHaveBeenCalled()

      scheduler.setBlocked(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(check).toHaveBeenCalledWith(snapshot('while running'))
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

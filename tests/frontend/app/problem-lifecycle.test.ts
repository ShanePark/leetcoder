import { describe, expect, it, vi } from 'vitest'
import { LeetcoderApp, normalizeProblemNumber, utcDateKey } from '../../../src/app'

describe('problem lookup input', () => {
  it('normalizes positive numeric ids without changing large digit strings', () => {
    expect(normalizeProblemNumber(' 001 ')).toBe('1')
    expect(normalizeProblemNumber('4000')).toBe('4000')
    expect(normalizeProblemNumber('999999999999999999999999')).toBe('999999999999999999999999')
  })

  it('rejects empty, zero, and non-numeric values', () => {
    expect(normalizeProblemNumber('')).toBeNull()
    expect(normalizeProblemNumber('000')).toBeNull()
    expect(normalizeProblemNumber('1.5')).toBeNull()
    expect(normalizeProblemNumber('abc')).toBeNull()
  })

  function appHarness(overrides: Record<string, unknown> = {}): any {
    const app = Object.create(LeetcoderApp.prototype) as any
    const stateOverrides = (overrides.state ?? {}) as Record<string, unknown>
    const appOverrides = { ...overrides }
    delete appOverrides.state
    app.destroyed = false
    app.dailyRequestId = 0
    app.problemNumberDraft = null
    app.lastProblemRequest = 'daily'
    app.renderAll = vi.fn()
    app.scheduleDailyProblemRefresh = vi.fn()
    app.setMessage = vi.fn()
    app.state = {
      dailyProblem: null,
      problemSelection: 'daily',
      dailyProblemDateKey: null,
      dailyRetryPending: false,
      dailyError: null,
      dailyLoading: false,
      busy: false,
      repoPath: null,
      projectValid: false,
      files: [],
      ...stateOverrides,
    }
    Object.assign(app, appOverrides)
    return app
  }

  it('keeps the displayed problem when a manual lookup fails', async () => {
    const displayed = {
      date: '2026-08-23',
      frontendId: '1',
      title: 'Two Sum',
      titleSlug: 'two-sum',
      difficulty: 'Easy',
      url: 'https://leetcode.com/problems/two-sum/',
      javaSnippet: null,
      content: null,
    }
    const app = appHarness({
      backend: { fetchProblemByNumber: vi.fn().mockRejectedValue(new Error('not found')) },
      state: { dailyProblem: displayed },
    })

    await app.loadProblemByNumber('9999')

    expect(app.state.dailyProblem).toBe(displayed)
    expect(app.problemNumberDraft).toBe('1')
    expect(app.state.problemSelection).toBe('daily')
    expect(app.setMessage).toHaveBeenCalledWith(
      'Could not load problem #9999: not found',
      'error',
    )
  })

  it('does not replace a manual selection during daily refresh checks', () => {
    const fetchDailyProblem = vi.fn()
    const app = appHarness({
      backend: { fetchDailyProblem },
      state: {
        dailyProblem: { frontendId: '1' },
        problemSelection: 'manual',
      },
    })
    app.isWindowVisible = () => true

    app.refreshDailyProblemIfStale()

    expect(fetchDailyProblem).not.toHaveBeenCalled()
  })

  it('recognizes a manually loaded problem when it matches the cached current daily id', () => {
    const app = appHarness({
      latestDailyProblem: { frontendId: '3622', dateKey: utcDateKey() },
      state: {
        dailyProblem: { frontendId: '3622' },
        problemSelection: 'manual',
      },
    })

    expect(app.isViewingTodayProblem({ frontendId: '3622' })).toBe(true)
    expect(app.isViewingTodayProblem({ frontendId: '1' })).toBe(false)
  })

  it('does not label an old cached daily id as today', () => {
    const app = appHarness({
      latestDailyProblem: { frontendId: '3622', dateKey: '2020-01-01' },
      state: {
        dailyProblem: { frontendId: '3622' },
        problemSelection: 'manual',
      },
    })

    expect(app.isViewingTodayProblem({ frontendId: '3622' })).toBe(false)
  })

  it('creates from the problem selected before pending saves finish', async () => {
    const selected = {
      frontendId: '1',
      title: 'Two Sum',
      difficulty: 'Easy',
      javaSnippet: null,
    }
    const changedDuringSave = {
      frontendId: '2',
      title: 'Add Two Numbers',
      difficulty: 'Medium',
      javaSnippet: null,
    }
    const createProblemFile = vi.fn().mockResolvedValue(undefined)
    const app = appHarness({
      backend: {
        listProblemFiles: vi.fn().mockResolvedValue([]),
        createProblemFile,
      },
      state: {
        dailyProblem: selected,
        repoPath: '/repo',
        projectValid: true,
      },
    })
    app.flushPendingSave = vi.fn(async () => {
      app.state.dailyProblem = changedDuringSave
      return true
    })
    app.markGitStale = vi.fn()
    app.refreshFiles = vi.fn().mockResolvedValue(true)
    app.openFile = vi.fn().mockResolvedValue(undefined)

    await app.createFileForToday()

    expect(createProblemFile).toHaveBeenCalledWith('/repo', expect.objectContaining({
      problemNumber: '1',
      title: 'Two Sum',
      packageSegment: 'easy',
    }))
  })
})

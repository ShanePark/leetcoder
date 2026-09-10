import { describe, expect, it, vi } from 'vitest'

import { LeetcoderApp, normalizeProblemNumber, utcDateKey } from '../../../src/app'
import {
  ProblemSelectionController,
  type ProblemSelectionControllerBackend,
} from '../../../src/app/problem-selection-controller'
import type { DailyProblem } from '../../../src/backend'
import type { AppState } from '../../../src/app/types'

type SelectionState = Pick<
  AppState,
  | 'dailyProblem'
  | 'problemSelection'
  | 'dailyProblemDateKey'
  | 'dailyRetryPending'
  | 'dailyError'
  | 'dailyLoading'
>

function problem(frontendId: string, date = utcDateKey()): DailyProblem {
  return {
    date,
    frontendId,
    title: `Problem ${frontendId}`,
    titleSlug: `problem-${frontendId}`,
    difficulty: 'Easy',
    url: `https://leetcode.com/problems/problem-${frontendId}/`,
    javaSnippet: null,
    content: null,
  }
}

function selectionHarness(overrides: Partial<SelectionState> = {}): {
  controller: ProblemSelectionController
  state: SelectionState
  fetchDailyProblem: ReturnType<typeof vi.fn<ProblemSelectionControllerBackend['fetchDailyProblem']>>
  fetchProblemByNumber: ReturnType<typeof vi.fn<ProblemSelectionControllerBackend['fetchProblemByNumber']>>
  messages: Array<{ message: string; tone: string }>
} {
  const state: SelectionState = {
    dailyProblem: null,
    problemSelection: 'daily',
    dailyProblemDateKey: null,
    dailyRetryPending: false,
    dailyError: null,
    dailyLoading: false,
    ...overrides,
  }
  const fetchDailyProblem = vi.fn<ProblemSelectionControllerBackend['fetchDailyProblem']>()
  const fetchProblemByNumber = vi.fn<ProblemSelectionControllerBackend['fetchProblemByNumber']>()
  const messages: Array<{ message: string; tone: string }> = []
  const backend: ProblemSelectionControllerBackend = {
    fetchDailyProblem,
    fetchProblemByNumber,
  }
  const controller = new ProblemSelectionController({
    state,
    backend,
    render: vi.fn(),
    setMessage: (message, tone) => messages.push({ message, tone }),
    isWindowVisible: () => true,
    isDestroyed: () => false,
  })
  return { controller, state, fetchDailyProblem, fetchProblemByNumber, messages }
}

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

  it('keeps the displayed problem when a manual lookup fails', async () => {
    const displayed = problem('1', '2026-08-23')
    const { controller, state, fetchProblemByNumber, messages } = selectionHarness({
      dailyProblem: displayed,
    })
    fetchProblemByNumber.mockRejectedValue(new Error('not found'))

    await controller.loadProblemByNumber('9999')

    expect(state.dailyProblem).toBe(displayed)
    expect(controller.problemNumberDraft).toBe('1')
    expect(state.problemSelection).toBe('daily')
    expect(messages).toEqual([{
      message: 'Could not load problem #9999: not found',
      tone: 'error',
    }])
    controller.dispose()
  })

  it('does not replace a manual selection during daily refresh checks', () => {
    const { controller, fetchDailyProblem } = selectionHarness({
      dailyProblem: problem('1'),
      problemSelection: 'manual',
    })

    controller.refreshDailyProblemIfStale()

    expect(fetchDailyProblem).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('recognizes a manually loaded problem when it matches the cached current daily id', async () => {
    const { controller, state, fetchDailyProblem } = selectionHarness()
    const daily = problem('3622')
    fetchDailyProblem.mockResolvedValue(daily)
    await controller.loadDailyProblem()
    state.problemSelection = 'manual'

    expect(controller.isViewingTodayProblem(daily)).toBe(true)
    expect(controller.isViewingTodayProblem(problem('1'))).toBe(false)
    controller.dispose()
  })

  it('does not label an old cached daily id as today', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
      const { controller, state, fetchDailyProblem } = selectionHarness()
      const daily = problem('3622', '2026-09-10')
      fetchDailyProblem.mockResolvedValue(daily)
      await controller.loadDailyProblem()
      vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'))
      state.problemSelection = 'manual'

      expect(controller.isViewingTodayProblem(daily)).toBe(false)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
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
    const app = Object.create(LeetcoderApp.prototype) as any
    app.backend = {
      listProblemFiles: vi.fn().mockResolvedValue([]),
      createProblemFile,
    }
    app.state = {
      dailyProblem: selected,
      repoPath: '/repo',
      projectValid: true,
      files: [],
      busy: false,
    }
    app.gitController = { markStale: vi.fn() }
    app.flushPendingSave = vi.fn(async () => {
      app.state.dailyProblem = changedDuringSave
      return true
    })
    app.renderAll = vi.fn()
    app.setMessage = vi.fn()
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

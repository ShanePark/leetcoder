import { describe, expect, it, vi } from 'vitest'

import { utcDateKey } from '../../../src/app'
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

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

function harness(overrides: Partial<SelectionState> = {}): {
  controller: ProblemSelectionController
  state: SelectionState
  fetchDailyProblem: ReturnType<typeof vi.fn<ProblemSelectionControllerBackend['fetchDailyProblem']>>
  fetchProblemByNumber: ReturnType<typeof vi.fn<ProblemSelectionControllerBackend['fetchProblemByNumber']>>
  render: ReturnType<typeof vi.fn>
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
  const render = vi.fn()
  const messages: Array<{ message: string; tone: string }> = []
  const backend: ProblemSelectionControllerBackend = {
    fetchDailyProblem,
    fetchProblemByNumber,
  }
  const controller = new ProblemSelectionController({
    state,
    backend,
    render,
    setMessage: (message, tone) => messages.push({ message, tone }),
    isWindowVisible: () => true,
    isDestroyed: () => false,
  })
  return { controller, state, fetchDailyProblem, fetchProblemByNumber, render, messages }
}

describe('ProblemSelectionController', () => {
  it('loads today’s problem and remembers the daily identity while selected manually', async () => {
    const { controller, state, fetchDailyProblem } = harness()
    const selected = problem('3622')
    fetchDailyProblem.mockResolvedValue(selected)

    await controller.loadDailyProblem()

    expect(state.dailyProblem).toBe(selected)
    expect(state.problemSelection).toBe('daily')
    expect(state.dailyProblemDateKey).toBe(utcDateKey())
    expect(controller.problemNumberDraft).toBe('3622')

    state.problemSelection = 'manual'
    expect(controller.isViewingTodayProblem(selected)).toBe(true)
    expect(controller.isViewingTodayProblem(problem('1'))).toBe(false)
    controller.dispose()
  })

  it('keeps the displayed problem when a manual lookup fails', async () => {
    const displayed = problem('1', '2026-08-23')
    const { controller, state, fetchProblemByNumber, messages } = harness({
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

  it('does not refresh while a manual problem is selected', () => {
    const { controller, fetchDailyProblem } = harness({
      dailyProblem: problem('1'),
      problemSelection: 'manual',
    })

    controller.refreshDailyProblemIfStale()

    expect(fetchDailyProblem).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('retries a stale provider date and accepts the new date after the next poll', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
      const { controller, state, fetchDailyProblem } = harness()
      fetchDailyProblem
        .mockResolvedValueOnce(problem('1', '2026-09-09'))
        .mockResolvedValueOnce(problem('2', '2026-09-10'))

      await controller.loadDailyProblem()
      expect(state.dailyRetryPending).toBe(true)
      expect(state.dailyProblemDateKey).toBe('2026-09-09')
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      expect(state.dailyProblem?.frontendId).toBe('2')
      expect(state.dailyProblemDateKey).toBe('2026-09-10')
      expect(state.dailyRetryPending).toBe(false)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes after UTC midnight when the daily date rolls over', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-10T23:59:59.500Z'))
      const { controller, state, fetchDailyProblem } = harness()
      fetchDailyProblem
        .mockResolvedValueOnce(problem('1', '2026-09-10'))
        .mockResolvedValueOnce(problem('2', '2026-09-11'))

      await controller.loadDailyProblem()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      expect(state.dailyProblem?.frontendId).toBe('2')
      expect(state.dailyProblemDateKey).toBe('2026-09-11')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a delayed response after disposal and cancels its refresh timer', async () => {
    vi.useFakeTimers()
    try {
      const response = deferred<DailyProblem>()
      const { controller, state, fetchDailyProblem, render } = harness()
      fetchDailyProblem.mockReturnValue(response.promise)

      const request = controller.loadDailyProblem()
      expect(state.dailyLoading).toBe(true)
      controller.dispose()
      response.resolve(problem('1'))
      await request
      await vi.runOnlyPendingTimersAsync()

      expect(state.dailyProblem).toBeNull()
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)
      expect(render).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

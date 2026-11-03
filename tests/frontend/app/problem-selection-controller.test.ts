import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function harness(
  overrides: Partial<SelectionState> = {},
  isWindowVisible: () => boolean = () => true,
): {
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
    isWindowVisible,
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

  describe('daily retry backoff', () => {
    const MINUTE = 60_000

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('backs off 1, 2, 4, 8, 16 minutes and then stays at 30 minutes', async () => {
      const { controller, fetchDailyProblem } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))

      await controller.loadDailyProblem()
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)

      let calls = 1
      for (const minutes of [1, 2, 4, 8, 16, 30, 30, 30]) {
        await vi.advanceTimersByTimeAsync(minutes * MINUTE - 1)
        expect(fetchDailyProblem).toHaveBeenCalledTimes(calls)
        await vi.advanceTimersByTimeAsync(1)
        calls += 1
        expect(fetchDailyProblem).toHaveBeenCalledTimes(calls)
      }
      controller.dispose()
    })

    it('backs off the same way while the provider serves yesterday’s problem', async () => {
      const { controller, state, fetchDailyProblem } = harness()
      fetchDailyProblem.mockResolvedValue(problem('1', '2026-09-09'))

      await controller.loadDailyProblem()

      let calls = 1
      for (const minutes of [1, 2, 4]) {
        await vi.advanceTimersByTimeAsync(minutes * MINUTE - 1)
        expect(fetchDailyProblem).toHaveBeenCalledTimes(calls)
        await vi.advanceTimersByTimeAsync(1)
        calls += 1
        expect(fetchDailyProblem).toHaveBeenCalledTimes(calls)
      }
      expect(state.dailyRetryPending).toBe(true)
      controller.dispose()
    })

    it('restarts from 1 minute once today’s problem has loaded', async () => {
      const { controller, state, fetchDailyProblem } = harness()
      fetchDailyProblem
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValueOnce(problem('1', '2026-09-10'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))

      await controller.loadDailyProblem()
      await vi.advanceTimersByTimeAsync((1 + 2 + 4) * MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(4)
      expect(state.dailyRetryPending).toBe(false)

      await controller.loadDailyProblem(true)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(6)
      controller.dispose()
    })

    it('keeps the streak when a manual problem is picked', async () => {
      const { controller, state, fetchDailyProblem, fetchProblemByNumber } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))
      fetchProblemByNumber.mockResolvedValue(problem('7', '2026-01-01'))

      await controller.loadDailyProblem()
      await vi.advanceTimersByTimeAsync(MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)

      await controller.loadProblemByNumber('7')
      expect(state.problemSelection).toBe('manual')
      await vi.advanceTimersByTimeAsync(60 * MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)

      controller.selectToday()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(4 * MINUTE - 1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(4)
      controller.dispose()
    })

    it('re-arms for the remaining time when the window returns before the retry is due', async () => {
      let visible = true
      const { controller, fetchDailyProblem } = harness({}, () => visible)
      fetchDailyProblem.mockRejectedValue(new Error('refused'))

      await controller.loadDailyProblem()
      await vi.advanceTimersByTimeAsync(MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)

      visible = false
      controller.clearScheduledRefresh()
      await vi.advanceTimersByTimeAsync(MINUTE)

      visible = true
      controller.refreshDailyProblemIfStale()
      controller.refreshDailyProblemIfStale()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(MINUTE - 1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(3)
      controller.dispose()
    })

    it('sends when the window returns after the retry is due', async () => {
      let visible = true
      const { controller, fetchDailyProblem } = harness({}, () => visible)
      fetchDailyProblem.mockRejectedValue(new Error('refused'))

      await controller.loadDailyProblem()
      visible = false
      controller.clearScheduledRefresh()
      await vi.advanceTimersByTimeAsync(10 * MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)

      visible = true
      controller.refreshDailyProblemIfStale()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      controller.dispose()
    })

    it('does not bypass the wait when a failed manual lookup cleared the pending retry', async () => {
      const { controller, state, fetchDailyProblem, fetchProblemByNumber } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))
      fetchProblemByNumber.mockRejectedValue(new Error('not found'))

      await controller.loadDailyProblem()
      await controller.loadProblemByNumber('9999')
      expect(state.dailyRetryPending).toBe(false)

      controller.refreshDailyProblemIfStale()
      await vi.advanceTimersByTimeAsync(MINUTE - 1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      controller.dispose()
    })

    it('sends a user-driven retry immediately and counts its failure toward the streak', async () => {
      const { controller, fetchDailyProblem } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))

      await controller.loadDailyProblem()
      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)

      controller.retry()
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(2 * MINUTE - 1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(3)
      controller.dispose()
    })
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

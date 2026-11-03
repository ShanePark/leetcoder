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
  fetchProblemBySlug: ReturnType<typeof vi.fn<ProblemSelectionControllerBackend['fetchProblemBySlug']>>
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
  const fetchProblemBySlug = vi.fn<ProblemSelectionControllerBackend['fetchProblemBySlug']>()
  const render = vi.fn()
  const messages: Array<{ message: string; tone: string }> = []
  const backend: ProblemSelectionControllerBackend = {
    fetchDailyProblem,
    fetchProblemBySlug,
  }
  const controller = new ProblemSelectionController({
    state,
    backend,
    render,
    setMessage: (message, tone) => messages.push({ message, tone }),
    isWindowVisible,
    isDestroyed: () => false,
  })
  return { controller, state, fetchDailyProblem, fetchProblemBySlug, render, messages }
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
    expect(controller.problemUrlDraft).toBe('')

    state.problemSelection = 'manual'
    expect(controller.isViewingTodayProblem(selected)).toBe(true)
    expect(controller.isViewingTodayProblem(problem('1'))).toBe(false)
    controller.dispose()
  })

  it('loads a pasted URL with one request by slug and clears the draft', async () => {
    const { controller, state, fetchDailyProblem, fetchProblemBySlug, messages } = harness()
    const selected = problem('3', '')
    fetchProblemBySlug.mockResolvedValue(selected)
    const pasted = 'https://leetcode.com/problems/minimum-moves-to-equal-array-elements-iii/description/'
    controller.setProblemUrlDraft(pasted)

    const request = controller.loadProblemFromUrl(pasted)
    expect(state.dailyLoading).toBe(true)
    await request

    expect(fetchProblemBySlug.mock.calls).toEqual([['minimum-moves-to-equal-array-elements-iii']])
    expect(fetchDailyProblem).not.toHaveBeenCalled()
    expect(state.dailyProblem).toBe(selected)
    expect(state.problemSelection).toBe('manual')
    expect(state.dailyProblemDateKey).toBeNull()
    expect(state.dailyLoading).toBe(false)
    expect(controller.problemUrlDraft).toBe('')
    expect(messages).toEqual([])
    controller.dispose()
  })

  it.each([
    ['a bare number', '1'],
    ['a bare slug', 'two-sum'],
    ['another host', 'https://example.com/problems/two-sum/'],
    ['blank text', '   '],
  ])('sends nothing and keeps the text for %s', async (_case, pasted) => {
    const displayed = problem('1', '2026-08-23')
    const { controller, state, fetchDailyProblem, fetchProblemBySlug, messages } = harness({
      dailyProblem: displayed,
    })

    await controller.loadProblemFromUrl(pasted)

    expect(fetchProblemBySlug).not.toHaveBeenCalled()
    expect(fetchDailyProblem).not.toHaveBeenCalled()
    expect(state.dailyProblem).toBe(displayed)
    expect(state.dailyLoading).toBe(false)
    expect(controller.problemUrlDraft).toBe(pasted)
    expect(messages).toEqual([{
      message: 'Paste a LeetCode problem URL, such as https://leetcode.com/problems/two-sum/.',
      tone: 'error',
    }])
    controller.dispose()
  })

  it('keeps the displayed problem and the pasted text when a manual lookup fails', async () => {
    const displayed = problem('1', '2026-08-23')
    const { controller, state, fetchProblemBySlug, messages } = harness({
      dailyProblem: displayed,
    })
    fetchProblemBySlug.mockRejectedValue(new Error('not found'))
    const pasted = 'https://leetcode.com/problems/no-such-problem/'

    await controller.loadProblemFromUrl(pasted)

    expect(state.dailyProblem).toBe(displayed)
    expect(controller.problemUrlDraft).toBe(pasted)
    expect(state.problemSelection).toBe('daily')
    expect(messages).toEqual([{
      message: 'Could not load no-such-problem: not found',
      tone: 'error',
    }])
    controller.dispose()
  })

  it('retries a failed manual lookup with the same slug, whatever the input now holds', async () => {
    const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
    const selected = problem('1', '')
    fetchProblemBySlug.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(selected)

    await controller.loadProblemFromUrl('https://leetcode.com/problems/two-sum/')
    controller.setProblemUrlDraft('half typed')
    controller.retry()
    await vi.waitFor(() => {
      expect(state.dailyProblem).toBe(selected)
    })

    expect(fetchProblemBySlug.mock.calls).toEqual([['two-sum'], ['two-sum']])
    expect(fetchDailyProblem).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('retries the daily problem once a daily request followed a manual one', async () => {
    const { controller, fetchDailyProblem, fetchProblemBySlug } = harness()
    fetchProblemBySlug.mockRejectedValue(new Error('offline'))
    fetchDailyProblem.mockRejectedValue(new Error('offline'))

    await controller.loadProblemFromUrl('https://leetcode.com/problems/two-sum/')
    await controller.loadDailyProblem()
    controller.retry()

    expect(fetchProblemBySlug).toHaveBeenCalledOnce()
    expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('sends nothing for a pasted URL while another request is loading', async () => {
    const response = deferred<DailyProblem>()
    const { controller, fetchDailyProblem, fetchProblemBySlug } = harness()
    fetchDailyProblem.mockReturnValue(response.promise)

    const daily = controller.loadDailyProblem()
    await controller.loadProblemFromUrl('https://leetcode.com/problems/two-sum/')

    expect(fetchProblemBySlug).not.toHaveBeenCalled()
    response.resolve(problem('1'))
    await daily
    controller.dispose()
  })

  it('ignores a delayed manual response after disposal', async () => {
    const response = deferred<DailyProblem>()
    const { controller, state, fetchProblemBySlug } = harness()
    fetchProblemBySlug.mockReturnValue(response.promise)
    const pasted = 'https://leetcode.com/problems/two-sum/'

    const request = controller.loadProblemFromUrl(pasted)
    controller.dispose()
    response.resolve(problem('1', ''))
    await request

    expect(state.dailyProblem).toBeNull()
    expect(state.problemSelection).toBe('daily')
    expect(controller.problemUrlDraft).toBe(pasted)
  })

  it('leaves the draft blank when going back to today', () => {
    const { controller, fetchDailyProblem } = harness({ problemSelection: 'manual' })
    fetchDailyProblem.mockReturnValue(new Promise(() => {}))
    controller.setProblemUrlDraft('half typed')

    controller.selectToday()

    expect(controller.problemUrlDraft).toBe('')
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
      const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))
      fetchProblemBySlug.mockResolvedValue(problem('7', '2026-01-01'))

      await controller.loadDailyProblem()
      await vi.advanceTimersByTimeAsync(MINUTE)
      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)

      await controller.loadProblemFromUrl('https://leetcode.com/problems/problem-7/')
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

    it('goes back to today with no request while the loaded daily problem is current', async () => {
      const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
      const today = problem('2', '2026-09-10')
      fetchDailyProblem.mockResolvedValue(today)
      fetchProblemBySlug.mockResolvedValue(problem('7', ''))
      await controller.loadDailyProblem()
      await controller.loadProblemFromUrl('https://leetcode.com/problems/problem-7/')
      expect(state.dailyProblem?.frontendId).toBe('7')

      controller.selectToday()

      expect(fetchDailyProblem).toHaveBeenCalledTimes(1)
      expect(state.dailyProblem).toBe(today)
      expect(state.problemSelection).toBe('daily')
      expect(state.dailyProblemDateKey).toBe('2026-09-10')
      expect(state.dailyLoading).toBe(false)
      expect(controller.isViewingTodayProblem(today)).toBe(true)
      controller.dispose()
    })

    it('ignores a manual lookup still in flight when going back to today', async () => {
      const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
      const today = problem('2', '2026-09-10')
      fetchDailyProblem.mockResolvedValue(today)
      await controller.loadDailyProblem()
      let finishLookup: (value: DailyProblem) => void = () => {}
      fetchProblemBySlug.mockReturnValue(new Promise((resolve) => { finishLookup = resolve }))
      const lookup = controller.loadProblemFromUrl('https://leetcode.com/problems/problem-7/')

      controller.selectToday()
      finishLookup(problem('7', ''))
      await lookup

      expect(state.dailyProblem).toBe(today)
      expect(state.problemSelection).toBe('daily')
      expect(state.dailyLoading).toBe(false)
      controller.dispose()
    })

    it('asks again for today once the UTC date has changed', async () => {
      const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
      fetchDailyProblem
        .mockResolvedValueOnce(problem('2', '2026-09-10'))
        .mockResolvedValueOnce(problem('3', '2026-09-11'))
      fetchProblemBySlug.mockResolvedValue(problem('7', ''))
      await controller.loadDailyProblem()
      await controller.loadProblemFromUrl('https://leetcode.com/problems/problem-7/')

      vi.setSystemTime(new Date('2026-09-11T00:30:00.000Z'))
      controller.selectToday()
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchDailyProblem).toHaveBeenCalledTimes(2)
      expect(state.dailyProblem?.frontendId).toBe('3')
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
      const { controller, state, fetchDailyProblem, fetchProblemBySlug } = harness()
      fetchDailyProblem.mockRejectedValue(new Error('refused'))
      fetchProblemBySlug.mockRejectedValue(new Error('not found'))

      await controller.loadDailyProblem()
      await controller.loadProblemFromUrl('https://leetcode.com/problems/no-such-problem/')
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

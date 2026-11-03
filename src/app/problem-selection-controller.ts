import { errorMessage, type BackendClient, type DailyProblem } from '../backend'

import {
  normalizeDailyProblemDateKey,
  nextUtcMidnightDelayMs,
  problemSlugFromUrl,
  utcDateKey,
} from './layout'
import type { AppState } from './types'

const DAILY_RETRY_BASE_MS = 60_000
const DAILY_RETRY_MAX_MS = 30 * 60_000

type ProblemSelectionState = Pick<
  AppState,
  | 'dailyProblem'
  | 'problemSelection'
  | 'dailyProblemDateKey'
  | 'dailyRetryPending'
  | 'dailyError'
  | 'dailyLoading'
>

export interface ProblemSelectionControllerBackend {
  fetchDailyProblem: BackendClient['fetchDailyProblem']
  fetchProblemBySlug: BackendClient['fetchProblemBySlug']
}

export interface ProblemSelectionControllerHooks {
  readonly state: ProblemSelectionState
  readonly backend: ProblemSelectionControllerBackend
  readonly render: () => void
  readonly setMessage: (message: string, tone: 'info' | 'success' | 'error') => void
  readonly isWindowVisible: () => boolean
  readonly isDestroyed: () => boolean
}

/** Coordinates daily/manual problem selection and its date-based refresh lifecycle. */
export class ProblemSelectionController {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private requestId = 0
  private draft = ''
  /** The slug `retry` sends again, or null when the last request was for the daily problem. */
  private lastManualSlug: string | null = null
  /** Remember the current daily id while a manual problem is being viewed. */
  private latestDailyProblem: { frontendId: string; dateKey: string } | null = null
  private dailyRetryStreak = 0
  private nextDailyRetryAt = 0
  private disposed = false

  constructor(private readonly hooks: ProblemSelectionControllerHooks) {}

  get problemUrlDraft(): string {
    return this.draft
  }

  setProblemUrlDraft(value: string): void {
    this.draft = value
  }

  async loadDailyProblem(notifyOnError = false): Promise<void> {
    if (!this.isActive() || this.hooks.state.dailyLoading) {
      return
    }

    const requestId = ++this.requestId
    this.lastManualSlug = null
    this.hooks.state.dailyLoading = true
    this.hooks.state.dailyError = null
    this.hooks.render()

    try {
      const problem = await this.hooks.backend.fetchDailyProblem()
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      const problemDateKey = normalizeDailyProblemDateKey(problem.date)
      const currentDateKey = utcDateKey()
      if (!problemDateKey) {
        this.hooks.state.dailyRetryPending = true
        this.hooks.state.dailyError = 'The daily problem returned an invalid date.'
        if (notifyOnError) {
          this.hooks.setMessage(
            `Could not load today’s problem: ${this.hooks.state.dailyError}`,
            'error',
          )
        }
      } else if (problemDateKey !== currentDateKey) {
        // The provider still serves yesterday's problem. Keep the card in a
        // waiting state and poll again instead of treating it as a failure.
        this.hooks.state.dailyRetryPending = true
        this.hooks.state.dailyProblemDateKey = problemDateKey
        this.hooks.state.dailyError = null
        if (notifyOnError) {
          this.hooks.setMessage('Today’s problem is not available yet. Try again shortly.', 'info')
        }
      } else {
        this.hooks.state.dailyProblem = problem
        this.hooks.state.problemSelection = 'daily'
        this.latestDailyProblem = {
          frontendId: problem.frontendId,
          dateKey: problemDateKey,
        }
        this.hooks.state.dailyProblemDateKey = problemDateKey
        this.hooks.state.dailyRetryPending = false
        this.hooks.state.dailyError = null
        this.dailyRetryStreak = 0
        this.nextDailyRetryAt = 0
      }
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      const message = errorMessage(error)
      this.hooks.state.dailyRetryPending = true
      this.hooks.state.dailyError = message
      if (notifyOnError) {
        this.hooks.setMessage(`Could not load today’s problem: ${message}`, 'error')
      }
    } finally {
      if (this.isCurrentRequest(requestId)) {
        this.hooks.state.dailyLoading = false
        this.scheduleDailyProblemRefresh(
          this.hooks.state.dailyRetryPending
            ? this.backOffDailyRetry()
            : nextUtcMidnightDelayMs(),
        )
        this.hooks.render()
      }
    }
  }

  async loadProblemFromUrl(value: string): Promise<void> {
    if (!this.isActive()) {
      return
    }
    this.draft = value
    const slug = problemSlugFromUrl(value)
    if (!slug) {
      this.hooks.setMessage(
        'Paste a LeetCode problem URL, such as https://leetcode.com/problems/two-sum/.',
        'error',
      )
      return
    }
    await this.loadProblemBySlug(slug)
  }

  private async loadProblemBySlug(slug: string): Promise<void> {
    if (!this.isActive() || this.hooks.state.dailyLoading) {
      return
    }

    const requestId = ++this.requestId
    this.lastManualSlug = slug
    this.hooks.state.dailyLoading = true
    this.hooks.state.dailyError = null
    this.hooks.render()

    try {
      const problem = await this.hooks.backend.fetchProblemBySlug(slug)
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      this.hooks.state.dailyProblem = problem
      this.hooks.state.problemSelection = 'manual'
      this.hooks.state.dailyProblemDateKey = null
      this.hooks.state.dailyRetryPending = false
      this.hooks.state.dailyError = null
      this.draft = ''
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      // The displayed problem stays intact when a lookup fails, and so does the pasted text.
      const message = errorMessage(error)
      this.hooks.state.dailyRetryPending = false
      this.hooks.state.dailyError = message
      this.hooks.setMessage(`Could not load ${slug}: ${message}`, 'error')
    } finally {
      if (this.isCurrentRequest(requestId)) {
        this.hooks.state.dailyLoading = false
        this.scheduleDailyProblemRefresh()
        this.hooks.render()
      }
    }
  }

  retry(): void {
    if (this.lastManualSlug !== null) {
      void this.loadProblemBySlug(this.lastManualSlug)
      return
    }
    void this.loadDailyProblem(true)
  }

  selectToday(): void {
    if (!this.isActive()) {
      return
    }
    this.draft = ''
    this.hooks.state.problemSelection = 'daily'
    this.hooks.state.dailyProblemDateKey = null
    void this.loadDailyProblem(true)
  }

  refreshDailyProblemIfStale(): void {
    if (!this.isActive()) {
      return
    }
    const currentDateKey = utcDateKey()
    if (this.hooks.state.dailyLoading || this.hooks.state.problemSelection !== 'daily') {
      return
    }
    if (
      this.hooks.state.dailyRetryPending
      || !this.hooks.state.dailyProblem
      || this.hooks.state.dailyProblemDateKey !== currentDateKey
    ) {
      // Window returns land here too. The due time outlives dailyRetryPending,
      // which a failed manual lookup clears, so it is what gates the request.
      const remainingMs = this.nextDailyRetryAt - Date.now()
      if (remainingMs > 0) {
        this.scheduleDailyProblemRefresh(remainingMs)
        return
      }
      void this.loadDailyProblem()
      return
    }
    this.scheduleDailyProblemRefresh()
  }

  isViewingTodayProblem(problem: Pick<DailyProblem, 'frontendId'>): boolean {
    const currentDateKey = utcDateKey()
    if (this.hooks.state.problemSelection === 'daily') {
      return this.hooks.state.dailyProblemDateKey === currentDateKey
    }
    return this.latestDailyProblem?.frontendId === problem.frontendId
      && this.latestDailyProblem.dateKey === currentDateKey
  }

  clearScheduledRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.requestId += 1
    this.clearScheduledRefresh()
  }

  private backOffDailyRetry(): number {
    const delayMs = Math.min(DAILY_RETRY_BASE_MS * 2 ** this.dailyRetryStreak, DAILY_RETRY_MAX_MS)
    this.dailyRetryStreak += 1
    this.nextDailyRetryAt = Date.now() + delayMs
    return delayMs
  }

  private scheduleDailyProblemRefresh(delayMs = nextUtcMidnightDelayMs()): void {
    this.clearScheduledRefresh()
    if (
      !this.isActive()
      || this.hooks.state.dailyLoading
      || this.hooks.state.problemSelection !== 'daily'
      || !this.hooks.isWindowVisible()
    ) {
      return
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.isActive() || !this.hooks.isWindowVisible()) {
        return
      }
      this.refreshDailyProblemIfStale()
    }, Math.max(1, delayMs))
  }

  private isActive(): boolean {
    return !this.disposed && !this.hooks.isDestroyed()
  }

  private isCurrentRequest(requestId: number): boolean {
    return this.isActive() && requestId === this.requestId
  }
}

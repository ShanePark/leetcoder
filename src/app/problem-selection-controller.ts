import { errorMessage, type BackendClient, type DailyProblem } from '../backend'

import {
  normalizeDailyProblemDateKey,
  normalizeProblemNumber,
  nextUtcMidnightDelayMs,
  utcDateKey,
} from './layout'
import type { AppState, ProblemSelection } from './types'

const DAILY_RETRY_INTERVAL_MS = 60_000

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
  fetchProblemByNumber: BackendClient['fetchProblemByNumber']
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
  private draft: string | null = null
  private lastProblemRequest: ProblemSelection = 'daily'
  /** Remember the current daily id while a manual problem is being viewed. */
  private latestDailyProblem: { frontendId: string; dateKey: string } | null = null
  private disposed = false

  constructor(private readonly hooks: ProblemSelectionControllerHooks) {}

  get problemNumberDraft(): string | null {
    return this.draft
  }

  setProblemNumberDraft(value: string): void {
    this.draft = value
  }

  async loadDailyProblem(notifyOnError = false): Promise<void> {
    if (!this.isActive() || this.hooks.state.dailyLoading) {
      return
    }

    const requestId = ++this.requestId
    this.lastProblemRequest = 'daily'
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
        this.draft = problem.frontendId
        this.latestDailyProblem = {
          frontendId: problem.frontendId,
          dateKey: problemDateKey,
        }
        this.hooks.state.dailyProblemDateKey = problemDateKey
        this.hooks.state.dailyRetryPending = false
        this.hooks.state.dailyError = null
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
            ? DAILY_RETRY_INTERVAL_MS
            : nextUtcMidnightDelayMs(),
        )
        this.hooks.render()
      }
    }
  }

  async loadProblemByNumber(value: string): Promise<void> {
    if (!this.isActive()) {
      return
    }
    const problemNumber = normalizeProblemNumber(value)
    if (!problemNumber) {
      this.hooks.setMessage('Enter a valid LeetCode problem number.', 'error')
      return
    }
    if (this.hooks.state.dailyLoading) {
      return
    }

    const requestId = ++this.requestId
    this.lastProblemRequest = 'manual'
    this.draft = problemNumber
    this.hooks.state.dailyLoading = true
    this.hooks.state.dailyError = null
    this.hooks.render()

    try {
      const problem = await this.hooks.backend.fetchProblemByNumber(problemNumber)
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      this.hooks.state.dailyProblem = problem
      this.hooks.state.problemSelection = 'manual'
      this.hooks.state.dailyProblemDateKey = null
      this.hooks.state.dailyRetryPending = false
      this.hooks.state.dailyError = null
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) {
        return
      }
      // Keep the currently displayed problem intact when a lookup fails.
      if (this.hooks.state.dailyProblem && this.draft === problemNumber) {
        this.draft = this.hooks.state.dailyProblem.frontendId
      }
      const message = errorMessage(error)
      this.hooks.state.dailyRetryPending = false
      this.hooks.state.dailyError = message
      this.hooks.setMessage(`Could not load problem #${problemNumber}: ${message}`, 'error')
    } finally {
      if (this.isCurrentRequest(requestId)) {
        this.hooks.state.dailyLoading = false
        this.scheduleDailyProblemRefresh()
        this.hooks.render()
      }
    }
  }

  retry(): void {
    if (this.lastProblemRequest === 'manual') {
      void this.loadProblemByNumber(this.draft ?? '')
      return
    }
    void this.loadDailyProblem(true)
  }

  selectToday(): void {
    if (!this.isActive()) {
      return
    }
    this.draft = null
    this.hooks.state.problemSelection = 'daily'
    this.hooks.state.dailyProblemDateKey = null
    void this.loadDailyProblem(true)
  }

  refreshSelectedProblem(): void {
    if (this.hooks.state.problemSelection === 'manual' && this.hooks.state.dailyProblem) {
      void this.loadProblemByNumber(this.hooks.state.dailyProblem.frontendId)
      return
    }
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

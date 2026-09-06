import type { ProblemDiagnostic } from './backend'

/** The exact editor state a diagnostics request is allowed to describe. */
export interface LiveDiagnosticsSnapshot {
  repoPath: string
  relativePath: string
  fullyQualifiedClassName: string
  source: string
}

export interface LiveDiagnosticsSchedulerOptions {
  delayMs?: number
  check: (snapshot: LiveDiagnosticsSnapshot) => Promise<readonly ProblemDiagnostic[]>
  onResult: (snapshot: LiveDiagnosticsSnapshot, diagnostics: readonly ProblemDiagnostic[]) => void
  onError?: (snapshot: LiveDiagnosticsSnapshot, error: unknown) => void
}

/**
 * Coalesces editor snapshots into one delayed compiler request at a time.
 *
 * A native compile cannot be cancelled reliably, so every request carries the
 * generation at which it started. Any newer edit, file switch, repository
 * switch, or test run makes that response ineligible to update the editor.
 */
export class LiveDiagnosticsScheduler {
  private readonly delayMs: number
  private readonly check: LiveDiagnosticsSchedulerOptions['check']
  private readonly onResult: LiveDiagnosticsSchedulerOptions['onResult']
  private readonly onError: NonNullable<LiveDiagnosticsSchedulerOptions['onError']> | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: LiveDiagnosticsSnapshot | null = null
  private active: LiveDiagnosticsSnapshot | null = null
  private pendingReadyAt = 0
  private inFlight = false
  private blocked = false
  private disposed = false
  private generation = 0

  constructor(options: LiveDiagnosticsSchedulerOptions) {
    this.delayMs = Number.isFinite(options.delayMs)
      ? Math.max(0, Math.trunc(options.delayMs ?? 0))
      : 700
    this.check = options.check
    this.onResult = options.onResult
    this.onError = options.onError
  }

  /** Queue the newest source snapshot and restart its debounce window. */
  schedule(snapshot: LiveDiagnosticsSnapshot): void {
    if (this.disposed) {
      return
    }
    this.generation += 1
    this.pending = snapshot
    this.pendingReadyAt = Date.now() + this.delayMs
    this.clearTimer()
    this.armTimer()
  }

  /**
   * Pause compiler work while a test process owns the repository. The latest
   * snapshot remains queued and starts after the pause ends.
   */
  setBlocked(blocked: boolean): void {
    if (this.disposed || this.blocked === blocked) {
      return
    }
    this.blocked = blocked
    if (blocked) {
      this.clearTimer()
      this.generation += 1
      // If a request was already running, retain its source for a fresh check
      // once the test process releases the repository.
      if (!this.pending && this.active) {
        this.pending = this.active
        this.pendingReadyAt = Date.now() + this.delayMs
      }
      return
    }
    this.armTimer()
  }

  /** Invalidate all queued and in-flight work for a file/repository switch. */
  cancel(): void {
    if (this.disposed) {
      return
    }
    this.generation += 1
    this.pending = null
    this.pendingReadyAt = 0
    this.clearTimer()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.generation += 1
    this.pending = null
    this.active = null
    this.clearTimer()
  }

  private armTimer(): void {
    if (this.disposed || this.blocked || !this.pending || this.inFlight || this.timer !== null) {
      return
    }
    const delay = Math.max(0, this.pendingReadyAt - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || this.blocked || !this.pending) {
        return
      }
      if (this.inFlight) {
        // The active request's finally handler will arm this pending snapshot
        // using its original ready time.
        return
      }
      this.start()
    }, delay)
  }

  private start(): void {
    const snapshot = this.pending
    if (this.disposed || this.blocked || !snapshot || this.inFlight) {
      return
    }
    this.pending = null
    this.pendingReadyAt = 0
    this.active = snapshot
    const requestGeneration = this.generation
    this.inFlight = true

    void Promise.resolve()
      .then(() => this.check(snapshot))
      .then((diagnostics) => {
        if (this.disposed || this.blocked || requestGeneration !== this.generation) {
          return
        }
        this.onResult(snapshot, diagnostics)
      })
      .catch((error: unknown) => {
        if (this.disposed || this.blocked || requestGeneration !== this.generation) {
          return
        }
        this.onError?.(snapshot, error)
      })
      .finally(() => {
        this.inFlight = false
        this.active = null
        this.armTimer()
      })
  }

  private clearTimer(): void {
    if (this.timer === null) {
      return
    }
    clearTimeout(this.timer)
    this.timer = null
  }
}

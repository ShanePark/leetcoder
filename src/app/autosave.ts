import type {
  AutosaveCoordinatorOptions,
  AutosaveSnapshot,
  AutosaveStatus,
} from './types'

/**
 * Coalesces editor changes into one debounced write and follows an in-flight
 * write with the newest snapshot when the document changes while saving.
 * While held, debounced writes wait for release(); explicit flushes still write.
 */
export class AutosaveCoordinator {
  private readonly save: (snapshot: AutosaveSnapshot) => Promise<void>
  private readonly delayMs: number
  private readonly onStatusChange?: (status: AutosaveStatus) => void
  private readonly onError?: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: AutosaveSnapshot | null = null
  private running: Promise<void> | null = null
  private currentStatus: AutosaveStatus = 'idle'
  private disposed = false
  private held = false
  /** A debounced write was skipped while held and is owed on release. */
  private deferred = false

  constructor(
    save: (snapshot: AutosaveSnapshot) => Promise<void>,
    options: AutosaveCoordinatorOptions = {},
  ) {
    this.save = save
    this.delayMs = options.delayMs ?? 500
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
  }

  get status(): AutosaveStatus {
    return this.currentStatus
  }

  get hasPendingChanges(): boolean {
    return this.pending !== null || this.running !== null
  }

  /**
   * Drop work that has not started yet. Callers should flush first when the
   * pending source must be written before an external filesystem operation.
   */
  cancelPending(): void {
    this.clearTimer()
    this.deferred = false
    this.pending = null
    if (!this.running) {
      this.setStatus('idle')
    }
  }

  schedule(snapshot: AutosaveSnapshot): void {
    if (this.disposed) {
      return
    }
    this.pending = snapshot
    this.clearTimer()
    this.setStatus('saving')
    if (this.held) {
      this.deferred = true
      return
    }
    this.startTimer()
  }

  /** Defer debounced writes, keeping edits pending until release(). */
  hold(): void {
    this.held = true
    if (this.timer !== null) {
      this.clearTimer()
      this.deferred = true
    }
  }

  /** Resume debounced writes and debounce any edit deferred while held. */
  release(): void {
    if (!this.held) {
      return
    }
    this.held = false
    const deferred = this.deferred
    this.deferred = false
    if (deferred && this.pending && !this.disposed) {
      this.startTimer()
    }
  }

  async flush(): Promise<void> {
    this.clearTimer()
    // An explicit flush takes over any deferred write. A failed snapshot stays
    // pending for an explicit retry instead of being retried on release.
    this.deferred = false
    if (!this.pending && !this.running) {
      return
    }
    await (this.running ?? this.startRun())
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private startTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch((error) => this.onError?.(error))
    }, this.delayMs)
  }

  private startRun(): Promise<void> {
    const run = this.persistPending()
    this.running = run
    void run.then(
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
    )
    return run
  }

  private async persistPending(): Promise<void> {
    while (this.pending) {
      const snapshot = this.pending
      this.pending = null
      this.setStatus('saving')
      try {
        await this.save(snapshot)
      } catch (error) {
        // Keep the failed snapshot available for an explicit retry. If a
        // newer edit already arrived, that newer snapshot is sufficient.
        this.pending ??= snapshot
        this.setStatus('error')
        throw error
      }
    }
    this.setStatus('idle')
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setStatus(status: AutosaveStatus): void {
    this.currentStatus = status
    this.onStatusChange?.(status)
  }
}

export type { AutosaveCoordinatorOptions, AutosaveSnapshot, AutosaveStatus }

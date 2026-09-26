import type { PsLibraryMetadata } from '../backend'

export const PS_LIBRARY_CONFIG_DEBOUNCE_MS = 300
export const PS_LIBRARY_REVALIDATE_INTERVAL_MS = 30_000

type InspectPsLibrary = (repoPath: string) => Promise<PsLibraryMetadata>

export interface PsLibraryControllerOptions {
  readonly backend: { inspectPsLibrary?: InspectPsLibrary }
  readonly setMetadata: (metadata: PsLibraryMetadata | null) => void
  readonly setMessage: (message: string, tone: 'error') => void
}

/** Load project-specific Ps signatures when a repository or its Gradle inputs change. */
export class PsLibraryController {
  private readonly backend: PsLibraryControllerOptions['backend']
  private readonly setMetadata: PsLibraryControllerOptions['setMetadata']
  private readonly setMessage: PsLibraryControllerOptions['setMessage']
  private repoPath: string | null = null
  private generation = 0
  private inFlight = false
  private dirty = false
  private disposed = false
  private configTimer: ReturnType<typeof setTimeout> | null = null
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private notifiedFailure = false

  constructor(options: PsLibraryControllerOptions) {
    this.backend = options.backend
    this.setMetadata = options.setMetadata
    this.setMessage = options.setMessage
  }

  /** Select a validated repository, dropping signatures from the previous one. */
  setRepository(repoPath: string | null): void {
    if (this.disposed) {
      return
    }
    if (this.repoPath === repoPath) {
      if (repoPath) this.revalidateIfStale()
      return
    }

    this.generation += 1
    this.clearConfigTimer()
    this.repoPath = repoPath
    this.dirty = false
    this.notifiedFailure = false
    this.setMetadata(null)
    if (repoPath) {
      this.requestCurrent()
    }
  }

  /** Invalidate immediately, then coalesce a burst of Gradle file events. */
  invalidate(): void {
    if (this.disposed || !this.repoPath) {
      return
    }
    this.generation += 1
    this.notifiedFailure = false
    this.setMetadata(null)
    this.clearConfigTimer()
    this.configTimer = setTimeout(() => {
      this.configTimer = null
      this.requestCurrent()
    }, PS_LIBRARY_CONFIG_DEBOUNCE_MS)
  }

  /** Recheck after returning to the app, with a throttle for repeated focus events. */
  revalidateIfStale(): void {
    if (this.disposed || !this.repoPath || this.configTimer !== null || this.inFlight) {
      return
    }
    if (Date.now() - this.lastRequestAt < PS_LIBRARY_REVALIDATE_INTERVAL_MS) {
      return
    }
    this.requestCurrent()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.generation += 1
    this.repoPath = null
    this.dirty = false
    this.clearConfigTimer()
  }

  private requestCurrent(): void {
    const repoPath = this.repoPath
    if (this.disposed || !repoPath) {
      return
    }
    if (this.inFlight) {
      this.dirty = true
      return
    }
    const inspectPsLibrary = this.backend.inspectPsLibrary
    if (typeof inspectPsLibrary !== 'function') {
      this.setMetadata(null)
      return
    }

    const generation = this.generation
    this.inFlight = true
    this.lastRequestAt = Date.now()
    void inspectPsLibrary.call(this.backend, repoPath).then((metadata) => {
      if (!this.isCurrent(repoPath, generation)) {
        return
      }
      this.notifiedFailure = false
      this.setMetadata(metadata)
    }).catch((error: unknown) => {
      if (!this.isCurrent(repoPath, generation)) {
        return
      }
      this.setMetadata(null)
      if (!this.notifiedFailure) {
        this.notifiedFailure = true
        const detail = error instanceof Error ? error.message : String(error)
        this.setMessage(
          `Could not load Ps completions: ${detail}. Check the project's Gradle configuration and try again.`,
          'error',
        )
      }
    }).finally(() => {
      this.inFlight = false
      if (this.dirty && !this.disposed && this.repoPath) {
        this.dirty = false
        this.requestCurrent()
      }
    })
  }

  private isCurrent(repoPath: string, generation: number): boolean {
    return !this.disposed && this.repoPath === repoPath && this.generation === generation
  }

  private clearConfigTimer(): void {
    if (this.configTimer !== null) {
      clearTimeout(this.configTimer)
      this.configTimer = null
    }
  }
}

/** Gradle inputs that can alter the Ps API on the selected project's classpath. */
export function isPsBuildConfigurationPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  if (/^(?:build|settings)\.gradle(?:\.kts)?$/.test(normalized)
    || normalized === 'gradle.properties') {
    return true
  }
  if (normalized === 'gradle') {
    return true
  }
  if (!normalized.startsWith('gradle/')) {
    return false
  }
  const relative = normalized.slice('gradle/'.length)
  return relative === 'wrapper/gradle-wrapper.properties'
    || (!relative.includes('/') && relative.endsWith('.versions.toml'))
}

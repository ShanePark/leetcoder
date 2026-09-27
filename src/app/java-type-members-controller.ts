import type { JavaTypeMembers, JavaTypeMembersMetadata } from '../backend'

export const JAVA_TYPE_MEMBERS_CONFIG_DEBOUNCE_MS = 300
export const JAVA_TYPE_MEMBERS_REVALIDATE_INTERVAL_MS = 30_000

const MAX_JAVA_TYPE_MEMBERS_PER_REQUEST = 16
const MAX_CACHED_JAVA_TYPES = 128

type InspectJavaTypeMembers = (
  repoPath: string,
  typeNames: string[],
) => Promise<JavaTypeMembersMetadata>

export interface JavaTypeMembersControllerOptions {
  readonly backend: { inspectJavaTypeMembers?: InspectJavaTypeMembers }
}

interface InspectionWaiter {
  readonly repoPath: string
  generation: number
  readonly typeNames: string[]
  readonly resolve: (metadata: JavaTypeMembersMetadata) => void
}

interface InFlightInspection {
  readonly id: number
  readonly repoPath: string
  readonly generation: number
  readonly typeNames: string[]
}

/** Lazily inspect and cache public Java members for the selected repository. */
export class JavaTypeMembersController {
  private readonly backend: JavaTypeMembersControllerOptions['backend']
  private repoPath: string | null = null
  private generation = 0
  private nextInspectionId = 0
  private fingerprint = ''
  private readonly cache = new Map<string, JavaTypeMembers>()
  private readonly knownTypes = new Set<string>()
  private readonly pendingTypes = new Set<string>()
  private waiters: InspectionWaiter[] = []
  private inFlight: InFlightInspection | null = null
  private configTimer: ReturnType<typeof setTimeout> | null = null
  private flushScheduled = false
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(options: JavaTypeMembersControllerOptions) {
    this.backend = options.backend
  }

  /** Select the repository whose classpath should be used for future requests. */
  setRepository(repoPath: string | null): void {
    if (this.disposed || this.repoPath === repoPath) return

    this.advanceGeneration(false)
    this.repoPath = repoPath
    this.clearMetadata()
    this.knownTypes.clear()
  }

  /** Inspect a batch of types, using cached results and coalescing concurrent requests. */
  inspect(typeNames: string[]): Promise<JavaTypeMembersMetadata> {
    const requestedTypes = [...new Set(typeNames.filter((name) => name.length > 0))]
    const repoPath = this.repoPath
    const inspectJavaTypeMembers = this.backend.inspectJavaTypeMembers
    if (this.disposed || !repoPath || typeof inspectJavaTypeMembers !== 'function') {
      return Promise.resolve(this.createMetadata(requestedTypes))
    }
    if (requestedTypes.length === 0) {
      return Promise.resolve(this.createMetadata([]))
    }

    for (const typeName of requestedTypes) {
      this.rememberType(typeName)
    }
    const missing = requestedTypes.filter((typeName) => !this.cache.has(typeName))
    if (missing.length === 0) {
      return Promise.resolve(this.createMetadata(requestedTypes))
    }

    const promise = new Promise<JavaTypeMembersMetadata>((resolve) => {
      this.waiters.push({ repoPath, generation: this.generation, typeNames: requestedTypes, resolve })
    })
    for (const typeName of missing) this.pendingTypes.add(typeName)
    this.scheduleFlush()
    return promise
  }

  /** Invalidate classpath results after Gradle configuration changes. */
  invalidate(): void {
    if (this.disposed || !this.repoPath) return
    const typesToRefresh = new Set(this.knownTypes)
    for (const typeName of this.pendingTypes) typesToRefresh.add(typeName)
    if (this.inFlight?.generation === this.generation) {
      for (const typeName of this.inFlight.typeNames) typesToRefresh.add(typeName)
    }
    for (const waiter of this.waiters) {
      if (waiter.repoPath === this.repoPath && waiter.generation === this.generation) {
        for (const typeName of waiter.typeNames) typesToRefresh.add(typeName)
      }
    }

    this.advanceGeneration(true)
    this.clearMetadata()
    for (const typeName of typesToRefresh) this.pendingTypes.add(typeName)
    this.clearConfigTimer()
    this.configTimer = setTimeout(() => {
      this.configTimer = null
      this.scheduleFlush()
    }, JAVA_TYPE_MEMBERS_CONFIG_DEBOUNCE_MS)
  }

  /** Refresh known types on return to the app so classpath changes are observed. */
  revalidateIfStale(): void {
    if (this.disposed || !this.repoPath || this.configTimer !== null || this.inFlight) return
    if (Date.now() - this.lastRequestAt < JAVA_TYPE_MEMBERS_REVALIDATE_INTERVAL_MS) return
    if (this.knownTypes.size === 0) return

    const typesToRefresh = [...this.knownTypes]
    this.advanceGeneration(true)
    this.clearMetadata()
    for (const typeName of typesToRefresh) this.pendingTypes.add(typeName)
    this.scheduleFlush()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.advanceGeneration(false)
    this.repoPath = null
    this.clearMetadata()
    this.knownTypes.clear()
  }

  private scheduleFlush(): void {
    if (this.disposed || this.configTimer !== null || this.flushScheduled || this.inFlight) return
    this.flushScheduled = true
    void Promise.resolve().then(() => {
      this.flushScheduled = false
      void this.flushPendingTypes()
    })
  }

  private async flushPendingTypes(): Promise<void> {
    const repoPath = this.repoPath
    const inspectJavaTypeMembers = this.backend.inspectJavaTypeMembers
    if (this.disposed || !repoPath || typeof inspectJavaTypeMembers !== 'function' || this.inFlight) {
      this.resolveReadyWaiters()
      return
    }

    const typeNames: string[] = []
    for (const typeName of this.pendingTypes) {
      if (this.cache.has(typeName)) {
        this.pendingTypes.delete(typeName)
        continue
      }
      typeNames.push(typeName)
      this.pendingTypes.delete(typeName)
      if (typeNames.length === MAX_JAVA_TYPE_MEMBERS_PER_REQUEST) break
    }
    if (typeNames.length === 0) {
      this.resolveReadyWaiters()
      return
    }

    const flight: InFlightInspection = {
      id: ++this.nextInspectionId,
      repoPath,
      generation: this.generation,
      typeNames,
    }
    this.inFlight = flight
    this.lastRequestAt = Date.now()
    try {
      const metadata = await inspectJavaTypeMembers.call(this.backend, repoPath, typeNames)
      if (!this.isCurrent(flight)) return
      this.mergeMetadata(metadata, typeNames)
    } catch {
      if (!this.isCurrent(flight)) return
      for (const typeName of typeNames) {
        this.cacheType({ typeName, available: false, methods: [], fields: [] })
      }
    } finally {
      if (this.inFlight?.id === flight.id) this.inFlight = null
      if (this.isCurrentGeneration(flight.repoPath, flight.generation)) {
        this.resolveReadyWaiters()
        if (this.pendingTypes.size > 0) this.scheduleFlush()
      }
    }
  }

  private mergeMetadata(metadata: JavaTypeMembersMetadata, requestedTypes: string[]): void {
    if (this.fingerprint && metadata.fingerprint !== this.fingerprint) {
      for (const typeName of this.cache.keys()) {
        if (!requestedTypes.includes(typeName)) this.pendingTypes.add(typeName)
      }
      this.cache.clear()
    }
    this.fingerprint = metadata.fingerprint
    const returnedTypes = new Map(metadata.types.map((type) => [type.typeName, type]))
    for (const typeName of requestedTypes) {
      this.cacheType(returnedTypes.get(typeName) ?? {
        typeName,
        available: false,
        methods: [],
        fields: [],
      })
    }
  }

  private cacheType(type: JavaTypeMembers): void {
    this.cache.delete(type.typeName)
    this.cache.set(type.typeName, type)
    while (this.cache.size > MAX_CACHED_JAVA_TYPES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private rememberType(typeName: string): void {
    this.knownTypes.delete(typeName)
    this.knownTypes.add(typeName)
    while (this.knownTypes.size > MAX_CACHED_JAVA_TYPES) {
      const oldest = this.knownTypes.values().next().value as string | undefined
      if (oldest === undefined) break
      this.knownTypes.delete(oldest)
      this.cache.delete(oldest)
    }
  }

  private resolveReadyWaiters(): void {
    const remaining: InspectionWaiter[] = []
    for (const waiter of this.waiters) {
      if (!this.isCurrentGeneration(waiter.repoPath, waiter.generation)) {
        waiter.resolve(this.createMetadata(waiter.typeNames))
      } else if (waiter.typeNames.every((typeName) => this.cache.has(typeName))) {
        waiter.resolve(this.createMetadata(waiter.typeNames))
      } else {
        remaining.push(waiter)
      }
    }
    this.waiters = remaining
  }

  private createMetadata(typeNames: string[]): JavaTypeMembersMetadata {
    return {
      fingerprint: this.fingerprint,
      types: typeNames.map((typeName) => this.cache.get(typeName) ?? {
        typeName,
        available: false,
        methods: [],
        fields: [],
      }),
    }
  }

  private advanceGeneration(preserveWaiters: boolean): void {
    this.generation += 1
    this.inFlight = null
    this.pendingTypes.clear()
    if (preserveWaiters) {
      for (const waiter of this.waiters) waiter.generation = this.generation
    } else {
      for (const waiter of this.waiters) waiter.resolve(this.unavailableMetadata(waiter.typeNames))
      this.waiters = []
    }
  }

  private unavailableMetadata(typeNames: string[]): JavaTypeMembersMetadata {
    return {
      fingerprint: '',
      types: typeNames.map((typeName) => ({
        typeName,
        available: false,
        methods: [],
        fields: [],
      })),
    }
  }

  private clearMetadata(): void {
    this.fingerprint = ''
    this.cache.clear()
    this.lastRequestAt = Number.NEGATIVE_INFINITY
    this.clearConfigTimer()
    this.flushScheduled = false
  }

  private clearConfigTimer(): void {
    if (this.configTimer !== null) {
      clearTimeout(this.configTimer)
      this.configTimer = null
    }
  }

  private isCurrent(flight: InFlightInspection): boolean {
    return this.isCurrentGeneration(flight.repoPath, flight.generation)
  }

  private isCurrentGeneration(repoPath: string, generation: number): boolean {
    return !this.disposed && this.repoPath === repoPath && this.generation === generation
  }
}

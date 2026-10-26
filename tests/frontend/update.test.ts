import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createUpdateController,
  type UpdateControllerApi,
  type UpdateFailureKind,
  type UpdatePhase,
} from '../../src/update-controller'
import {
  createUpdateStatusView,
  describeUpdateStatus,
  estimateUpdateBuildProgress,
  formatUpdateElapsed,
  formatUpdateRemaining,
  measureUpdateBuildStages,
  normaliseUpdateProgress,
  readUpdateBuildDurations,
  UPDATE_BUILD_DURATIONS_KEY,
  updateActionPresentation,
  type UpdateBuildTiming,
  type UpdateStageDurations,
} from '../../src/update-progress'
import type { UpdateBuild, UpdateStatus } from '../../src/backend'

vi.mock('../../src/icons', () => ({
  iconFor: (name: string) => ({ name }),
}))

function updateStatus(available: boolean, supported = true): UpdateStatus {
  return {
    supported,
    available,
    currentCommit: 'current',
    latestCommit: available ? 'latest' : 'current',
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(overrides: Partial<UpdateControllerApi> = {}) {
  const phases: Array<[UpdatePhase, UpdateBuild | null]> = []
  const errors: Array<[UpdateFailureKind, string]> = []
  const api: UpdateControllerApi = {
    checkForUpdate: vi.fn(async () => updateStatus(true)),
    buildUpdate: vi.fn(async () => ({ commit: 'abcdef1234567' })),
    prepareToClose: vi.fn(async () => {}),
    applyUpdate: vi.fn(async () => {}),
    ...overrides,
  }
  const controller = createUpdateController(api, {
    setPhase: (phase, build) => phases.push([phase, build]),
    showError: (kind, message) => errors.push([kind, message]),
  })
  return { api, controller, phases, errors }
}

function timing(overrides: Partial<UpdateBuildTiming> = {}): UpdateBuildTiming {
  return { stageStarts: {}, history: null, floor: 0, ...overrides }
}

/** A previous build: 10s frontend, 40s compile, 20s bundle, 10s staging. */
const HISTORY: UpdateStageDurations = { validating: 0, frontend: 10_000, compiling: 40_000, bundling: 20_000, staging: 10_000 }

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value)
    }),
  }
}

describe('update progress', () => {
  it('normalizes build and apply stages with per-phase totals', () => {
    expect(normaliseUpdateProgress({ stage: 'compiling', step: 2, total: 4, message: ' Compiling ', detail: ' Compiling app ' })).toEqual({
      stage: 'compiling',
      phase: 'build',
      step: 2,
      total: 4,
      message: 'Compiling',
      detail: 'Compiling app',
    })
    expect(normaliseUpdateProgress({ stage: 'staging', step: 99, total: 0, message: '' })).toEqual({
      stage: 'staging',
      phase: 'build',
      step: 4,
      total: 4,
      message: 'Preparing the update',
    })
    // Defaults come from the stage table; validating and frontend share step 1.
    expect(normaliseUpdateProgress({ stage: 'validating' })).toMatchObject({ step: 1, total: 4, message: 'Checking the latest local commit' })
    expect(normaliseUpdateProgress({ stage: 'frontend' })).toMatchObject({ phase: 'build', step: 1, total: 4, message: 'Building the frontend' })
    expect(normaliseUpdateProgress({ stage: 'compiling' })).toMatchObject({ step: 2, message: 'Compiling the app' })
    expect(normaliseUpdateProgress({ stage: 'bundling' })).toMatchObject({ step: 3, message: 'Bundling the app' })
    // The old single build stage is gone.
    expect(normaliseUpdateProgress({ stage: 'building', step: 2, total: 3 })).toBeNull()
    expect(normaliseUpdateProgress({ stage: 'restarting' })).toMatchObject({
      phase: 'apply',
      step: 2,
      total: 2,
      message: 'Restarting leetcoder',
    })
    expect(normaliseUpdateProgress({ stage: 'unknown' })).toBeNull()
    expect(normaliseUpdateProgress(null)).toBeNull()
    expect(formatUpdateElapsed(65)).toBe('1m 5s')
    expect(formatUpdateRemaining(39_200)).toBe('40s')
    expect(formatUpdateRemaining(65_000)).toBe('1m 5s')
  })

  it('falls back to the completed-step fraction without history', () => {
    expect(estimateUpdateBuildProgress({ stage: 'validating', step: 1, total: 4, stageElapsed: 5_000, history: null }))
      .toEqual({ fraction: 0, percent: null, remaining: null, overrun: false })
    expect(estimateUpdateBuildProgress({ stage: 'bundling', step: 3, total: 4, stageElapsed: 5_000, history: null }))
      .toEqual({ fraction: 0.5, percent: null, remaining: null, overrun: false })
    // No estimate for the current stage also falls back.
    expect(estimateUpdateBuildProgress({ stage: 'compiling', step: 2, total: 4, stageElapsed: 0, history: { frontend: 10_000 } }))
      .toMatchObject({ fraction: 0.25, percent: null })
  })

  it('estimates progress and time left from previous stage durations', () => {
    // 10s frontend done + 20s of a 40s compile = 30s of 80s.
    expect(estimateUpdateBuildProgress({ stage: 'compiling', step: 2, total: 4, stageElapsed: 20_000, history: HISTORY }))
      .toEqual({ fraction: 0.375, percent: 37, remaining: 50_000, overrun: false })
    // A stage only fills to 95% of its estimate.
    expect(estimateUpdateBuildProgress({ stage: 'frontend', step: 1, total: 4, stageElapsed: 10_000, history: HISTORY }))
      .toMatchObject({ fraction: 9_500 / 80_000, overrun: false, remaining: 70_500 })
  })

  it('counts a skipped stage as done', () => {
    // Compiling was skipped: bundling starts after frontend and compile.
    expect(estimateUpdateBuildProgress({ stage: 'bundling', step: 3, total: 4, stageElapsed: 5_000, history: HISTORY }))
      .toEqual({ fraction: 55_000 / 80_000, percent: 68, remaining: 25_000, overrun: false })
  })

  it('reports almost done when the current stage overruns its estimate', () => {
    expect(estimateUpdateBuildProgress({ stage: 'staging', step: 4, total: 4, stageElapsed: 15_000, history: HISTORY }))
      .toEqual({ fraction: 79_500 / 80_000, percent: 99, remaining: null, overrun: true })
    const model = describeUpdateStatus({
      kind: 'building',
      startedAt: 0,
      progress: normaliseUpdateProgress({ stage: 'staging' }),
      timing: timing({ stageStarts: { staging: 0 }, history: HISTORY }),
    }, 15_000)
    expect(model.progress?.text).toBe('99% · almost done')
  })

  it('keeps the later stages as time left when an earlier stage overruns', () => {
    const estimate = estimateUpdateBuildProgress({ stage: 'frontend', step: 1, total: 4, stageElapsed: 60_000, history: HISTORY })
    expect(estimate.overrun).toBe(true)
    expect(estimate.remaining).toBe(HISTORY.compiling! + HISTORY.bundling! + HISTORY.staging!)
  })

  it('never moves the bar backwards', () => {
    expect(estimateUpdateBuildProgress({ stage: 'compiling', step: 2, total: 4, stageElapsed: 0, history: HISTORY, floor: 0.6 }))
      .toMatchObject({ fraction: 0.6, percent: 60, remaining: 32_000 })
  })

  it('measures each seen stage until the next one starts or the build is ready', () => {
    expect(measureUpdateBuildStages({ validating: 0, frontend: 1_000, bundling: 11_000, staging: 31_000 }, 41_000)).toEqual({
      validating: 1_000,
      frontend: 10_000,
      bundling: 20_000,
      staging: 10_000,
    })
    expect(measureUpdateBuildStages({}, 1_000)).toEqual({})
  })

  it('tolerates unreadable stored durations', () => {
    expect(readUpdateBuildDurations(undefined)).toBeNull()
    expect(readUpdateBuildDurations(memoryStorage({ [UPDATE_BUILD_DURATIONS_KEY]: '{not json' }))).toBeNull()
    expect(readUpdateBuildDurations({
      getItem: () => { throw new Error('denied') },
      setItem: () => {},
    })).toBeNull()
    expect(readUpdateBuildDurations(memoryStorage({
      [UPDATE_BUILD_DURATIONS_KEY]: JSON.stringify({ frontend: 10_000, compiling: 'slow', building: 5, staging: -1 }),
    }))).toEqual({ frontend: 10_000 })
  })

  it('describes each status row state', () => {
    expect(describeUpdateStatus({ kind: 'idle' }, 0).visible).toBe(false)

    const building = describeUpdateStatus({
      kind: 'building',
      startedAt: 1_000,
      progress: normaliseUpdateProgress({ stage: 'compiling', step: 2, total: 4, message: 'Compiling the app', detail: 'Compiling leetcoder v0.1.0' }),
      timing: timing(),
    }, 66_000)
    expect(building).toMatchObject({
      visible: true,
      tone: 'busy',
      message: 'Compiling the app · 2/4',
      detail: 'Compiling leetcoder v0.1.0',
      title: 'Compiling leetcoder v0.1.0',
      elapsedSeconds: 65,
      progress: { fraction: 0.25, text: '', valueText: 'Step 2 of 4' },
      restart: false,
      dismiss: false,
    })
    // Before the first event the row shows the first step.
    expect(describeUpdateStatus({ kind: 'building', startedAt: 0, progress: null, timing: timing() }, 0)).toMatchObject({
      message: 'Checking the latest local commit · 1/4',
      detail: '',
      progress: { fraction: 0 },
    })
    // With history the bar carries a percentage and the time left.
    expect(describeUpdateStatus({
      kind: 'building',
      startedAt: 0,
      progress: normaliseUpdateProgress({ stage: 'bundling' }),
      timing: timing({ stageStarts: { frontend: 0, bundling: 10_000 }, history: HISTORY }),
    }, 15_000).progress).toEqual({
      fraction: 55_000 / 80_000,
      text: '68% · about 25s left',
      valueText: '68% · about 25s left',
    })

    expect(describeUpdateStatus({ kind: 'applying', startedAt: 0, progress: null }, 0)).toMatchObject({
      message: 'Restarting leetcoder…',
      detail: 'Installing the update',
      progress: null,
    })
    expect(describeUpdateStatus({ kind: 'ready', commit: 'abcdef1234567' }, 0)).toMatchObject({
      tone: 'ready',
      message: 'Update ready',
      detail: 'abcdef1',
      elapsedSeconds: null,
      restart: true,
      dismiss: false,
    })
    expect(describeUpdateStatus({ kind: 'failed', message: '\nrelease build failed\nerror: details' }, 0)).toMatchObject({
      tone: 'error',
      message: 'Update failed: release build failed',
      title: '\nrelease build failed\nerror: details',
      restart: false,
      dismiss: true,
    })
  })

  it('presents the update action for every visible phase', () => {
    expect(updateActionPresentation('hidden')).toBeNull()
    expect(updateActionPresentation('available')).toMatchObject({ icon: 'download', busy: false })
    expect(updateActionPresentation('building')).toMatchObject({ icon: 'loader', busy: true })
    expect(updateActionPresentation('ready')).toMatchObject({
      icon: 'refresh',
      busy: false,
      menuLabel: 'Restart to update',
      menuDetail: 'Install the new build',
    })
    expect(updateActionPresentation('applying')).toMatchObject({ icon: 'loader', busy: true })
  })
})

class FakeElement {
  hidden = false
  textContent = ''
  title = ''
  dateTime = ''
  firstChild: unknown = null
  readonly style = { width: '' }
  readonly dataset: Record<string, string> = {}
  readonly children: unknown[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, () => void>()
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (name: string, force: boolean) => {
      if (force) this.classes.add(name)
      else this.classes.delete(name)
    },
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(child: unknown): void {
    this.children.push(child)
    this.firstChild = this.children[0]
  }

  replaceChildren(...children: unknown[]): void {
    this.children.splice(0, this.children.length, ...children)
    this.firstChild = this.children[0] ?? null
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }
}

function createStatusRoot() {
  const ids = [
    'update-status',
    'update-status-icon',
    'update-status-message',
    'update-status-progress',
    'update-status-bar',
    'update-status-bar-fill',
    'update-status-estimate',
    'update-status-detail',
    'update-status-elapsed',
    'update-status-restart',
    'update-status-dismiss',
  ] as const
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()])) as Record<typeof ids[number], FakeElement>
  elements['update-status'].hidden = true
  const root = {
    querySelector: (selector: string) => elements[selector.slice(1) as typeof ids[number]] ?? null,
  }
  return { root: root as unknown as HTMLElement, elements }
}

describe('update status row', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows build progress, the ready restart action, and a dismissible failure without moving focus', () => {
    vi.useFakeTimers()
    let now = 10_000
    const onRestart = vi.fn()
    const { root, elements } = createStatusRoot()
    const view = createUpdateStatusView(root, { onRestart, now: () => now, storage: undefined })
    const row = elements['update-status']

    view.setPhase('available', null)
    expect(row.hidden).toBe(true)

    view.setPhase('building', null)
    expect(row.hidden).toBe(false)
    expect(row.dataset.tone).toBe('busy')
    expect(elements['update-status-message'].textContent).toBe('Checking the latest local commit · 1/4')
    expect(elements['update-status-icon'].classes.has('is-spinning')).toBe(true)
    expect(elements['update-status-progress'].hidden).toBe(false)
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('0')
    expect(elements['update-status-estimate'].hidden).toBe(true)

    // Apply-phase events are ignored while building.
    view.update({ stage: 'preparing', step: 1, total: 2, message: 'Installing the update' })
    expect(elements['update-status-message'].textContent).toBe('Checking the latest local commit · 1/4')

    view.update({ stage: 'compiling', step: 2, total: 4, message: 'Compiling the app', detail: 'Compiling leetcoder' })
    expect(elements['update-status-message'].textContent).toBe('Compiling the app · 2/4')
    expect(elements['update-status-detail'].textContent).toBe('Compiling leetcoder')
    expect(row.title).toBe('Compiling leetcoder')
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('25')
    expect(elements['update-status-bar'].attributes.get('aria-valuetext')).toBe('Step 2 of 4')
    expect(elements['update-status-bar-fill'].style.width).toBe('25%')

    now += 3_000
    vi.advanceTimersByTime(1_000)
    expect(elements['update-status-elapsed'].textContent).toBe('3s')
    expect(elements['update-status-elapsed'].hidden).toBe(false)

    view.setPhase('ready', { commit: 'abcdef1234567' })
    expect(row.dataset.tone).toBe('ready')
    expect(elements['update-status-message'].textContent).toBe('Update ready')
    expect(elements['update-status-detail'].textContent).toBe('abcdef1')
    expect(elements['update-status-elapsed'].hidden).toBe(true)
    expect(elements['update-status-progress'].hidden).toBe(true)
    expect(elements['update-status-restart'].hidden).toBe(false)
    elements['update-status-restart'].listeners.get('click')?.()
    expect(onRestart).toHaveBeenCalledOnce()

    view.setPhase('applying', { commit: 'abcdef1234567' })
    expect(elements['update-status-message'].textContent).toBe('Restarting leetcoder…')
    expect(elements['update-status-restart'].hidden).toBe(true)

    view.setPhase('available', null)
    view.showFailed('install failed')
    expect(row.hidden).toBe(false)
    expect(row.dataset.tone).toBe('error')
    expect(elements['update-status-message'].textContent).toBe('Update failed: install failed')
    expect(elements['update-status-dismiss'].hidden).toBe(false)

    // A later poll keeps the failure visible until it is dismissed.
    view.setPhase('hidden', null)
    expect(row.hidden).toBe(false)
    elements['update-status-dismiss'].listeners.get('click')?.()
    expect(row.hidden).toBe(true)

    view.dispose()
    expect(elements['update-status-restart'].listeners.size).toBe(0)
  })

  it('records stage durations on success and estimates the next build from them', () => {
    vi.useFakeTimers()
    let now = 0
    const storage = memoryStorage({ [UPDATE_BUILD_DURATIONS_KEY]: JSON.stringify({ compiling: 99_000 }) })
    const { root, elements } = createStatusRoot()
    const view = createUpdateStatusView(root, { onRestart: vi.fn(), now: () => now, storage })

    view.setPhase('building', null)
    view.update({ stage: 'validating', step: 1, total: 4, message: 'Checking the latest local commit' })
    now = 1_000
    view.update({ stage: 'frontend', step: 1, total: 4, message: 'Building the frontend' })
    now = 5_000
    view.update({ stage: 'frontend', step: 1, total: 4, message: 'Building the frontend', detail: 'vite build' })
    // Compiling is skipped; a repeated stage keeps its first start time.
    now = 11_000
    view.update({ stage: 'bundling', step: 3, total: 4, message: 'Bundling the app' })
    now = 31_000
    view.update({ stage: 'staging', step: 4, total: 4, message: 'Preparing the update' })
    now = 41_000
    view.setPhase('ready', { commit: 'abc' })

    expect(storage.setItem).toHaveBeenCalledOnce()
    // The skipped stage keeps its earlier duration.
    expect(JSON.parse(storage.data.get(UPDATE_BUILD_DURATIONS_KEY)!)).toEqual({
      validating: 1_000,
      frontend: 10_000,
      compiling: 99_000,
      bundling: 20_000,
      staging: 10_000,
    })

    // The next build reads the estimate: 1s validating + 10s frontend + 2s of compile.
    now = 100_000
    view.setPhase('building', null)
    view.update({ stage: 'compiling', step: 2, total: 4, message: 'Compiling the app' })
    now = 102_000
    vi.advanceTimersByTime(1_000)
    expect(elements['update-status-estimate'].hidden).toBe(false)
    expect(elements['update-status-estimate'].textContent).toBe('9% · about 2m 7s left')
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('9')
    view.dispose()
  })

  it('does not save durations from a failed build or a ready state it did not build', () => {
    let now = 0
    const storage = memoryStorage()
    const { root } = createStatusRoot()
    const view = createUpdateStatusView(root, { onRestart: vi.fn(), now: () => now, storage })

    view.setPhase('building', null)
    view.update({ stage: 'frontend', step: 1, total: 4, message: 'Building the frontend' })
    now = 5_000
    view.showFailed('release build failed')
    view.setPhase('available', null)
    // A ready build restored after an apply failure was not timed here.
    view.setPhase('ready', { commit: 'abc' })
    expect(storage.setItem).not.toHaveBeenCalled()
    view.dispose()
  })

  it('keeps working when storage throws', () => {
    let now = 0
    const storage = {
      getItem: vi.fn(() => { throw new Error('denied') }),
      setItem: vi.fn(() => { throw new Error('quota') }),
    }
    const { root, elements } = createStatusRoot()
    const view = createUpdateStatusView(root, { onRestart: vi.fn(), now: () => now, storage })

    view.setPhase('building', null)
    view.update({ stage: 'bundling', step: 3, total: 4, message: 'Bundling the app' })
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('50')
    now = 1_000
    expect(() => view.setPhase('ready', { commit: 'abc' })).not.toThrow()
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(elements['update-status-message'].textContent).toBe('Update ready')
    view.dispose()
  })

  it('keeps the bar from moving backwards when the estimate drops', () => {
    let now = 0
    // No compile estimate: compiling falls back to steps, bundling uses history.
    const storage = memoryStorage({
      [UPDATE_BUILD_DURATIONS_KEY]: JSON.stringify({ validating: 0, frontend: 1_000, bundling: 50_000, staging: 49_000 }),
    })
    const { root, elements } = createStatusRoot()
    const view = createUpdateStatusView(root, { onRestart: vi.fn(), now: () => now, storage })

    view.setPhase('building', null)
    view.update({ stage: 'compiling', step: 2, total: 4, message: 'Compiling the app' })
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('25')
    now = 1_000
    view.update({ stage: 'bundling', step: 3, total: 4, message: 'Bundling the app' })
    // History alone would say 1%.
    expect(elements['update-status-bar'].attributes.get('aria-valuenow')).toBe('25')
    expect(elements['update-status-estimate'].textContent).toBe('25% · about 1m 15s left')
    view.dispose()
  })
})

describe('update controller', () => {
  it('only exposes supported available updates', async () => {
    const { controller, phases } = createHarness({
      checkForUpdate: async () => updateStatus(true, false),
    })
    await controller.checkForUpdate()
    expect(controller.phase).toBe('hidden')
    expect(phases).toEqual([])

    const available = createHarness()
    await available.controller.checkForUpdate()
    expect(available.phases).toEqual([['available', null]])
  })

  it('builds in the background, ignores clicks while building, and becomes ready', async () => {
    const build = deferred<UpdateBuild>()
    const { api, controller, phases } = createHarness({ buildUpdate: () => build.promise })
    await controller.checkForUpdate()

    const building = controller.activate()
    expect(controller.phase).toBe('building')
    await controller.activate()
    await controller.checkForUpdate()
    expect(api.checkForUpdate).toHaveBeenCalledOnce()

    build.resolve({ commit: 'abc1234' })
    await building
    expect(controller.phase).toBe('ready')
    expect(phases).toEqual([
      ['available', null],
      ['building', null],
      ['ready', { commit: 'abc1234' }],
    ])
    expect(api.prepareToClose).not.toHaveBeenCalled()
    expect(api.applyUpdate).not.toHaveBeenCalled()
  })

  it('keeps a ready build when newer commits appear', async () => {
    const { api, controller } = createHarness()
    await controller.checkForUpdate()
    await controller.activate()
    expect(controller.phase).toBe('ready')

    vi.mocked(api.checkForUpdate).mockResolvedValue(updateStatus(false))
    await controller.checkForUpdate()
    expect(controller.phase).toBe('ready')
    expect(api.checkForUpdate).toHaveBeenCalledOnce()
  })

  it('restores the button and reports a build failure', async () => {
    const build = deferred<UpdateBuild>()
    const check = deferred<UpdateStatus>()
    let checks = 0
    const { controller, phases, errors } = createHarness({
      checkForUpdate: () => {
        checks += 1
        return checks === 1 ? Promise.resolve(updateStatus(true)) : check.promise
      },
      buildUpdate: () => build.promise,
    })
    await controller.checkForUpdate()
    const building = controller.activate()
    build.reject(new Error('release build failed'))
    await building
    expect(controller.phase).toBe('available')
    expect(errors).toEqual([['build', 'release build failed']])
    expect(phases.at(-1)).toEqual(['available', null])

    // Checks do not overlap.
    const first = controller.checkForUpdate()
    const second = controller.checkForUpdate()
    expect(checks).toBe(2)
    check.resolve(updateStatus(false))
    await Promise.all([first, second])
    expect(controller.phase).toBe('hidden')
  })

  it('ignores a poll that started before the build began', async () => {
    const check = deferred<UpdateStatus>()
    const build = deferred<UpdateBuild>()
    let checks = 0
    const { controller } = createHarness({
      checkForUpdate: () => {
        checks += 1
        return checks === 1 ? Promise.resolve(updateStatus(true)) : check.promise
      },
      buildUpdate: () => build.promise,
    })
    await controller.checkForUpdate()
    const stalePoll = controller.checkForUpdate()
    const building = controller.activate()
    build.reject(new Error('failed'))
    await building
    check.resolve(updateStatus(false))
    await stalePoll
    expect(controller.phase).toBe('available')
  })

  it('flushes autosave before applying and stays ready when that fails', async () => {
    const prepare = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    const apply = deferred<void>()
    const { api, controller, phases, errors } = createHarness({
      prepareToClose: prepare,
      applyUpdate: vi.fn(() => apply.promise),
    })
    await controller.checkForUpdate()
    await controller.activate()

    await controller.activate()
    expect(errors).toEqual([['prepare', 'disk full']])
    expect(controller.phase).toBe('ready')
    expect(api.applyUpdate).not.toHaveBeenCalled()
    expect(phases.slice(-2)).toEqual([
      ['applying', { commit: 'abcdef1234567' }],
      ['ready', { commit: 'abcdef1234567' }],
    ])

    const applying = controller.activate()
    await vi.waitFor(() => expect(api.applyUpdate).toHaveBeenCalledOnce())
    expect(controller.phase).toBe('applying')
    await controller.activate()
    expect(prepare).toHaveBeenCalledTimes(2)
    apply.resolve()
    await applying
    expect(controller.phase).toBe('applying')
  })

  it('returns to available after an apply failure', async () => {
    const { controller, errors } = createHarness({
      applyUpdate: async () => {
        throw new Error('staged build is missing')
      },
    })
    await controller.checkForUpdate()
    await controller.activate()
    await controller.activate()
    expect(controller.phase).toBe('available')
    expect(errors).toEqual([['apply', 'staged build is missing']])
  })
})

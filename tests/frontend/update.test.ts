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
  formatUpdateElapsed,
  normaliseUpdateProgress,
  updateActionPresentation,
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

describe('update progress', () => {
  it('normalizes build and apply stages with per-phase totals', () => {
    expect(normaliseUpdateProgress({ stage: 'building', step: 2, total: 3, message: ' Building ', detail: ' Compiling app ' })).toEqual({
      stage: 'building',
      phase: 'build',
      step: 2,
      total: 3,
      message: 'Building',
      detail: 'Compiling app',
    })
    expect(normaliseUpdateProgress({ stage: 'staging', step: 99, total: 0, message: '' })).toEqual({
      stage: 'staging',
      phase: 'build',
      step: 3,
      total: 3,
      message: 'Preparing the update',
    })
    expect(normaliseUpdateProgress({ stage: 'restarting' })).toMatchObject({
      phase: 'apply',
      step: 2,
      total: 2,
      message: 'Restarting leetcoder',
    })
    expect(normaliseUpdateProgress({ stage: 'unknown' })).toBeNull()
    expect(normaliseUpdateProgress(null)).toBeNull()
    expect(formatUpdateElapsed(65)).toBe('1m 5s')
  })

  it('describes each status row state', () => {
    expect(describeUpdateStatus({ kind: 'idle' }, 0).visible).toBe(false)

    const building = describeUpdateStatus({
      kind: 'building',
      startedAt: 1_000,
      progress: normaliseUpdateProgress({ stage: 'building', message: 'Building the update', detail: 'Compiling leetcoder v0.1.0' }),
    }, 66_000)
    expect(building).toMatchObject({
      visible: true,
      tone: 'busy',
      message: 'Building the update',
      detail: 'Compiling leetcoder v0.1.0',
      elapsedSeconds: 65,
      restart: false,
      dismiss: false,
    })
    // The build output line belongs to the building stage only.
    expect(describeUpdateStatus({
      kind: 'building',
      startedAt: 0,
      progress: normaliseUpdateProgress({ stage: 'staging', detail: 'stale line' }),
    }, 0).detail).toBe('')

    expect(describeUpdateStatus({ kind: 'applying', startedAt: 0, progress: null }, 0)).toMatchObject({
      message: 'Restarting leetcoder…',
      detail: 'Installing the update',
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
  const ids = ['update-status', 'update-status-icon', 'update-status-message', 'update-status-detail', 'update-status-elapsed', 'update-status-restart', 'update-status-dismiss'] as const
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
    const view = createUpdateStatusView(root, { onRestart, now: () => now })
    const row = elements['update-status']

    view.setPhase('available', null)
    expect(row.hidden).toBe(true)

    view.setPhase('building', null)
    expect(row.hidden).toBe(false)
    expect(row.dataset.tone).toBe('busy')
    expect(elements['update-status-message'].textContent).toBe('Checking the latest local commit')
    expect(elements['update-status-icon'].classes.has('is-spinning')).toBe(true)

    // Apply-phase events are ignored while building.
    view.update({ stage: 'preparing', step: 1, total: 2, message: 'Installing the update' })
    expect(elements['update-status-message'].textContent).toBe('Checking the latest local commit')

    view.update({ stage: 'building', step: 2, total: 3, message: 'Building the update', detail: 'Compiling leetcoder' })
    expect(elements['update-status-message'].textContent).toBe('Building the update')
    expect(elements['update-status-detail'].textContent).toBe('Compiling leetcoder')

    now += 3_000
    vi.advanceTimersByTime(1_000)
    expect(elements['update-status-elapsed'].textContent).toBe('3s')
    expect(elements['update-status-elapsed'].hidden).toBe(false)

    view.setPhase('ready', { commit: 'abcdef1234567' })
    expect(row.dataset.tone).toBe('ready')
    expect(elements['update-status-message'].textContent).toBe('Update ready')
    expect(elements['update-status-detail'].textContent).toBe('abcdef1')
    expect(elements['update-status-elapsed'].hidden).toBe(true)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testMocks } from './lifecycle-mocks'
import {
  LeetcoderApp, createBackend, deferred, installDom, rememberedStorage, startApp,
  file, dailyProblem, FakeElement, setNavigatorPlatform, type DomHarness,
} from './lifecycle-harness'
import type { ProjectValidation } from '../../../src/backend'
import { ToastController, type ToastAction } from '../../../src/app/toast-controller'

describe('LeetcoderApp lifecycle', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDom()
  })

  afterEach(() => {
    dom.restore()
  })

  it('offers folder recovery for a blocked remembered project and retries once after settings', async () => {
    const restorePlatform = setNavigatorPlatform('MacIntel')
    let actions: readonly ToastAction[] = []
    const dismiss = vi.fn()
    const show = vi.spyOn(ToastController.prototype, 'show').mockImplementation((_message, _tone, nextActions) => {
      if (nextActions) actions = nextActions
      return { dismiss, isVisible: () => true }
    })
    const { backend } = createBackend()
    vi.mocked(backend.validateProject).mockResolvedValueOnce({
      valid: false,
      message: "Unable to resolve projectRoot '/repo': Operation not permitted",
    } as ProjectValidation)
    const openSettings = vi.fn().mockResolvedValue(undefined)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend, storage: rememberedStorage() as unknown as Storage,
      openPermissionSettings: openSettings,
    })
    try {
      await app.start()
      expect(actions.map((action) => action.label)).toEqual(['Choose folder again', 'Open permission settings'])
      expect(show.mock.calls.at(-1)?.[0]).toContain('macOS may have blocked access')
      expect(backend.listProblemFiles).not.toHaveBeenCalled()
      await actions[1].run()
      dom.window.dispatch('focus')
      dom.document.dispatch('visibilitychange')
      await vi.waitFor(() => { expect(dismiss).toHaveBeenCalledOnce() })
      expect(openSettings).toHaveBeenCalledOnce()
      expect(backend.validateProject).toHaveBeenCalledTimes(2)
      expect(backend.listProblemFiles).toHaveBeenCalledOnce()
      expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
    } finally {
      await app.destroy()
      show.mockRestore()
      restorePlatform()
    }
  })

  it('flushes an edited document through prepareToClose and rejects save failures', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const selectFile = testMocks.fileViewCallbacks.at(-1)?.onFileSelect
    expect(selectFile).toBeDefined()
    selectFile?.(file)
    await vi.waitFor(() => {
      expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', file.path)
    })

    const editor = testMocks.editorInstances.at(-1)
    expect(editor).toBeDefined()
    const save = deferred<void>()
    backend.saveProblemFile = vi.fn(() => save.promise)
    editor?.emitChange('class Q1TwoSum { int value = 1; }')

    let settled = false
    const preparation = app.prepareToClose().then(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(backend.saveProblemFile).toHaveBeenCalledWith(
        '/repo',
        file.path,
        'class Q1TwoSum { int value = 1; }',
      )
    })
    expect(settled).toBe(false)
    save.resolve()
    await expect(preparation).resolves.toBeUndefined()

    const failedSave = vi.fn().mockRejectedValue(new Error('disk full'))
    backend.saveProblemFile = failedSave
    editor?.emitChange('class Q1TwoSum { int value = 2; }')
    await expect(app.prepareToClose()).rejects.toThrow('disk full')
    expect(failedSave).toHaveBeenCalledWith(
      '/repo',
      file.path,
      'class Q1TwoSum { int value = 2; }',
    )

    const listenersBeforeFailedDestroy = dom.window.totalListenerCount()
    await expect(app.destroy()).rejects.toThrow('disk full')
    expect(dom.window.totalListenerCount()).toBe(listenersBeforeFailedDestroy)

    // Resolve the pending retry so the fixture can tear down through the same
    // close path a real desktop window uses.
    backend.saveProblemFile = vi.fn().mockResolvedValue(undefined)
    await app.destroy()
  })

  it('unsubscribes repository callbacks and removes global listeners on destroy', async () => {
    const { backend, watcher } = createBackend()
    const app = await startApp(dom, backend)
    expect(watcher.current).not.toBeNull()
    expect(dom.window.totalListenerCount()).toBeGreaterThan(0)
    expect(dom.document.listenerCount('visibilitychange')).toBe(1)

    const listedBeforeDestroy = vi.mocked(backend.listProblemFiles).mock.calls.length
    const staleWatcher = watcher.current
    await app.destroy()

    expect(watcher.unsubscribe).toHaveBeenCalledOnce()
    expect(dom.window.totalListenerCount()).toBe(0)
    expect(dom.document.totalListenerCount()).toBe(0)
    staleWatcher?.({ paths: [file.path], structural: true })
    expect(backend.listProblemFiles).toHaveBeenCalledTimes(listedBeforeDestroy)

    // A recreated app owns exactly its own global listeners; the first app's
    // handlers must not remain attached to the shared window.
    const second = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    expect(dom.window.totalListenerCount()).toBeGreaterThan(0)
    await second.destroy()
    expect(dom.window.totalListenerCount()).toBe(0)
    expect(dom.document.totalListenerCount()).toBe(0)
  })

  it('exposes Stop during a run and routes it to the test controller', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const appInternals = app as unknown as {
      state: {
        testRun: {
          id: number
          status: 'running'
          phase: string
          startedAt: number
          tests: []
          stdout: string
          stderr: string
          activeTest: null
          error: null
          testMethod: null
          stopRequested: boolean
        } | null
        busy: boolean
      }
      renderAll: () => void
    }
    appInternals.state.testRun = {
      id: 1,
      status: 'running',
      phase: 'test',
      startedAt: Date.now(),
      tests: [],
      stdout: '',
      stderr: '',
      activeTest: null,
      error: null,
      testMethod: null,
      stopRequested: false,
    }
    appInternals.state.busy = true
    appInternals.renderAll()

    const button = dom.root.querySelector<FakeElement>('#run-test')
    const label = dom.root.querySelector<FakeElement>('#run-label')
    expect(label.textContent).toBe('Stop')
    expect(button.disabled).toBe(false)
    expect(button.classList.contains('is-stop-action')).toBe(true)

    button.dispatch('click')
    expect(testMocks.testRunControllers.at(-1)?.stopCurrentRun).toHaveBeenCalledOnce()
    const activeRun = appInternals.state.testRun!
    activeRun.stopRequested = true
    appInternals.renderAll()
    expect(label.textContent).toBe('Stopping…')
    expect(button.disabled).toBe(true)
    await app.destroy()
  })

  it('does not gate remembered repository startup on a pending daily request', async () => {
    const { backend } = createBackend()
    const daily = deferred<typeof dailyProblem>()
    backend.fetchDailyProblem = vi.fn(() => daily.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })

    let started = false
    const startup = app.start().then(() => {
      started = true
    })

    await vi.waitFor(() => {
      expect(backend.listProblemFiles).toHaveBeenCalledWith('/repo')
      expect(started).toBe(false)
    })
    expect(backend.fetchDailyProblem).toHaveBeenCalledOnce()

    await app.destroy()
    daily.resolve(dailyProblem)
    await startup
    expect(started).toBe(true)
  })

  it('stops remembered repository startup when validation finishes after destroy', async () => {
    const { backend } = createBackend()
    const validation = deferred<ProjectValidation>()
    backend.validateProject = vi.fn(() => validation.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.validateProject).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    validation.resolve({ valid: true })
    await startup

    expect(backend.listProblemFiles).not.toHaveBeenCalled()
    expect(backend.watchRepository).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })

  it('does not apply a file listing that finishes after destroy', async () => {
    const { backend } = createBackend()
    const files = deferred<ProblemFileEntry[]>()
    backend.listProblemFiles = vi.fn(() => files.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.listProblemFiles).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    files.resolve([file])
    await startup

    expect(backend.watchRepository).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })

  it('stops a watcher that finishes installing after destroy', async () => {
    const { backend } = createBackend()
    const watching = deferred<void>()
    backend.watchRepository = vi.fn(() => watching.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.watchRepository).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    const stopsBeforeLateWatcher = vi.mocked(backend.stopWatchingRepository).mock.calls.length
    watching.resolve()
    await startup

    expect(vi.mocked(backend.stopWatchingRepository).mock.calls.length)
      .toBe(stopsBeforeLateWatcher + 1)
    expect(backend.inspectPsLibrary).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })


})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testMocks } from './lifecycle-mocks'
import {
  LeetcoderApp, createBackend, deferred, installDom, rememberedStorage, startApp,
  file, psLibraryMetadata, type DomHarness,
} from './lifecycle-harness'
import { UPDATE_CHECK_INTERVAL_MS } from '../../../src/update-controller'

describe('LeetcoderApp background services', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDom()
  })

  afterEach(() => {
    dom.restore()
  })

  it('loads Ps metadata per repository and refreshes after Gradle config changes', async () => {
    vi.useFakeTimers()
    try {
      const { backend, watcher } = createBackend()
      const app = await startApp(dom, backend)
      const editor = testMocks.editorInstances.at(-1)!

      await Promise.resolve()
      await Promise.resolve()
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
      expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
      expect(editor.metadataUpdates.at(-1)).toEqual(psLibraryMetadata)

      editor.emitChange('class Q1TwoSum { int value = 1; }')
      watcher.current?.({ paths: [file.path], structural: false })
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      watcher.current?.({ paths: ['gradle/libs.versions.toml'], structural: false })
      expect(editor.metadataUpdates.at(-1)).toBeNull()
      await vi.advanceTimersByTimeAsync(300)
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      expect(editor.metadataUpdates.at(-1)).toEqual(psLibraryMetadata)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates Ps metadata on app focus without refetching repeatedly', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = createBackend()
      const app = await startApp(dom, backend)
      await Promise.resolve()
      await Promise.resolve()
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      dom.window.dispatch('focus')
      dom.document.dispatch('visibilitychange')
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(30_000)
      dom.window.dispatch('focus')
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      dom.window.dispatch('focus')
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts Ps inspection only after repository watching finishes', async () => {
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
    expect(backend.inspectPsLibrary).not.toHaveBeenCalled()

    watching.resolve()
    await startup
    expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
    expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
    await app.destroy()
  })

  it('loads Ps metadata even when repository watching is unavailable', async () => {
    const { backend } = createBackend()
    backend.watchRepository = vi.fn().mockRejectedValue(new Error('watch unavailable'))
    const app = await startApp(dom, backend)

    await Promise.resolve()
    expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
    expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
    await app.destroy()
  })

  it('pauses update polling while hidden and resumes on visibility return', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = createBackend()
      const app = await startApp(dom, backend)
      await Promise.resolve()
      expect(backend.checkForUpdate).toHaveBeenCalledOnce()

      dom.document.visibilityState = 'hidden'
      dom.document.dispatch('visibilitychange')
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2)
      expect(backend.checkForUpdate).toHaveBeenCalledOnce()

      dom.document.visibilityState = 'visible'
      dom.document.dispatch('visibilitychange')
      expect(backend.checkForUpdate).toHaveBeenCalledTimes(2)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles missed file changes on focus when repository watching is unavailable', async () => {
    const { backend } = createBackend()
    backend.watchRepository = vi.fn().mockRejectedValue(new Error('watch unavailable'))
    const app = await startApp(dom, backend)
    const added = { ...file, name: 'Q2AddTwoNumbers.java', path: 'src/main/java/easy/Q2AddTwoNumbers.java' }
    vi.mocked(backend.listProblemFiles).mockResolvedValue([added])

    dom.window.dispatch('focus')

    await vi.waitFor(() => {
      expect(testMocks.filenameMatchedPaths).toEqual([added.path])
    })
    expect(backend.listProblemFiles).toHaveBeenCalledTimes(2)
    await app.destroy()
  })

  it('keeps unsaved editor changes while reconciling the file list on visibility return', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    testMocks.fileViewCallbacks.at(-1)?.onFileSelect(file)
    await vi.waitFor(() => {
      expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', file.path)
    })
    const source = 'class Q1TwoSum { int unsaved = 1; }'
    testMocks.editorInstances.at(-1)?.emitChange(source)
    const added = { ...file, name: 'Q2AddTwoNumbers.java', path: 'src/main/java/easy/Q2AddTwoNumbers.java' }
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, added])

    dom.document.dispatch('visibilitychange')

    await vi.waitFor(() => {
      expect(testMocks.filenameMatchedPaths).toEqual([file.path, added.path])
    })
    await app.prepareToClose()
    expect(backend.saveProblemFile).toHaveBeenCalledWith('/repo', file.path, source)
    await app.destroy()
  })

  it('does not apply a focus file listing after the repository changes', async () => {
    const { backend } = createBackend()
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
      directoryPicker: async () => '/other',
    })
    await app.start()
    const pending = deferred<typeof file[]>()
    const other = { ...file, name: 'Q2AddTwoNumbers.java', path: 'src/main/java/easy/Q2AddTwoNumbers.java' }
    vi.mocked(backend.listProblemFiles)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue([other])

    dom.window.dispatch('focus')
    dom.root.querySelector('#choose-repository').dispatch('click')
    await vi.waitFor(() => {
      expect(testMocks.filenameMatchedPaths).toEqual([other.path])
    })
    pending.resolve([file])
    await Promise.resolve()
    await Promise.resolve()

    expect(testMocks.filenameMatchedPaths).toEqual([other.path])
    expect(backend.listProblemFiles).toHaveBeenLastCalledWith('/other')
    await app.destroy()
  })

  it('coalesces focus and visibility return while a file listing is pending', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const pending = deferred<typeof file[]>()
    vi.mocked(backend.listProblemFiles).mockImplementationOnce(() => pending.promise)

    dom.window.dispatch('focus')
    dom.document.dispatch('visibilitychange')
    dom.window.dispatch('focus')
    expect(backend.listProblemFiles).toHaveBeenCalledTimes(2)

    pending.resolve([file])
    await Promise.resolve()
    await Promise.resolve()
    dom.window.dispatch('focus')
    expect(backend.listProblemFiles).toHaveBeenCalledTimes(3)
    await app.destroy()
  })

})

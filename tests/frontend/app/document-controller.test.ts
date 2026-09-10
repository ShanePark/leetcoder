import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DocumentController,
  type DocumentControllerBackend,
  type DocumentControllerContext,
  type DocumentControllerEditor,
  type DocumentControllerState,
} from '../../../src/app/document-controller'
import type { ProblemFileEntry } from '../../../src/backend'

const fileA: ProblemFileEntry = {
  path: 'src/main/java/easy/Q1TwoSum.java',
  name: 'Q1TwoSum.java',
  packageSegment: 'easy',
}
const fileB: ProblemFileEntry = {
  path: 'src/main/java/easy/Q20ValidParentheses.java',
  name: 'Q20ValidParentheses.java',
  packageSegment: 'easy',
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

function createState(overrides: Partial<DocumentControllerState> = {}): DocumentControllerState {
  return {
    repoPath: '/repo',
    projectValid: true,
    files: [fileA, fileB],
    openTabs: [],
    activeTabId: null,
    selectedPath: null,
    selectedSource: '',
    savedSource: '',
    selectedFqcn: null,
    dirty: false,
    saveError: null,
    testRun: null,
    busy: false,
    ...overrides,
  }
}

function createHarness(overrides: Partial<DocumentControllerState> = {}): {
  controller: DocumentController
  state: DocumentControllerState
  backend: {
    readProblemFile: ReturnType<typeof vi.fn<DocumentControllerBackend['readProblemFile']>>
    saveProblemFile: ReturnType<typeof vi.fn<DocumentControllerBackend['saveProblemFile']>>
  }
  editor: {
    value: string
    setValue: ReturnType<typeof vi.fn<DocumentControllerEditor['setValue']>>
    reloadExternalValue: ReturnType<typeof vi.fn<DocumentControllerEditor['reloadExternalValue']>>
    focus: ReturnType<typeof vi.fn<DocumentControllerEditor['focus']>>
    setIssues: ReturnType<typeof vi.fn<DocumentControllerEditor['setIssues']>>
  }
  hooks: {
    resetTestState: ReturnType<typeof vi.fn>
    cancelCurrentRun: ReturnType<typeof vi.fn>
    renderAll: ReturnType<typeof vi.fn>
    renderFileHeading: ReturnType<typeof vi.fn>
    renderFileTabs: ReturnType<typeof vi.fn>
    updateFileTabState: ReturnType<typeof vi.fn>
    updateFileExplorerState: ReturnType<typeof vi.fn>
    updateEditorVisibility: ReturnType<typeof vi.fn>
    renderResult: ReturnType<typeof vi.fn>
    setExpandedGroup: ReturnType<typeof vi.fn>
    scheduleLiveDiagnostics: ReturnType<typeof vi.fn>
    markGitStale: ReturnType<typeof vi.fn>
    setSavedSource: ReturnType<typeof vi.fn>
    setMessage: ReturnType<typeof vi.fn>
    renderBusyControls: ReturnType<typeof vi.fn>
  }
  setGeneration: (generation: number) => void
} {
  const state = createState(overrides)
  const backend = {
    readProblemFile: vi.fn<DocumentControllerBackend['readProblemFile']>(),
    saveProblemFile: vi.fn<DocumentControllerBackend['saveProblemFile']>(),
  }
  backend.readProblemFile.mockImplementation(async (_repoPath, path) => (
    path === fileA.path ? 'class A {}' : 'class B {}'
  ))
  backend.saveProblemFile.mockResolvedValue(undefined)

  const editor = {
    value: '',
    setValue: vi.fn<DocumentControllerEditor['setValue']>((source) => {
      editor.value = source
    }),
    reloadExternalValue: vi.fn<DocumentControllerEditor['reloadExternalValue']>((source) => {
      editor.value = source
    }),
    focus: vi.fn<DocumentControllerEditor['focus']>(),
    setIssues: vi.fn<DocumentControllerEditor['setIssues']>(),
  }
  const hooks = {
    resetTestState: vi.fn(),
    cancelCurrentRun: vi.fn(),
    renderAll: vi.fn(),
    renderFileHeading: vi.fn(),
    renderFileTabs: vi.fn(),
    updateFileTabState: vi.fn(),
    updateFileExplorerState: vi.fn(),
    updateEditorVisibility: vi.fn(),
    renderResult: vi.fn(),
    setExpandedGroup: vi.fn(),
    scheduleLiveDiagnostics: vi.fn(),
    markGitStale: vi.fn(),
    setSavedSource: vi.fn(),
    setMessage: vi.fn(),
    renderBusyControls: vi.fn(),
  }
  let generation = 0
  const context: DocumentControllerContext = {
    state,
    backend,
    editor,
    getRepositoryGeneration: () => generation,
    resetTestState: hooks.resetTestState,
    cancelCurrentRun: hooks.cancelCurrentRun,
    renderAll: hooks.renderAll,
    renderFileHeading: hooks.renderFileHeading,
    renderFileTabs: hooks.renderFileTabs,
    updateFileTabState: hooks.updateFileTabState,
    updateFileExplorerState: hooks.updateFileExplorerState,
    updateEditorVisibility: hooks.updateEditorVisibility,
    renderResult: hooks.renderResult,
    setExpandedGroup: hooks.setExpandedGroup,
    scheduleLiveDiagnostics: hooks.scheduleLiveDiagnostics,
    markGitStale: hooks.markGitStale,
    setSavedSource: hooks.setSavedSource,
    setMessage: hooks.setMessage,
    renderBusyControls: hooks.renderBusyControls,
  }
  const controller = new DocumentController(context)
  return {
    controller,
    state,
    backend,
    editor,
    hooks,
    setGeneration: (value) => {
      generation = value
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DocumentController', () => {
  it('opens a file, creates its tab, and resets the editor through one lifecycle', async () => {
    const { controller, state, backend, editor, hooks } = createHarness()

    await controller.openFile(fileA)

    expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', fileA.path)
    expect(state.openTabs).toEqual([{
      id: 1,
      path: fileA.path,
      name: fileA.name,
      packageSegment: fileA.packageSegment,
    }])
    expect(state.activeTabId).toBe(1)
    expect(state.selectedPath).toBe(fileA.path)
    expect(state.selectedFqcn).toBe('easy.Q1TwoSum')
    expect(state.selectedSource).toBe('class A {}')
    expect(state.savedSource).toBe('class A {}')
    expect(state.dirty).toBe(false)
    expect(editor.value).toBe('class A {}')
    expect(hooks.resetTestState).toHaveBeenCalledOnce()
    expect(hooks.setSavedSource).toHaveBeenCalledWith('class A {}')
    expect(state.busy).toBe(false)
    controller.dispose()
  })

  it('keeps navigation responsive and applies only the newest file read', async () => {
    const { controller, state, backend, editor, hooks } = createHarness()
    const reads = new Map<string, ReturnType<typeof deferred<string>>>()
    backend.readProblemFile.mockImplementation((_repoPath, path) => {
      const pending = deferred<string>()
      reads.set(path, pending)
      return pending.promise
    })

    const openingA = controller.openFile(fileA)
    await Promise.resolve()
    await Promise.resolve()
    const openingB = controller.openFile(fileB)
    await Promise.resolve()
    await Promise.resolve()

    expect(state.busy).toBe(false)
    expect(hooks.renderBusyControls).not.toHaveBeenCalled()
    expect(reads.has(fileA.path)).toBe(true)
    expect(reads.has(fileB.path)).toBe(true)

    reads.get(fileB.path)?.resolve('class B {}')
    await openingB
    reads.get(fileA.path)?.resolve('class A {}')
    await openingA

    expect(state.selectedPath).toBe(fileB.path)
    expect(hooks.renderBusyControls).toHaveBeenCalledOnce()
    expect(state.openTabs).toEqual([{
      id: 1,
      path: fileB.path,
      name: fileB.name,
      packageSegment: fileB.packageSegment,
    }])
    expect(editor.value).toBe('class B {}')
    controller.dispose()
  })

  it('cancels a pending navigation when the user returns to the active file', async () => {
    const { controller, state, backend, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'
    const pendingRead = deferred<string>()
    backend.readProblemFile.mockReturnValue(pendingRead.promise)

    const opening = controller.openFile(fileB)
    await Promise.resolve()
    await Promise.resolve()
    await controller.openFile(fileA)
    pendingRead.resolve('class B {}')
    await opening

    expect(state.selectedPath).toBe(fileA.path)
    expect(state.activeTabId).toBe(1)
    expect(state.openTabs).toEqual([{ id: 1, ...fileA }])
    expect(editor.value).toBe('class A {}')
    controller.dispose()
  })

  it('ignores a read invalidated by an exclusive operation', async () => {
    const { controller, state, backend, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'
    const pendingRead = deferred<string>()
    backend.readProblemFile.mockReturnValue(pendingRead.promise)

    const opening = controller.openFile(fileB)
    await Promise.resolve()
    await Promise.resolve()
    controller.invalidatePendingNavigation()
    pendingRead.resolve('class B {}')
    await opening

    expect(state.selectedPath).toBe(fileA.path)
    expect(state.activeTabId).toBe(1)
    expect(editor.value).toBe('class A {}')
    controller.dispose()
  })

  it('flushes edits made while reading before replacing the editor', async () => {
    const { controller, state, backend, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'
    const pendingRead = deferred<string>()
    backend.readProblemFile.mockReturnValue(pendingRead.promise)

    const opening = controller.openFile(fileB)
    await Promise.resolve()
    await Promise.resolve()
    controller.onEditorChange('class A { int changed = 1; }')
    pendingRead.resolve('class B {}')
    await opening

    expect(backend.saveProblemFile).toHaveBeenCalledWith(
      '/repo',
      fileA.path,
      'class A { int changed = 1; }',
    )
    expect(state.selectedPath).toBe(fileB.path)
    expect(editor.value).toBe('class B {}')
    controller.dispose()
  })

  it('keeps the current file and reports a read failure without a busy flash', async () => {
    const { controller, state, backend, hooks, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'
    backend.readProblemFile.mockRejectedValue(new Error('disk read failed'))

    await controller.openFile(fileB)

    expect(state.selectedPath).toBe(fileA.path)
    expect(editor.value).toBe('class A {}')
    expect(state.busy).toBe(false)
    expect(hooks.renderBusyControls).not.toHaveBeenCalled()
    expect(hooks.setMessage).toHaveBeenCalledWith(
      'Could not open Q20ValidParentheses.java: disk read failed',
      'error',
    )
    controller.dispose()
  })

  it('does not reopen a tab that was closed while its source was pending', async () => {
    const { controller, state, backend, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }, { id: 2, ...fileB }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'
    const pendingRead = deferred<string>()
    backend.readProblemFile.mockReturnValue(pendingRead.promise)

    const opening = controller.openFile(fileB)
    await Promise.resolve()
    await Promise.resolve()
    controller.removeOpenTab(2)
    pendingRead.resolve('class B {}')
    await opening

    expect(state.selectedPath).toBe(fileA.path)
    expect(state.activeTabId).toBe(1)
    expect(state.openTabs).toEqual([{ id: 1, ...fileA }])
    controller.dispose()
  })

  it('flushes edits before navigation and keeps the current file after a failed save', async () => {
    const { controller, state, backend, hooks } = createHarness({
      selectedPath: fileA.path,
      selectedSource: 'class A { int value = 1; }',
      savedSource: 'class A {}',
      dirty: true,
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
    })
    backend.saveProblemFile.mockRejectedValue(new Error('disk full'))

    controller.onEditorChange(state.selectedSource)
    await controller.openFile(fileB)

    expect(backend.saveProblemFile).toHaveBeenCalledWith('/repo', fileA.path, state.selectedSource)
    expect(backend.readProblemFile).not.toHaveBeenCalled()
    expect(state.selectedPath).toBe(fileA.path)
    expect(state.activeTabId).toBe(1)
    expect(state.saveError).toBe('disk full')
    expect(hooks.setMessage).toHaveBeenCalledWith('Could not save the file: disk full', 'error')
    expect(state.busy).toBe(false)
    controller.dispose()
  })

  it('rejects a stale open response after the repository generation changes', async () => {
    let releaseRead: ((source: string) => void) | undefined
    const { controller, state, backend, setGeneration } = createHarness()
    backend.readProblemFile.mockImplementation(() => new Promise<string>((resolve) => {
      releaseRead = resolve
    }))

    const opening = controller.openFile(fileA)
    await Promise.resolve()
    setGeneration(1)
    state.repoPath = '/other-repo'
    releaseRead?.('stale source')
    await opening

    expect(state.openTabs).toEqual([])
    expect(state.selectedPath).toBeNull()
    expect(state.busy).toBe(false)
    controller.dispose()
  })

  it('closes the active tab and opens the nearest replacement after flushing', async () => {
    const { controller, state, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }, { id: 2, ...fileB }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = 'class A {}'

    await controller.closeOpenTab(1)

    expect(state.openTabs).toEqual([{ id: 2, ...fileB }])
    expect(state.activeTabId).toBe(2)
    expect(state.selectedPath).toBe(fileB.path)
    expect(editor.value).toBe('class B {}')
    expect(state.busy).toBe(false)
    controller.dispose()
  })

  it('keeps local edits when an external reload arrives with a clean snapshot race', async () => {
    const { controller, state, backend, hooks, editor } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A { int local = 1; }',
      savedSource: 'class A {}',
      dirty: true,
    })
    editor.value = state.selectedSource
    backend.readProblemFile.mockResolvedValue('class A { int external = 2; }')

    await controller.reloadOpenFileFromDisk(fileA.path)

    expect(editor.value).toBe(state.selectedSource)
    expect(state.selectedSource).toBe('class A { int local = 1; }')
    expect(state.savedSource).toBe('class A {}')
    expect(hooks.setMessage).toHaveBeenCalledWith(
      'Q1TwoSum.java changed on disk. Your unsaved edits were kept.',
      'info',
    )
    expect(hooks.markGitStale).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('adopts a clean external edit while preserving the editor cursor operation', async () => {
    const { controller, state, backend, editor, hooks } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    editor.value = state.selectedSource
    backend.readProblemFile.mockResolvedValue('class A { int external = 2; }')

    await controller.reloadOpenFileFromDisk(fileA.path)

    expect(state.selectedSource).toBe('class A { int external = 2; }')
    expect(state.savedSource).toBe(state.selectedSource)
    expect(state.dirty).toBe(false)
    expect(editor.reloadExternalValue).toHaveBeenCalledWith('class A { int external = 2; }')
    expect(hooks.setSavedSource).toHaveBeenCalledWith('class A { int external = 2; }')
    expect(hooks.markGitStale).toHaveBeenCalledOnce()
    expect(hooks.scheduleLiveDiagnostics).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('retains a native test lock on edit and suppresses autosave during Git discard', async () => {
    const { controller, state, backend, hooks } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
      testRun: {
        id: 1,
        status: 'running',
        phase: 'running',
        startedAt: 0,
        tests: [],
        stdout: '',
        stderr: '',
        activeTest: null,
        error: null,
        testMethod: null,
      },
      busy: true,
    })

    controller.beginGitDiscard()
    controller.onEditorChange('class A { int changed = 1; }')
    await controller.flushPendingSave()

    expect(hooks.cancelCurrentRun).toHaveBeenCalledOnce()
    expect(state.busy).toBe(true)
    expect(backend.saveProblemFile).not.toHaveBeenCalled()

    controller.endGitDiscard()
    controller.onEditorChange('class A { int changed = 2; }')
    await controller.flushPendingSave()
    expect(backend.saveProblemFile).toHaveBeenCalledWith(
      '/repo',
      fileA.path,
      'class A { int changed = 2; }',
    )
    controller.dispose()
  })

  it('shows a saved flash after a successful write and clears it on disposal', async () => {
    vi.useFakeTimers()
    const { controller, state, hooks } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })

    controller.onEditorChange('class A { int changed = 1; }')
    await controller.flushPendingSave()

    expect(state.savedSource).toBe('class A { int changed = 1; }')
    expect(state.dirty).toBe(false)
    expect(controller.savedFlash).toBe(true)
    expect(controller.saveWriteInFlight).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(controller.savedFlash).toBe(false)
    expect(hooks.renderFileHeading).toHaveBeenCalled()

    controller.dispose()
    expect(controller.hasPendingChanges).toBe(false)
  })

  it('ignores a save that settles after disposal', async () => {
    let resolveSave: (() => void) | undefined
    const { controller, state, backend, hooks } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    backend.saveProblemFile.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))

    controller.onEditorChange('class A { int changed = 1; }')
    const flushing = controller.flushPendingSave()
    await Promise.resolve()
    controller.dispose()
    resolveSave?.()
    await flushing

    expect(state.savedSource).toBe('class A {}')
    expect(state.dirty).toBe(true)
    expect(state.saveError).toBeNull()
    expect(hooks.markGitStale).not.toHaveBeenCalled()
  })

  it('does not apply a save result after the repository generation changes', async () => {
    let resolveSave: (() => void) | undefined
    const { controller, state, backend, hooks, setGeneration } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    backend.saveProblemFile.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))

    controller.onEditorChange('class A { int changed = 3; }')
    const flushing = controller.flushPendingSave()
    await Promise.resolve()
    setGeneration(1)
    // Simulate leaving and returning to the same repository path while the
    // native write from the previous generation is still settling.
    resolveSave?.()
    await flushing

    expect(state.savedSource).toBe('class A {}')
    expect(state.dirty).toBe(true)
    expect(hooks.markGitStale).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores a rejected save that settles after disposal', async () => {
    let rejectSave: ((error: unknown) => void) | undefined
    const { controller, state, backend, hooks } = createHarness({
      openTabs: [{ id: 1, ...fileA }],
      activeTabId: 1,
      selectedPath: fileA.path,
      selectedSource: 'class A {}',
      savedSource: 'class A {}',
    })
    backend.saveProblemFile.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectSave = reject
    }))

    controller.onEditorChange('class A { int changed = 2; }')
    const flushing = controller.flushPendingSave()
    await Promise.resolve()
    controller.dispose()
    rejectSave?.(new Error('late disk failure'))
    await expect(flushing).resolves.toBe(false)

    expect(state.saveError).toBeNull()
    expect(hooks.setMessage).not.toHaveBeenCalledWith(
      'Could not save the file: late disk failure',
      'error',
    )
  })
})

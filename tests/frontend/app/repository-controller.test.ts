import { describe, expect, it, vi } from 'vitest'
import { RepositoryController } from '../../../src/app/repository-controller'
import type { AppState } from '../../../src/app/types'
import type { BackendClient } from '../../../src/backend'

function fixture(repoPath: string | null = '/repo') {
  const tab = { id: 'tab', path: 'easy/Q1.java', name: 'Q1.java', source: 'unsaved source' }
  const state = {
    repoPath, projectValid: repoPath !== null, busy: false,
    files: [], openTabs: repoPath ? [tab] : [], selectedPath: null,
  } as unknown as AppState
  const backend = {
    validateProject: vi.fn().mockResolvedValue({ valid: true }),
    listProblemFiles: vi.fn().mockResolvedValue([{ path: tab.path, name: tab.name, packageSegment: 'easy' }]),
    watchRepository: vi.fn().mockResolvedValue(undefined),
    stopWatchingRepository: vi.fn().mockResolvedValue(undefined),
  }
  const document = {
    flushPendingSave: vi.fn().mockResolvedValue(true),
    activeOpenTab: vi.fn(() => state.openTabs[0] ?? null),
    resetCurrentFile: vi.fn(),
    reloadOpenFileFromDisk: vi.fn().mockResolvedValue(undefined),
  }
  const psLibrary = { setRepository: vi.fn(), invalidate: vi.fn() }
  const javaTypes = { setRepository: vi.fn(), invalidate: vi.fn() }
  const storage = {
    getItem: vi.fn(() => '/repo'), setItem: vi.fn(), removeItem: vi.fn(),
  }
  const setMessage = vi.fn()
  const picker = vi.fn().mockResolvedValue('/repo')
  const controller = new RepositoryController({
    state,
    backend: backend as unknown as BackendClient,
    directoryPicker: picker,
    storage: storage as unknown as Storage,
    document,
    git: { reset: vi.fn(), markStale: vi.fn() },
    dialogs: { closeFileContextMenu: vi.fn(), resetGitDiscardDialog: vi.fn() },
    search: { reset: vi.fn() },
    psLibrary, javaTypes,
    isActive: () => true, render: vi.fn(), setMessage,
  })
  return { controller, state, backend, document, psLibrary, javaTypes, storage, setMessage, tab, picker }
}

describe('repository access retries', () => {
  it('reselects the same folder, preserves unsaved documents and refreshes both metadata caches', async () => {
    const { controller, state, backend, document, psLibrary, javaTypes, tab } = fixture()
    await expect(controller.chooseRepository()).resolves.toBe(true)
    expect(backend.validateProject).toHaveBeenCalledWith('/repo')
    expect(backend.listProblemFiles).toHaveBeenCalledWith('/repo')
    expect(state.openTabs[0]).toBe(tab)
    expect(tab.source).toBe('unsaved source')
    expect(document.flushPendingSave).not.toHaveBeenCalled()
    expect(document.resetCurrentFile).not.toHaveBeenCalled()
    expect(psLibrary.invalidate).toHaveBeenCalledOnce()
    expect(javaTypes.invalidate).toHaveBeenCalledOnce()
    expect(state.busy).toBe(false)
  })

  it('retains the attempted startup folder after denied validation for a settings retry', async () => {
    const { controller, backend, state, setMessage, storage } = fixture(null)
    backend.validateProject.mockResolvedValueOnce({ valid: false, message: 'Unable to resolve projectRoot: Operation not permitted' })
    await expect(controller.selectRepository('/repo', false)).resolves.toBe(false)
    expect(controller.recoveryPath).toBe('/repo')
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(state.projectValid).toBe(false)
    expect(setMessage).toHaveBeenCalledWith('Unable to resolve projectRoot: Operation not permitted', 'error')
    await expect(controller.selectRepository(controller.recoveryPath!, true)).resolves.toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith('leetcoder.repository-path', '/repo')
  })

  it('does not report success or refresh metadata when listing still fails', async () => {
    const { controller, backend, psLibrary, javaTypes, state, setMessage } = fixture()
    backend.listProblemFiles.mockRejectedValueOnce(new Error("Unable to list '/repo': Permission denied"))
    await expect(controller.chooseRepository()).resolves.toBe(false)
    expect(psLibrary.invalidate).not.toHaveBeenCalled()
    expect(javaTypes.invalidate).not.toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith("Could not list problem files: Unable to list '/repo': Permission denied", 'error')
    expect(state.busy).toBe(false)
  })

  it('leaves the existing folder and metadata untouched when the picker is cancelled', async () => {
    const { controller, picker, state, backend, psLibrary } = fixture()
    picker.mockResolvedValueOnce(null)
    await expect(controller.chooseRepository()).resolves.toBe(false)
    expect(state.repoPath).toBe('/repo')
    expect(backend.validateProject).not.toHaveBeenCalled()
    expect(psLibrary.invalidate).not.toHaveBeenCalled()
  })
})

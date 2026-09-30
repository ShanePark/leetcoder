import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { file, deferred, installDom, type DomHarness } from './lifecycle-harness'
import { FileDialogController, type FileDialogState } from '../../../src/app/file-dialog-controller'
import { createGitState } from '../../../src/app/git-controller'

function harness(dom: DomHarness) {
  const state: FileDialogState = {
    repoPath: '/repo',
    projectValid: true,
    busy: false,
    files: [file],
    contextMenu: null,
    gitContextMenu: null,
    git: createGitState(),
  }
  const operations = {
    showGitFileInManager: vi.fn().mockResolvedValue(undefined),
    discardGitChanges: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    duplicateFile: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  }
  const setMessage = vi.fn()
  const controller = new FileDialogController({
    root: dom.root as unknown as HTMLElement,
    state,
    operations,
    setMessage,
  })
  controller.bindEvents()
  return { controller, state, operations, setMessage }
}

describe('file dialog orchestration', () => {
  let dom: DomHarness
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    dom = installDom()
    h = harness(dom)
  })

  afterEach(() => {
    h.controller.dispose()
    dom.restore()
  })

  it('opens mutually exclusive menus, focuses their first action, and closes on Escape', () => {
    h.controller.openFileContextMenu(file, 10, 20)
    expect(h.state.contextMenu).toEqual({ file, x: 10, y: 20 })
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#duplicate-file-action'))

    const gitFile = { path: file.path, status: 'M', staged: false, additions: null, deletions: null }
    h.controller.openGitContextMenu(gitFile, 30, 40)
    expect(h.state.contextMenu).toBeNull()
    expect(h.state.gitContextMenu).toEqual({ file: gitFile, x: 30, y: 40 })
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#git-discard-action'))

    const event = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent
    h.controller.handleEscape(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(h.state.gitContextMenu).toBeNull()
  })

  it('requires delete confirmation and restores search focus when cancelled', async () => {
    h.controller.openFileContextMenu(file, 0, 0)
    dom.root.querySelector('#delete-file-action').dispatch('click')
    await Promise.resolve()
    expect(h.operations.deleteFile).not.toHaveBeenCalled()
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#cancel-delete-file'))
    dom.root.querySelector('#cancel-delete-file').dispatch('click')
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#file-search'))

    h.controller.openFileContextMenu(file, 0, 0)
    dom.root.querySelector('#delete-file-action').dispatch('click')
    const preventDefault = vi.fn()
    dom.root.querySelector('#delete-file-form').dispatch('submit', { preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(h.operations.deleteFile).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('rejects invalid and existing rename targets before passing a normalized name to operations', async () => {
    h.controller.openFileContextMenu(file, 0, 0)
    dom.root.querySelector('#rename-file-action').dispatch('click')
    const input = dom.root.querySelector('#rename-file-input')
    const form = dom.root.querySelector('#rename-file-form')
    const submit = () => form.dispatch('submit', { preventDefault: vi.fn() })
    expect(input.value).toBe('Q1TwoSum')

    input.value = 'invalid/name'
    submit()
    expect(h.setMessage).toHaveBeenLastCalledWith('Enter a valid Java filename.', 'error')
    expect(h.operations.renameFile).not.toHaveBeenCalled()

    h.state.files.push({ ...file, path: 'src/main/java/easy/Q2.java', name: 'Q2.java' })
    input.value = 'Q2'
    submit()
    expect(h.setMessage).toHaveBeenLastCalledWith('A file named Q2.java already exists.', 'error')
    expect(h.operations.renameFile).not.toHaveBeenCalled()

    input.value = 'Q3'
    submit()
    await Promise.resolve()
    expect(h.operations.renameFile).toHaveBeenCalledExactlyOnceWith(file, 'Q3.java')
    expect(dom.root.querySelector('#rename-file-dialog').hidden).toBe(true)
  })

  it('restores Git focus after the confirmed discard operation settles', async () => {
    const pending = deferred<void>()
    h.operations.discardGitChanges.mockImplementation(() => pending.promise)
    const gitFile = { path: file.path, status: 'M', staged: false, additions: null, deletions: null }
    h.controller.openGitContextMenu(gitFile, 0, 0)
    dom.root.querySelector('#git-discard-action').dispatch('click')
    await Promise.resolve()
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#cancel-discard-git'))
    dom.root.querySelector('#discard-git-form').dispatch('submit', { preventDefault: vi.fn() })
    expect(h.operations.discardGitChanges).toHaveBeenCalledExactlyOnceWith(gitFile)
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#cancel-discard-git'))
    pending.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(dom.document.activeElement).toBe(dom.root.querySelector('#git-tab'))
  })

  it('blocks busy operations and removes its DOM listeners when disposed', () => {
    h.controller.openFileContextMenu(file, 0, 0)
    h.state.busy = true
    dom.root.querySelector('#duplicate-file-action').dispatch('click')
    dom.root.querySelector('#delete-file-action').dispatch('click')
    expect(h.operations.duplicateFile).not.toHaveBeenCalled()
    expect(h.operations.deleteFile).not.toHaveBeenCalled()
    expect(h.state.contextMenu).not.toBeNull()

    h.state.busy = false
    h.controller.dispose()
    dom.root.querySelector('#duplicate-file-action').dispatch('click')
    expect(h.operations.duplicateFile).not.toHaveBeenCalled()
    expect(dom.root.querySelector('#rename-file-form').totalListenerCount()).toBe(0)
  })
})

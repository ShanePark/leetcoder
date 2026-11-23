import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProblemFileEntry } from '../../../src/backend'
import type { FilesViewCallbacks } from '../../../src/app/files-view'
import type { AppState } from '../../../src/app/types'
import { FileExplorerController } from '../../../src/app/file-explorer-controller'

const view = vi.hoisted(() => ({ callbacks: null as FilesViewCallbacks | null }))

vi.mock('../../../src/app/files-view', () => ({
  FILE_GROUPS: [],
  OTHER_GROUP: { key: 'other' },
  getFilenameMatchedPaths: () => [],
  renderFilesView: (_elements: unknown, _model: unknown, callbacks: FilesViewCallbacks) => {
    view.callbacks = callbacks
    callbacks.onRendered?.()
  },
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const files: ProblemFileEntry[] = [1, 2, 3].map((number) => ({
    path: `src/main/java/easy/Q${number}Problem.java`,
    name: `Q${number}Problem.java`,
    packageSegment: 'easy',
  }))
  const state = {
    files,
    selectedPath: files[0].path,
    fileSearch: '',
    projectValid: true,
    contextMenu: null,
  } as unknown as AppState
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  })
  const rows = files.map((file) => ({
    dataset: { path: file.path },
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    closest: () => ({ hidden: false }),
    scrollIntoView: vi.fn(),
  }))
  const element = { classList: { toggle: vi.fn() } }
  const root = {
    querySelector: (selector: string) => selector.startsWith('#file-group-') ? null : element,
    querySelectorAll: () => rows,
  } as unknown as HTMLElement
  const document = {
    openTabForPath: vi.fn().mockReturnValue(null),
    openFile: vi.fn<(file: ProblemFileEntry) => Promise<void>>().mockResolvedValue(undefined),
  }
  const controller = new FileExplorerController({
    root,
    state,
    document,
    dialogs: { openFileContextMenu: vi.fn(), renderContextMenu: vi.fn() },
    search: { update: vi.fn() },
    repositoryGeneration: () => 0,
    isActive: () => true,
    revealLine: vi.fn(),
  })
  const flushFrames = () => {
    frames.splice(0).forEach((callback) => callback(0))
  }
  controller.renderFiles()
  flushFrames()
  rows.forEach((row) => row.scrollIntoView.mockClear())
  return { controller, document, state, files, rows, flushFrames }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('file explorer selection scrolling', () => {
  it('preserves the list position through a direct selection and editor focus', async () => {
    const h = harness()
    const opening = deferred()
    h.document.openFile.mockImplementation(async (file) => {
      await opening.promise
      h.state.selectedPath = file.path
      h.controller.updateFileExplorerState()
      h.controller.renderFiles()
      h.controller.revealSelectedFileInExplorer()
    })

    view.callbacks?.onFileSelect(h.files[1])
    opening.resolve()
    await opening.promise
    await Promise.resolve()
    h.flushFrames()

    expect(h.state.selectedPath).toBe(h.files[1].path)
    expect(h.rows.every((row) => row.scrollIntoView.mock.calls.length === 0)).toBe(true)

    h.controller.revealSelectedFileInExplorer()
    h.flushFrames()
    expect(h.rows[1].scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('preserves the list position when clicking the already-selected file', async () => {
    const h = harness()
    h.document.openFile.mockImplementation(async () => {
      h.controller.revealSelectedFileInExplorer()
    })

    view.callbacks?.onFileSelect(h.files[0])
    await Promise.resolve()
    h.flushFrames()
    expect(h.rows[0].scrollIntoView).not.toHaveBeenCalled()
  })

  it('keeps the latest direct selection suppressed when an older request finishes', async () => {
    const h = harness()
    const first = deferred()
    const second = deferred()
    h.document.openFile
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    view.callbacks?.onFileSelect(h.files[1])
    view.callbacks?.onFileSelect(h.files[2])
    first.resolve()
    await first.promise
    h.state.selectedPath = h.files[2].path
    h.controller.updateFileExplorerState()
    h.flushFrames()
    expect(h.rows[2].scrollIntoView).not.toHaveBeenCalled()
    second.resolve()
    await second.promise
  })

  it('centers external navigation and ignores a queued reveal for an older selection', () => {
    const h = harness()
    h.controller.scrollActiveFileIntoView()
    h.state.selectedPath = h.files[1].path
    h.flushFrames()
    expect(h.rows[0].scrollIntoView).not.toHaveBeenCalled()

    h.controller.updateFileExplorerState()
    h.flushFrames()
    expect(h.rows[1].scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })
})

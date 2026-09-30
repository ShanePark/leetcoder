import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testMocks } from './lifecycle-mocks'
import {
  createBackend, installDom, startApp, file, FakeElement,
  setFileSearchQuery, setNavigatorPlatform, type DomHarness,
} from './lifecycle-harness'
import type { ProjectSearchMatch } from '../../../src/backend'

describe('LeetcoderApp project search', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDom()
  })

  afterEach(() => {
    dom.restore()
  })

  it('focuses the file search field from the platform file-search shortcut', async () => {
    const restoreNavigator = setNavigatorPlatform('Linux x86_64')
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    try {
      const search = dom.root.querySelector<FakeElement>('#file-search')
      const event = {
        key: 'o',
        code: 'KeyO',
        shiftKey: true,
        altKey: true,
        metaKey: false,
        ctrlKey: false,
        target: null,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent

      dom.window.dispatch('keydown', event)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(dom.document.activeElement).toBe(search)
    } finally {
      await app.destroy()
      restoreNavigator()
    }
  })

  it('focuses the shared file-search field from the editor and global project-search shortcut', async () => {
    const restoreNavigator = setNavigatorPlatform('Linux x86_64')
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    try {
      const search = dom.root.querySelector<FakeElement>('#file-search')
      const controller = testMocks.contentSearchControllers.at(-1)!
      testMocks.editorInstances.at(-1)?.triggerProjectSearch()
      expect(dom.document.activeElement).toBe(search)

      const event = {
        key: 'ƒ',
        code: 'KeyF',
        shiftKey: true,
        altKey: true,
        metaKey: false,
        ctrlKey: false,
        target: null,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent
      dom.window.dispatch('keydown', event)

      expect(dom.document.activeElement).toBe(search)
      expect(event.preventDefault).toHaveBeenCalledOnce()

      controller.update.mockClear()
      search.value = 'Q1'
      search.dispatch('input', { target: search })
      expect(controller.update).toHaveBeenLastCalledWith('Q1', [file.path])
      expect(dom.root.querySelector<FakeElement>('#file-results-viewport').classList.contains('is-searching')).toBe(true)
    } finally {
      await app.destroy()
      restoreNavigator()
    }
  })

  it('re-finds an editable hit in the current source before revealing it', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockResolvedValue('return true;')
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 1,
      column: 1,
      preview: 'return true;',
    }
    try {
      expect(controller.options.canNavigate(match)).toBe(true)
      expect(controller.options.canNavigate({ ...match, path: 'README.md' })).toBe(false)
      setFileSearchQuery(dom, 'return true')
      testMocks.fileViewCallbacks.at(-1)?.onFileSelect(file)
      await vi.waitFor(() => {
        expect((app as unknown as { state: { selectedPath: string | null } }).state.selectedPath).toBe(file.path)
      })
      testMocks.editorInstances.at(-1)?.emitChange('new prefix\nreturn true;')
      await controller.options.onNavigate(match, 'return true')

      expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', file.path)
      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([{ line: 2, column: 1 }])
    } finally {
      await app.destroy()
    }
  })

  it('does not reveal an editable hit after its text was removed from the current source', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockResolvedValue('return true;')
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 1,
      column: 1,
      preview: 'return true;',
    }
    try {
      setFileSearchQuery(dom, 'return true')
      testMocks.fileViewCallbacks.at(-1)?.onFileSelect(file)
      await vi.waitFor(() => {
        expect((app as unknown as { state: { selectedPath: string | null } }).state.selectedPath).toBe(file.path)
      })
      testMocks.editorInstances.at(-1)?.emitChange('the result has been removed')
      await expect(controller.options.onNavigate(match, 'return true'))
        .rejects.toThrow('Matching text changed; search again.')

      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([])
    } finally {
      await app.destroy()
    }
  })

  it('avoids revealing a failed content-hit navigation', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockRejectedValue(new Error('missing'))
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 3,
      column: 7,
      preview: 'return true;',
    }
    try {
      setFileSearchQuery(dom, 'return true')
      await expect(controller.options.onNavigate(match, 'return true')).rejects.toThrow('Could not open')

      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([])
    } finally {
      await app.destroy()
    }
  })
})

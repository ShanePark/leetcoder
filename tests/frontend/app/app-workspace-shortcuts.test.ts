import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testMocks } from './lifecycle-mocks'
import {
  createBackend, dailyProblem, file, installDom, startApp, FakeElement, LeetcoderApp, rememberedStorage,
  setNavigatorPlatform, type DomHarness,
} from './lifecycle-harness'
import type { ProblemFileEntry } from '../../../src/backend'
import { createDailyProblemView } from '../../../src/app/daily-view'

interface AppInternals {
  state: {
    bottomPanelTab: 'tests' | 'git'
    selectedPath: string | null
    dailyProblem: typeof dailyProblem | null
    git: { commitMessage: string }
  }
  documentController: {
    openFile: (file: ProblemFileEntry) => Promise<void>
  }
  fileOperationsController: {
    createFileForToday: () => Promise<void>
  }
  gitController: {
    commitSelectedFiles: (push: boolean) => Promise<void>
    selectAllForShortcutCommit: () => boolean
  }
  gitCommitDialog: {
    confirm: (request: { branch: string; paths: string[]; message: string; pushAfterCommit: boolean }) => Promise<boolean>
  }
}

function internals(app: LeetcoderApp): AppInternals {
  return app as unknown as AppInternals
}

function keydown(keys: Partial<KeyboardEvent>): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key: '',
    code: '',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...keys,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

const altDigit = (digit: number) => keydown({ key: String(digit), code: `Digit${digit}`, altKey: true })
const altK = () => keydown({ key: 'k', code: 'KeyK', altKey: true })
const ctrlAltK = () => keydown({ key: 'k', code: 'KeyK', altKey: true, ctrlKey: true })

describe('LeetcoderApp workspace shortcuts', () => {
  let dom: DomHarness
  let restoreNavigator: () => void

  beforeEach(() => {
    dom = installDom()
    restoreNavigator = setNavigatorPlatform('Linux x86_64')
  })

  afterEach(() => {
    restoreNavigator()
    dom.restore()
  })

  function element(selector: string): FakeElement {
    return dom.root.querySelector<FakeElement>(selector)
  }

  function typeCommitMessage(message: string): void {
    const input = element('#git-commit-message')
    input.value = message
    input.dispatch('input', { target: input })
  }

  it('switches the bottom panel from the window and from the editor', async () => {
    const app = await startApp(dom, createBackend().backend)
    try {
      const showGit = altDigit(9)
      dom.window.dispatch('keydown', showGit)
      expect(showGit.preventDefault).toHaveBeenCalledOnce()
      expect(internals(app).state.bottomPanelTab).toBe('git')

      dom.window.dispatch('keydown', altDigit(4))
      expect(internals(app).state.bottomPanelTab).toBe('tests')

      testMocks.editorInstances.at(-1)?.triggerWorkspaceShortcut('show-git-panel')
      expect(internals(app).state.bottomPanelTab).toBe('git')
    } finally {
      await app.destroy()
    }
  })

  it('routes the message-field shortcut and Commit button through the same guarded action', async () => {
    const app = await startApp(dom, createBackend().backend)
    const commit = vi.spyOn(internals(app).gitController, 'commitSelectedFiles')
    try {
      const input = element('#git-commit-message')
      element('#editor').focus()
      // Away from the message field the shortcut only brings it forward.
      dom.window.dispatch('keydown', altK())
      expect(internals(app).state.bottomPanelTab).toBe('git')
      expect(dom.document.activeElement).toBe(input)
      expect(commit).not.toHaveBeenCalled()

      // Nothing typed: an enabled button means the default message applies.
      expect(internals(app).state.git.commitMessage).toBe('')
      dom.window.dispatch('keydown', altK())
      expect(commit).toHaveBeenCalledExactlyOnceWith(false)

      commit.mockClear()
      element('#git-commit').click()
      expect(commit).toHaveBeenCalledExactlyOnceWith(false)

      // A disabled button keeps its guard when reached from the keyboard.
      commit.mockClear()
      typeCommitMessage('Solve two sum')
      element('#git-commit').disabled = true
      dom.window.dispatch('keydown', altK())
      expect(commit).not.toHaveBeenCalled()
      expect(dom.document.activeElement).toBe(input)
    } finally {
      await app.destroy()
    }
  })

  it('commits and pushes from anywhere whenever Commit & Push is enabled, typed message or not', async () => {
    const app = await startApp(dom, createBackend().backend)
    const commit = vi.spyOn(internals(app).gitController, 'commitSelectedFiles')
    try {
      // Selected files with only the default message: the view enables the button.
      expect(internals(app).state.git.commitMessage).toBe('')
      element('#git-commit-push').disabled = false
      element('#editor').focus()
      dom.window.dispatch('keydown', ctrlAltK())
      expect(commit).toHaveBeenCalledExactlyOnceWith(true)

      // No selected files: the view disables it, so the shortcut only focuses.
      commit.mockClear()
      element('#git-commit-push').disabled = true
      internals(app).state.bottomPanelTab = 'tests'
      element('#editor').focus()
      dom.window.dispatch('keydown', ctrlAltK())
      expect(commit).not.toHaveBeenCalled()
      expect(internals(app).state.bottomPanelTab).toBe('git')
      expect(dom.document.activeElement).toBe(element('#git-commit-message'))

      element('#git-commit-push').disabled = false
      testMocks.editorInstances.at(-1)?.triggerWorkspaceShortcut('git-commit-push')
      expect(commit).toHaveBeenCalledExactlyOnceWith(true)
    } finally {
      await app.destroy()
    }
  })

  it('checks unambiguous changes first when a commit shortcut finds nothing checked', async () => {
    const app = await startApp(dom, createBackend().backend)
    const commit = vi.spyOn(internals(app).gitController, 'commitSelectedFiles')
    const selectAll = vi.spyOn(internals(app).gitController, 'selectAllForShortcutCommit')
    try {
      // Selecting repaints the panel, which enables the buttons.
      selectAll.mockImplementation(() => {
        element('#git-commit-push').disabled = false
        element('#git-commit').disabled = false
        return true
      })
      element('#git-commit-push').disabled = true
      element('#editor').focus()
      dom.window.dispatch('keydown', ctrlAltK())
      expect(selectAll).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledExactlyOnceWith(true)

      commit.mockClear()
      selectAll.mockClear()
      element('#git-commit').disabled = true
      element('#git-commit-message').focus()
      dom.window.dispatch('keydown', altK())
      expect(selectAll).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledExactlyOnceWith(false)

      // Ambiguous changes stay unchecked and the shortcut only focuses.
      commit.mockClear()
      selectAll.mockReset().mockReturnValue(false)
      element('#git-commit-push').disabled = true
      element('#editor').focus()
      dom.window.dispatch('keydown', ctrlAltK())
      expect(selectAll).toHaveBeenCalledOnce()
      expect(commit).not.toHaveBeenCalled()
      expect(dom.document.activeElement).toBe(element('#git-commit-message'))

      // Away from the message field the plain commit shortcut never selects.
      selectAll.mockClear()
      element('#editor').focus()
      dom.window.dispatch('keydown', altK())
      expect(selectAll).not.toHaveBeenCalled()
    } finally {
      await app.destroy()
    }
  })

  it('ignores repeated commit shortcuts while the confirmation is open and keeps the confirm action focused', async () => {
    const app = await startApp(dom, createBackend().backend)
    const commit = vi.spyOn(internals(app).gitController, 'commitSelectedFiles')
    const dialog = element('#commit-git-dialog') as FakeElement & {
      open: boolean
      showModal: () => void
      close: () => void
    }
    dialog.open = false
    dialog.showModal = () => { dialog.open = true }
    dialog.close = () => { dialog.open = false }
    try {
      element('#editor').focus()
      element('#git-commit-push').disabled = false
      const confirmation = internals(app).gitCommitDialog.confirm({
        branch: 'main', paths: ['Q1.java'], message: 'Save Q1', pushAfterCommit: true,
      })

      expect(dom.document.activeElement).toBe(element('#confirm-commit-git'))
      dom.window.dispatch('keydown', { ...ctrlAltK(), repeat: true })
      testMocks.editorInstances.at(-1)?.triggerWorkspaceShortcut('git-commit-push')
      dom.window.dispatch('keydown', keydown({ key: 'Enter', code: 'Enter' }))

      expect(commit).not.toHaveBeenCalled()
      expect(dialog.open).toBe(true)
      expect(dom.document.activeElement).toBe(element('#confirm-commit-git'))
      element('#cancel-commit-git').click()
      await expect(confirmation).resolves.toBe(false)
      expect(dom.document.activeElement).toBe(element('#editor'))
    } finally {
      await app.destroy()
    }
  })

  it('toggles the sidebar from its header button and moves focus off a collapsing sidebar', async () => {
    const app = await startApp(dom, createBackend().backend)
    try {
      const layout = testMocks.paneLayouts.at(-1)!
      const toggle = element('#sidebar-toggle')
      internals(app).state.selectedPath = null
      element('.sidebar').focus()
      expect(toggle.attributes.get('aria-pressed')).toBe('true')

      dom.window.dispatch('keydown', altDigit(1))
      expect(layout.setSidebarCollapsed).toHaveBeenLastCalledWith(true)
      expect(dom.document.activeElement).toBe(toggle)
      expect(toggle.attributes.get('aria-pressed')).toBe('false')

      toggle.dispatch('click')
      expect(layout.setSidebarCollapsed).toHaveBeenLastCalledWith(false)
      expect(layout.sidebarCollapsed).toBe(false)
      expect(toggle.attributes.get('aria-pressed')).toBe('true')

      toggle.dispatch('click')
      expect(layout.sidebarCollapsed).toBe(true)
      dom.window.dispatch('keydown', altDigit(1))
      expect(layout.sidebarCollapsed).toBe(false)
    } finally {
      await app.destroy()
    }
  })

  it('moves focus from the collapsing sidebar to an open editor', async () => {
    const app = await startApp(dom, createBackend().backend)
    try {
      const editor = testMocks.editorInstances.at(-1)!
      const focusEditor = vi.spyOn(editor, 'focus')
      internals(app).state.selectedPath = 'src/main/java/easy/Q1TwoSum.java'
      element('.sidebar').focus()
      editor.triggerWorkspaceShortcut('show-problems-tab')
      expect(testMocks.paneLayouts.at(-1)!.sidebarCollapsed).toBe(true)
      expect(focusEditor).toHaveBeenCalledOnce()
    } finally {
      await app.destroy()
    }
  })

  it('expands a collapsed sidebar before focusing the file search', async () => {
    const app = await startApp(dom, createBackend().backend)
    try {
      const layout = testMocks.paneLayouts.at(-1)!
      dom.window.dispatch('keydown', altDigit(1))
      expect(layout.sidebarCollapsed).toBe(true)

      dom.window.dispatch('keydown', keydown({ key: 'o', code: 'KeyO', shiftKey: true, altKey: true }))
      expect(layout.sidebarCollapsed).toBe(false)
      expect(dom.document.activeElement).toBe(element('#file-search'))

      dom.window.dispatch('keydown', altDigit(1))
      testMocks.editorInstances.at(-1)?.triggerProjectSearch()
      expect(layout.sidebarCollapsed).toBe(false)
      expect(dom.document.activeElement).toBe(element('#file-search'))
    } finally {
      await app.destroy()
    }
  })

  describe('sidebar tabs', () => {
    function dailyView(): {
      onOpenFile: (file: ProblemFileEntry) => void
      onCreateFile: () => void
    } {
      const factory = vi.mocked(createDailyProblemView)
      const [, callbacks] = factory.mock.calls.at(-1)!
      return {
        onOpenFile: (file) => callbacks.onOpenFile(file),
        onCreateFile: () => callbacks.onCreateFile(),
      }
    }

    function descriptionSelected(): boolean {
      const selected = element('#sidebar-description-tab').attributes.get('aria-selected') === 'true'
      expect(element('#sidebar-problems-tab').attributes.get('aria-selected')).toBe(String(!selected))
      expect(element('#sidebar-description-panel').hidden).toBe(!selected)
      expect(element('#sidebar-problems-panel').hidden).toBe(selected)
      return selected
    }

    it('shows each tab with Alt+1 and Alt+2 and hides the sidebar when that tab is already showing', async () => {
      const storage = rememberedStorage()
      const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
        backend: createBackend().backend,
        storage: storage as unknown as Storage,
      })
      await app.start()
      try {
        const layout = testMocks.paneLayouts.at(-1)!
        const toggle = element('#sidebar-toggle')
        expect(descriptionSelected()).toBe(false)

        const showDescription = altDigit(2)
        dom.window.dispatch('keydown', showDescription)
        expect(showDescription.preventDefault).toHaveBeenCalledOnce()
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(true)
        expect(storage.getItem('leetcoder.sidebar-tab')).toBe('description')
        // The header toggle stands for the Problems tab.
        expect(toggle.attributes.get('aria-pressed')).toBe('false')

        dom.window.dispatch('keydown', altDigit(2))
        expect(layout.sidebarCollapsed).toBe(true)
        expect(descriptionSelected()).toBe(true)

        dom.window.dispatch('keydown', altDigit(2))
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(true)

        // Another tab's shortcut switches instead of hiding.
        dom.window.dispatch('keydown', altDigit(1))
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(false)
        expect(toggle.attributes.get('aria-pressed')).toBe('true')

        dom.window.dispatch('keydown', altDigit(1))
        expect(layout.sidebarCollapsed).toBe(true)

        dom.window.dispatch('keydown', altDigit(2))
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(true)
      } finally {
        await app.destroy()
      }
    })

    it('runs the tab shortcuts from the editor and the header toggle like Alt+1', async () => {
      const app = await startApp(dom, createBackend().backend)
      try {
        const layout = testMocks.paneLayouts.at(-1)!
        const editor = testMocks.editorInstances.at(-1)!
        const toggle = element('#sidebar-toggle')

        editor.triggerWorkspaceShortcut('show-description-tab')
        expect(descriptionSelected()).toBe(true)
        editor.triggerWorkspaceShortcut('show-description-tab')
        expect(layout.sidebarCollapsed).toBe(true)

        // From a hidden sidebar or the Description tab, the toggle shows Problems.
        toggle.dispatch('click')
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(false)
        editor.triggerWorkspaceShortcut('show-description-tab')
        expect(descriptionSelected()).toBe(true)
        toggle.dispatch('click')
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(false)
        toggle.dispatch('click')
        expect(layout.sidebarCollapsed).toBe(true)
        editor.triggerWorkspaceShortcut('show-problems-tab')
        expect(layout.sidebarCollapsed).toBe(false)
        expect(descriptionSelected()).toBe(false)
      } finally {
        await app.destroy()
      }
    })

    it('keeps focus in the sidebar when a tab shortcut hides the focused panel', async () => {
      const app = await startApp(dom, createBackend().backend)
      try {
        element('#sidebar-problems-panel').focus()
        dom.window.dispatch('keydown', altDigit(2))
        expect(descriptionSelected()).toBe(true)
        expect(dom.document.activeElement).toBe(element('#sidebar-description-tab'))
      } finally {
        await app.destroy()
      }
    })

    it('shows the Description tab after the header opens today\'s file, but not after a file-list open', async () => {
      const app = await startApp(dom, createBackend().backend)
      try {
        const layout = testMocks.paneLayouts.at(-1)!
        internals(app).state.selectedPath = null
        dom.window.dispatch('keydown', altDigit(1))
        expect(layout.sidebarCollapsed).toBe(true)

        await internals(app).documentController.openFile(file)
        expect(internals(app).state.selectedPath).toBe(file.path)
        expect(layout.sidebarCollapsed).toBe(true)
        expect(descriptionSelected()).toBe(false)

        internals(app).state.selectedPath = null
        dailyView().onOpenFile(file)
        await vi.waitFor(() => expect(descriptionSelected()).toBe(true))
        expect(layout.sidebarCollapsed).toBe(false)
      } finally {
        await app.destroy()
      }
    })

    it('shows the Description tab only after the header creates and opens today\'s file', async () => {
      const app = await startApp(dom, createBackend().backend)
      try {
        const layout = testMocks.paneLayouts.at(-1)!
        const create = vi.spyOn(internals(app).fileOperationsController, 'createFileForToday')
        internals(app).state.dailyProblem = dailyProblem
        internals(app).state.selectedPath = null
        dom.window.dispatch('keydown', altDigit(1))

        // A failed creation reports its error and opens nothing.
        create.mockResolvedValueOnce(undefined)
        dailyView().onCreateFile()
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
        await Promise.resolve()
        await Promise.resolve()
        expect(layout.sidebarCollapsed).toBe(true)
        expect(descriptionSelected()).toBe(false)

        create.mockImplementationOnce(() => internals(app).documentController.openFile(file))
        dailyView().onCreateFile()
        await vi.waitFor(() => expect(descriptionSelected()).toBe(true))
        expect(layout.sidebarCollapsed).toBe(false)
      } finally {
        await app.destroy()
      }
    })

    it('switches tabs by click and arrow keys and restores the persisted tab', async () => {
      const storage = rememberedStorage()
      storage.setItem('leetcoder.sidebar-tab', 'description')
      const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
        backend: createBackend().backend,
        storage: storage as unknown as Storage,
      })
      await app.start()
      try {
        expect(descriptionSelected()).toBe(true)

        element('#sidebar-problems-tab').dispatch('click')
        expect(descriptionSelected()).toBe(false)
        expect(storage.getItem('leetcoder.sidebar-tab')).toBe('problems')

        const arrow = keydown({ key: 'ArrowRight' })
        element('#sidebar-problems-tab').dispatch('keydown', arrow)
        expect(arrow.preventDefault).toHaveBeenCalledOnce()
        expect(descriptionSelected()).toBe(true)
        expect(dom.document.activeElement).toBe(element('#sidebar-description-tab'))

        element('#sidebar-description-tab').dispatch('keydown', keydown({ key: 'Home' }))
        expect(descriptionSelected()).toBe(false)
        expect(dom.document.activeElement).toBe(element('#sidebar-problems-tab'))
      } finally {
        await app.destroy()
      }
    })

    it('returns to the Problems tab before focusing the file search', async () => {
      const app = await startApp(dom, createBackend().backend)
      try {
        element('#sidebar-description-tab').dispatch('click')
        expect(descriptionSelected()).toBe(true)

        dom.window.dispatch('keydown', keydown({ key: 'o', code: 'KeyO', shiftKey: true, altKey: true }))
        expect(descriptionSelected()).toBe(false)
        expect(dom.document.activeElement).toBe(element('#file-search'))

        element('#sidebar-description-tab').dispatch('click')
        testMocks.editorInstances.at(-1)?.triggerProjectSearch()
        expect(descriptionSelected()).toBe(false)
        expect(dom.document.activeElement).toBe(element('#file-search'))
      } finally {
        await app.destroy()
      }
    })
  })

  describe('keytips', () => {
    const shown = (): boolean => element('.app-shell').classList.contains('is-modifier-held')
    const alt = () => keydown({ key: 'Alt', code: 'AltLeft', altKey: true })
    const altUp = () => keydown({ key: 'Alt', code: 'AltLeft' })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('show after Alt is held alone on Linux, and hide on keyup, blur, or a visibility change', async () => {
      const app = await startApp(dom, createBackend().backend)
      vi.useFakeTimers()
      try {
        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(349)
        expect(shown()).toBe(false)
        // Auto-repeat keeps the first press's timer.
        dom.window.dispatch('keydown', { ...alt(), repeat: true })
        vi.advanceTimersByTime(1)
        expect(shown()).toBe(true)
        dom.window.dispatch('keyup', altUp())
        expect(shown()).toBe(false)

        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(350)
        dom.window.dispatch('blur')
        expect(shown()).toBe(false)

        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(350)
        dom.document.visibilityState = 'hidden'
        dom.document.dispatch('visibilitychange')
        expect(shown()).toBe(false)
        dom.document.visibilityState = 'visible'
      } finally {
        vi.useRealTimers()
        await app.destroy()
      }
    })

    it('never flash for a chord or a modifier-click', async () => {
      const app = await startApp(dom, createBackend().backend)
      vi.useFakeTimers()
      try {
        dom.window.dispatch('keydown', alt())
        dom.window.dispatch('keydown', keydown({ key: 'Control', code: 'ControlLeft', altKey: true, ctrlKey: true }))
        vi.advanceTimersByTime(1000)
        expect(shown()).toBe(false)

        dom.window.dispatch('keyup', altUp())
        dom.window.dispatch('keydown', alt())
        dom.window.dispatch('keydown', keydown({ key: 's', code: 'KeyS', altKey: true }))
        vi.advanceTimersByTime(1000)
        expect(shown()).toBe(false)

        dom.window.dispatch('keyup', altUp())
        dom.window.dispatch('keydown', alt())
        dom.window.dispatch('pointerdown')
        vi.advanceTimersByTime(1000)
        expect(shown()).toBe(false)

        // Alt joining a held Ctrl, or another modifier, is not Alt alone.
        dom.window.dispatch('keydown', keydown({ key: 'Alt', code: 'AltLeft', altKey: true, ctrlKey: true }))
        dom.window.dispatch('keydown', keydown({ key: 'Meta', code: 'MetaLeft', metaKey: true }))
        vi.advanceTimersByTime(1000)
        expect(shown()).toBe(false)
      } finally {
        vi.useRealTimers()
        await app.destroy()
      }
    })

    it('hide when another key or a pointer press follows while shown', async () => {
      const app = await startApp(dom, createBackend().backend)
      vi.useFakeTimers()
      try {
        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(350)
        expect(shown()).toBe(true)
        dom.window.dispatch('keydown', altDigit(9))
        expect(shown()).toBe(false)

        dom.window.dispatch('keyup', altUp())
        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(350)
        dom.window.dispatch('pointerdown')
        expect(shown()).toBe(false)
      } finally {
        vi.useRealTimers()
        await app.destroy()
      }
    })

    it('follow Cmd rather than Option on macOS', async () => {
      restoreNavigator()
      restoreNavigator = setNavigatorPlatform('MacIntel')
      const app = await startApp(dom, createBackend().backend)
      vi.useFakeTimers()
      try {
        dom.window.dispatch('keydown', alt())
        vi.advanceTimersByTime(1000)
        expect(shown()).toBe(false)
        dom.window.dispatch('keyup', altUp())
        dom.window.dispatch('keydown', keydown({ key: 'Meta', code: 'MetaLeft', metaKey: true }))
        vi.advanceTimersByTime(350)
        expect(shown()).toBe(true)
        dom.window.dispatch('keyup', keydown({ key: 'Meta', code: 'MetaLeft' }))
        expect(shown()).toBe(false)
      } finally {
        vi.useRealTimers()
        await app.destroy()
      }
    })

    it('cancel a pending timer on teardown', async () => {
      const app = await startApp(dom, createBackend().backend)
      vi.useFakeTimers()
      dom.window.dispatch('keydown', alt())
      await app.destroy()
      vi.advanceTimersByTime(1000)
      expect(shown()).toBe(false)
    })
  })
})

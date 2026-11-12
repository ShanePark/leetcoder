import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testMocks } from './lifecycle-mocks'
import {
  createBackend, installDom, startApp, FakeElement,
  setNavigatorPlatform, type DomHarness, type LeetcoderApp,
} from './lifecycle-harness'

interface AppInternals {
  state: {
    bottomPanelTab: 'tests' | 'git'
    selectedPath: string | null
    git: { commitMessage: string }
  }
  gitController: { commitSelectedFiles: (push: boolean) => Promise<void> }
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

  it('commits from the message field only while Commit is enabled', async () => {
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

  it('toggles the sidebar from its header button and moves focus off a collapsing sidebar', async () => {
    const app = await startApp(dom, createBackend().backend)
    try {
      const layout = testMocks.paneLayouts.at(-1)!
      const toggle = element('#sidebar-toggle')
      internals(app).state.selectedPath = null
      element('.sidebar').focus()

      dom.window.dispatch('keydown', altDigit(1))
      expect(layout.setSidebarCollapsed).toHaveBeenLastCalledWith(true)
      expect(dom.document.activeElement).toBe(toggle)

      toggle.dispatch('click')
      expect(layout.setSidebarCollapsed).toHaveBeenLastCalledWith(false)
      expect(layout.sidebarCollapsed).toBe(false)

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
      editor.triggerWorkspaceShortcut('toggle-sidebar')
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

import {
  aiButtonPresentation,
  aiReviewButtonPresentation,
  aiReviewMode,
  type AiButtonPresentation,
  type AiRequestKind,
} from './ai-controller'
import type { AiReviewMode } from '../backend'
import type { AppState, BottomPanelTab, SidebarTab } from './types'
import { gitFileName, hasPendingGitWork } from './git-helpers'
import { updateGitCommitControls as updateGitCommitControlsView } from './git-view'
import type { AiTestStub } from '../editor'
import { iconFor } from '../icons'
import { shortcutLabel } from '../shortcuts'

/** Bottom panel tabs in strip order. */
export const BOTTOM_PANEL_TABS: readonly BottomPanelTab[] = ['tests', 'review', 'git']

/** Sidebar tabs in strip order. */
export const SIDEBAR_TABS: readonly SidebarTab[] = ['problems', 'description']

interface ShellControlsViewOptions {
  root: HTMLElement
  state: AppState
  pickerOpen: () => boolean
  macPlatform: () => boolean
  invalidatePendingNavigation: () => void
  aiRequestPath: () => string | null
  aiRequestKind: () => AiRequestKind | null
  /** What the running review asks for, or null. */
  aiRequestReviewMode: () => AiReviewMode | null
  aiTestStub: () => AiTestStub
  aiCaseTestAvailable: () => boolean
  /** The @Test method holding the editor cursor, which Run selected targets. */
  testMethodAtCursor: () => string | null
}

/** Update shell controls directly without rebuilding focused editor or Git inputs. */
export class ShellControlsView {
  private readonly root: HTMLElement
  private readonly state: AppState
  private controlsBusy = false

  constructor(private readonly options: ShellControlsViewOptions) {
    this.root = options.root
    this.state = options.state
  }

  renderBottomPanelTabs(): void {
    for (const tab of BOTTOM_PANEL_TABS) {
      const selected = this.state.bottomPanelTab === tab
      const button = this.element<HTMLButtonElement>(`#${tab}-tab`)
      button.classList.toggle('is-active', selected)
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      this.element<HTMLElement>(`#${tab}-panel`).hidden = !selected
    }
    const testsTab = this.state.bottomPanelTab === 'tests'
    this.element<HTMLButtonElement>('#run-test').hidden = !testsTab
    this.element<HTMLButtonElement>('#run-selected-test').hidden = !testsTab
    this.element<HTMLElement>('#git-tab-indicator').hidden = !hasPendingGitWork(this.state.git)
  }

  /**
   * The header toggle reads as pressed only while the Problems tab is on
   * screen, because pressing it then hides the sidebar; from the Description
   * tab or a hidden sidebar it shows Problems instead.
   */
  renderSidebarTabs(activeTab: SidebarTab, sidebarCollapsed: boolean): void {
    for (const tab of SIDEBAR_TABS) {
      const selected = activeTab === tab
      const button = this.element<HTMLButtonElement>(`#sidebar-${tab}-tab`)
      button.classList.toggle('is-active', selected)
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      this.element<HTMLElement>(`#sidebar-${tab}-panel`).hidden = !selected
    }
    this.element<HTMLButtonElement>('#sidebar-toggle')
      .setAttribute('aria-pressed', String(!sidebarCollapsed && activeTab === 'problems'))
  }

  /**
   * Commit-bar enablement plus the computed placeholder. Kept separate from
   * renderGitPanel so typing in the message input never rebuilds the panel
   * (a rebuild would fight the caret).
   */
  updateGitCommitControls(): void {
    updateGitCommitControlsView(this.root, {
      bottomPanelTab: this.state.bottomPanelTab,
      busy: this.state.busy,
      git: this.state.git,
    })
  }

  /** Update controls whose disabled state changes while a file operation runs. */
  updateBusyControls(): void {
    const busy = this.state.busy
    if (busy && !this.controlsBusy) {
      this.options.invalidatePendingNavigation()
    }
    this.controlsBusy = busy
    this.element<HTMLButtonElement>('#choose-repository').disabled = busy || this.options.pickerOpen()
    this.root.querySelectorAll<HTMLButtonElement>('.file-item').forEach((button) => {
      button.disabled = busy
    })
    this.root.querySelectorAll<HTMLButtonElement>('.file-tab-close').forEach((button) => {
      button.disabled = busy
    })
    const dailyPrimary = this.root.querySelector<HTMLButtonElement>('.daily-primary')
    if (dailyPrimary) {
      dailyPrimary.disabled = busy || !this.state.projectValid || dailyPrimary.dataset.fileOpen === 'true'
    }
    this.root.querySelectorAll<HTMLButtonElement>('.daily-today, .problem-lookup-submit').forEach((button) => {
      button.disabled = busy || this.state.dailyLoading
    })
    this.root.querySelectorAll<HTMLInputElement>('.problem-lookup-input').forEach((input) => {
      input.disabled = busy || this.state.dailyLoading
    })
    this.root.querySelectorAll<HTMLInputElement>('.git-file-checkbox').forEach((checkbox) => {
      checkbox.disabled = busy || this.state.git.busy || this.state.git.loading
    })
    this.root.querySelectorAll<HTMLButtonElement>('.git-file-button').forEach((button) => {
      button.disabled = busy || this.state.git.busy
    })
    this.element<HTMLButtonElement>('#duplicate-file-action').disabled = busy
    this.element<HTMLButtonElement>('#rename-file-action').disabled = busy
    this.element<HTMLButtonElement>('#delete-file-action').disabled = busy
    this.element<HTMLButtonElement>('#git-discard-action').disabled = busy || this.state.git.busy || this.state.git.loading
    this.element<HTMLButtonElement>('#git-show-file-action').disabled = busy || this.state.git.busy || this.state.git.loading
    this.updateRunButtonState()
    this.updateAiButton()
    this.updateGitCommitControls()
  }

  /**
   * The AI buttons: generation follows the open file (see `aiButtonMode`), and
   * review sits beside it, offering help while the solution is unimplemented.
   */
  updateAiButton(): void {
    this.renderAiButton('#ai-review-code', aiReviewButtonPresentation(
      this.state.selectedPath,
      this.options.aiRequestPath(),
      this.options.aiRequestKind(),
      this.state.busy,
      this.state.dailyProblem,
      aiReviewMode(this.state.selectedSource),
      this.options.aiRequestReviewMode(),
    ))
    this.renderAiButton('#ai-generate-tests', aiButtonPresentation(
      this.state.selectedPath,
      this.options.aiRequestPath(),
      this.options.aiRequestKind(),
      this.state.busy,
      this.state.dailyProblem,
      this.options.aiTestStub(),
      this.options.aiCaseTestAvailable(),
    ))
  }

  private renderAiButton(selector: string, presentation: AiButtonPresentation): void {
    const button = this.element<HTMLButtonElement>(selector)
    if (button.dataset.icon !== presentation.icon || button.dataset.text !== presentation.text) {
      button.dataset.icon = presentation.icon
      button.dataset.text = presentation.text
      const text = document.createElement('span')
      text.className = 'ai-action-label'
      text.textContent = presentation.text
      button.replaceChildren(
        iconFor(presentation.icon, presentation.busy ? 'button-icon is-spinning' : 'button-icon'),
        text,
      )
    }
    button.hidden = presentation.hidden
    button.disabled = presentation.disabled
    button.setAttribute('aria-busy', String(presentation.busy))
    button.setAttribute('aria-label', presentation.label)
    button.title = presentation.title
  }

  updateRunButtonState(): void {
    const runButton = this.element<HTMLButtonElement>('#run-test')
    const run = this.state.testRun?.status === 'running' ? this.state.testRun : null
    const stopRequested = run?.stopRequested ?? false
    const runLabel = this.element<HTMLElement>('#run-label')
    const shortcut = this.element<HTMLElement>('#run-shortcut')
    const isStopAction = run !== null
    const mac = this.options.macPlatform()
    const runShortcut = shortcutLabel('run-test', mac)
    runLabel.textContent = isStopAction ? stopRequested ? 'Stopping…' : 'Stop' : 'Run'
    shortcut.hidden = isStopAction
    runButton.classList.toggle('is-stop-action', isStopAction)
    runButton.disabled = isStopAction ? stopRequested : this.state.busy || !this.state.selectedFqcn
    runButton.setAttribute('aria-busy', String(stopRequested))
    runButton.setAttribute('aria-label', isStopAction
      ? stopRequested ? 'Stopping the test run' : 'Stop test run'
      : `Run all tests (${runShortcut})`)
    runButton.title = isStopAction
      ? stopRequested ? 'Stopping the test run…' : 'Stop test run'
      : this.state.selectedFqcn
        ? `Run all tests (${runShortcut})`
        : 'Select a Java problem file to run'
    const action = isStopAction ? 'stop' : 'run'
    if (runButton.dataset.runAction !== action) {
      runButton.querySelector<SVGElement>('.button-icon')?.replaceWith(
        iconFor(isStopAction ? 'close' : 'play', 'button-icon'),
      )
      runButton.dataset.runAction = action
    }
    this.updateRunSelectedButton()
  }

  /**
   * Run selected follows the cursor, so the editor refreshes it on every
   * selection change. It stays disabled during a run rather than becoming a
   * second Stop button.
   */
  updateRunSelectedButton(): void {
    const button = this.element<HTMLButtonElement>('#run-selected-test')
    const running = this.state.testRun?.status === 'running'
    const method = this.state.selectedFqcn ? this.options.testMethodAtCursor() : null
    const shortcut = shortcutLabel('run-test-at-cursor', this.options.macPlatform())
    button.disabled = running || this.state.busy || method === null
    button.title = running
      ? 'Wait for the current test run to finish'
      : !this.state.selectedFqcn
        ? 'Select a Java problem file to run'
        : method === null
          ? 'Put the cursor in an @Test method to run only that test'
          : `Run ${method}() (${shortcut})`
    button.setAttribute('aria-label', method === null || running
      ? `Run selected test (${shortcut})`
      : `Run ${method}() (${shortcut})`)
  }

  updateEditorVisibility(): void {
    this.element<HTMLElement>('#editor-empty').hidden = Boolean(this.state.selectedPath)
    this.element<HTMLElement>('#editor-host').classList.toggle('is-empty', !this.state.selectedPath)
  }

  renderHeader(): void {
    const chip = this.element<HTMLButtonElement>('#choose-repository')
    const label = this.element<HTMLElement>('#repo-path')
    chip.setAttribute('aria-busy', String(this.options.pickerOpen()))
    if (this.options.pickerOpen()) {
      label.textContent = 'Choosing repository…'
      chip.title = 'The repository picker is already open'
      chip.classList.remove('is-empty')
      return
    }
    if (this.state.repoPath) {
      label.textContent = gitFileName(this.state.repoPath)
      chip.title = this.state.repoPath
      chip.classList.remove('is-empty')
    } else {
      label.textContent = 'Choose repository'
      chip.title = 'Choose repository'
      chip.classList.add('is-empty')
    }
  }

  renderShortcutLabels(): void {
    const mac = this.options.macPlatform()
    this.element<HTMLElement>('#run-shortcut').textContent = shortcutLabel('run-test', mac)
    this.element<HTMLElement>('#run-selected-shortcut').textContent =
      shortcutLabel('run-test-at-cursor', mac)
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing editor element: ${selector}`)
    return element
  }
}

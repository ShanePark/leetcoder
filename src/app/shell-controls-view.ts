import type { AppState } from './types'
import { gitFileName } from './git-helpers'
import { updateGitCommitControls as updateGitCommitControlsView } from './git-view'
import { iconFor } from '../icons'
import { shortcutLabel } from '../shortcuts'

interface ShellControlsViewOptions {
  root: HTMLElement
  state: AppState
  pickerOpen: () => boolean
  macPlatform: () => boolean
  invalidatePendingNavigation: () => void
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
    const testsTab = this.element<HTMLButtonElement>('#tests-tab')
    const gitTab = this.element<HTMLButtonElement>('#git-tab')
    const testsSelected = this.state.bottomPanelTab === 'tests'
    testsTab.classList.toggle('is-active', testsSelected)
    gitTab.classList.toggle('is-active', !testsSelected)
    testsTab.setAttribute('aria-selected', String(testsSelected))
    gitTab.setAttribute('aria-selected', String(!testsSelected))
    testsTab.tabIndex = testsSelected ? 0 : -1
    gitTab.tabIndex = testsSelected ? -1 : 0
    this.element<HTMLElement>('#tests-panel').hidden = !testsSelected
    this.element<HTMLElement>('#git-panel').hidden = testsSelected
    this.element<HTMLButtonElement>('#run-test').hidden = !testsSelected
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
    this.element<HTMLButtonElement>('#refresh-files').disabled = busy || !this.state.projectValid
    this.root.querySelectorAll<HTMLButtonElement>('.file-item').forEach((button) => {
      button.disabled = busy
    })
    this.root.querySelectorAll<HTMLButtonElement>('.file-tab-close').forEach((button) => {
      button.disabled = busy
    })
    const dailyPrimary = this.root.querySelector<HTMLButtonElement>('.daily-primary')
    if (dailyPrimary) {
      dailyPrimary.disabled = busy || !this.state.projectValid
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
    this.updateGitCommitControls()
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

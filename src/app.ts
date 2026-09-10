import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import {
  createBackendClient,
  errorMessage,
  type BackendClient,
  type ProblemDiagnostic,
  type ProblemFileEntry,
  type RepositoryFilesChanged,
} from './backend'
import {
  findJavaTestMethodAt,
  JavaEditor,
  isShortcutHelpAltShortcut,
} from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'
import {
  isSettingsShortcut,
  runShortcutAction,
  shortcutHints,
  shortcutLabel,
} from './shortcuts'
import { createUpdateController, UPDATE_CHECK_INTERVAL_MS, type UpdateController } from './update-controller'
import {
  createUpdateProgressView,
  listenForUpdateProgress,
} from './update-progress'
import {
  LiveDiagnosticsScheduler,
  type LiveDiagnosticsSnapshot,
} from './live-diagnostics'

import {
  accordionGroupKeys,
  isCloseAllTabsShortcut,
  isCloseTabShortcut,
  isCurrentRepositoryRefresh,
  RepositoryPickerCoordinator,
} from './app/navigation'
import {
  collectDiagnosticEditorIssues,
  collectEditorIssues,
} from './app/test-results'
import {
  gitFileName,
} from './app/git-helpers'
import { createGitState, GitController } from './app/git-controller'
import { createPaneLayoutController, type PaneLayoutController } from './app/pane-layout'
import { ProblemSelectionController } from './app/problem-selection-controller'
import { DocumentController } from './app/document-controller'
import { FileOperationsController } from './app/file-operations-controller'
import {
  createFileTabsView,
  renderFileHeading as renderFileHeadingView,
  type FileTabsView,
  type FileTabsViewModel,
} from './app/tabs-view'
import { TestRunController } from './app/test-run-controller'
import { ToastController } from './app/toast-controller'
import { OverlayController } from './app/overlay-controller'
import { findIndexedProblemFile, indexProblemFiles } from './app/file-index'
import {
  renderGitPanel as renderGitPanelView,
  updateGitCommitControls as updateGitCommitControlsView,
} from './app/git-view'
import {
  findTodayProblemFile,
  joinFilePath,
  normalizeJavaFileName,
} from './app/file-helpers'
import {
  gitDirectoryPath,
  sameFilePath,
} from './app/path-helpers'
import {
  DEFAULT_GIT_FILE_LIST_WIDTH,
  MAX_BOTTOM_PANEL_HEIGHT,
  MAX_DAILY_DESCRIPTION_HEIGHT,
  MAX_SIDEBAR_WIDTH,
  MIN_BOTTOM_PANEL_HEIGHT,
  MIN_DAILY_DESCRIPTION_HEIGHT,
  MIN_GIT_DIFF_WIDTH,
  MIN_GIT_FILE_LIST_WIDTH,
  MIN_SIDEBAR_WIDTH,
  isMacPlatform,
} from './app/layout'
import {
  renderDeleteFileDialog as renderDeleteFileDialogView,
  renderDiscardGitDialog as renderDiscardGitDialogView,
  renderFileContextMenu as renderFileContextMenuView,
  renderGitContextMenu as renderGitContextMenuView,
} from './app/dialogs-view'
import { renderShellView } from './app/shell-view'
import { renderTestResults } from './app/results-view'
import {
  FILE_GROUPS,
  OTHER_GROUP,
  renderFilesView,
} from './app/files-view'
import {
  createDailyProblemView,
  type DailyProblemViewRenderer,
} from './app/daily-view'
import type {
  AppOptions,
  AppState,
  DirectoryPicker,
  GitChangedFile,
  LiveDiagnosticsBackend,
  OpenFileTab,
} from './app/types'
const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const APP_VERSION = '0.1.0'
const DAILY_DESCRIPTION_KEY = 'leetcoder.daily-description'

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly repositoryPicker = new RepositoryPickerCoordinator()
  private readonly storage: Storage | undefined
  private readonly requestClose: (() => Promise<void>) | undefined
  private readonly updateProgressView = createUpdateProgressView()
  private readonly toastController: ToastController
  private readonly overlay: OverlayController
  private updateController: UpdateController
  private updateProgressListenerStop: (() => void) | null = null
  private updateCheckTimer: ReturnType<typeof setInterval> | null = null
  private readonly state: AppState = {
    repoPath: null,
    projectValid: false,
    files: [],
    openTabs: [],
    activeTabId: null,
    selectedPath: null,
    selectedSource: '',
    savedSource: '',
    selectedFqcn: null,
    dirty: false,
    dailyProblem: null,
    problemSelection: 'daily',
    dailyProblemDateKey: null,
    dailyRetryPending: false,
    dailyError: null,
    dailyLoading: false,
    testResult: null,
    testRun: null,
    liveDiagnosticsError: null,
    selectedTestKey: null,
    busy: false,
    fileSearch: '',
    saveError: null,
    bottomPanelTab: 'tests',
    contextMenu: null,
    gitContextMenu: null,
    git: createGitState(),
  }
  private editor: JavaEditor
  private readonly liveDiagnostics: LiveDiagnosticsScheduler
  private readonly dailyProblemView: DailyProblemViewRenderer
  private readonly problemSelectionController: ProblemSelectionController
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private stopWatchingFiles: (() => void) | null = null
  private readonly appListeners: Array<() => void> = []
  private destroyed = false
  private dailyDescriptionOpen = false
  private gitDiscardDialogFile: GitChangedFile | null = null
  private gitDiscardDialogFocusTarget: HTMLElement | null = null
  private deleteDialogFile: ProblemFileEntry | null = null
  private deleteDialogFocusTarget: HTMLElement | null = null
  private renameTargetFile: ProblemFileEntry | null = null
  private readonly gitController: GitController
  private readonly paneLayout: PaneLayoutController
  private readonly fileTabsView: FileTabsView
  private readonly testRunController: TestRunController
  private readonly documentController: DocumentController
  private readonly fileOperationsController: FileOperationsController
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    accordionGroupKeys('easy', true),
  )
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isSettingsShortcut(event, currentIsMacPlatform())) {
      event.preventDefault()
      this.overlay.openSettingsDialog('appearance')
      return
    }
    if (isShortcutHelpAltShortcut(event)) {
      // The keymap has to be reachable from anywhere, including the file
      // explorer and the run panel.
      event.preventDefault()
      this.overlay.openSettingsDialog('keymap')
      return
    }
    if (isCloseAllTabsShortcut(event, currentIsMacPlatform())) {
      // Handle this before the editor guard so the entire tab strip can close
      // while CodeMirror has focus, without allowing the native window to
      // consume the shortcut first.
      event.preventDefault()
      void this.closeAllOpenTabs()
      return
    }
    if (isCloseTabShortcut(event, currentIsMacPlatform())) {
      // Handle this before the editor guard so the active tab can be closed
      // even while CodeMirror has focus. An empty or busy tab strip is a safe
      // no-op inside closeOpenTab, but the native window must not close.
      event.preventDefault()
      if (this.state.activeTabId !== null) {
        void this.closeOpenTab(this.state.activeTabId)
      }
      return
    }
    // CodeMirror owns shortcuts while the editor has focus. Handling them
    // again on window would run/save the same document twice.
    const editorTarget = event.target instanceof Node && this.element('#editor').contains(event.target)
    const runAction = runShortcutAction(event)
    if (runAction) {
      if (editorTarget) {
        return
      }
      event.preventDefault()
      if (runAction === 'run-test') {
        void this.testRunController.runCurrentTest()
      } else {
        // Ctrl+Shift+R is still useful outside an @Test method. In that
        // context it follows Ctrl+R and runs the complete test class.
        void this.testRunController.runCurrentTest(findJavaTestMethodAt(this.editor.view.state) ?? undefined)
      }
      return
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || editorTarget) {
      return
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void this.saveCurrentFile()
    }
  }

  private readonly handleWindowFocus = (): void => {
    this.handleAppVisibilityReturn()
  }

  private readonly handleEditorFocus = (): void => {
    this.revealSelectedFileInExplorer()
  }

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.gitController.clearScheduledRefresh()
      this.problemSelectionController.clearScheduledRefresh()
      return
    }
    this.handleAppVisibilityReturn()
  }

  private readonly handleContextMenuOutside = (event: PointerEvent): void => {
    this.overlay.handleOutsidePointerDown(event)
    const fileMenu = this.root.querySelector<HTMLElement>('#file-context-menu')
    const gitMenu = this.root.querySelector<HTMLElement>('#git-context-menu')
    const target = event.target instanceof Node ? event.target : null
    const insideFileMenu = Boolean(fileMenu && !fileMenu.hidden && target && fileMenu.contains(target))
    const insideGitMenu = Boolean(gitMenu && !gitMenu.hidden && target && gitMenu.contains(target))
    if (!insideFileMenu && !insideGitMenu) {
      this.closeFileContextMenu()
      this.closeGitContextMenu()
    }
  }

  private readonly handleContextMenuKeydown = (event: KeyboardEvent): void => {
    if (this.overlay.handleEscape(event)) {
      return
    }
    if (event.key !== 'Escape') {
      return
    }
    if (this.gitDiscardDialogFile) {
      event.preventDefault()
      this.closeDiscardGitDialog()
    } else if (this.deleteDialogFile) {
      event.preventDefault()
      this.closeDeleteFileDialog()
    } else if (this.renameTargetFile) {
      event.preventDefault()
      this.closeRenameDialog()
    } else if (this.state.gitContextMenu) {
      event.preventDefault()
      this.closeGitContextMenu()
    } else if (this.state.contextMenu) {
      event.preventDefault()
      this.closeFileContextMenu()
    }
  }

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.root = root
    this.backend = options.backend ?? createBackendClient()
    this.directoryPicker = options.directoryPicker ?? defaultDirectoryPicker
    this.storage = options.storage ?? safeStorage()
    this.requestClose = options.requestClose
    this.dailyDescriptionOpen = this.storage?.getItem(DAILY_DESCRIPTION_KEY) === 'open'
    this.gitController = new GitController(this.backend, {
      getContext: () => ({
        repoPath: this.state.repoPath,
        projectValid: this.state.projectValid,
        repositoryGeneration: this.repositoryGeneration,
        appBusy: this.state.busy,
      }),
      flushPendingSave: () => this.flushPendingSave(),
      setAppBusy: (busy) => {
        this.state.busy = busy
      },
      render: () => this.renderAll(),
      renderPanel: () => this.renderGitPanel(),
      isGitPanelVisible: () => this.state.bottomPanelTab === 'git',
      isWindowVisible: () => this.isWindowVisible(),
      isDestroyed: () => this.destroyed,
      setMessage: (message, tone) => this.setMessage(message, tone),
    }, this.state.git)
    this.renderShell()
    this.toastController = new ToastController(this.element<HTMLElement>('#toast-stack'))
    this.overlay = new OverlayController({
      root: this.root,
      storage: this.storage,
      macPlatform: currentIsMacPlatform(),
      onRequestUpdate: () => this.requestApplicationUpdate(),
      onRequestClose: () => this.requestApplicationClose(),
    })
    this.paneLayout = createPaneLayoutController(this.root, { storage: this.storage })
    this.fileTabsView = createFileTabsView(this.element<HTMLElement>('#file-tabs'), {
      onOpenTab: (tabId) => this.openTab(tabId),
      onCloseTab: (tabId) => this.closeOpenTab(tabId),
    })
    this.problemSelectionController = new ProblemSelectionController({
      state: this.state,
      backend: this.backend,
      render: () => this.renderAll(),
      setMessage: (message, tone) => this.setMessage(message, tone),
      isWindowVisible: () => this.isWindowVisible(),
      isDestroyed: () => this.destroyed,
    })
    this.dailyProblemView = createDailyProblemView(
      {
        header: this.element<HTMLElement>('#daily-header'),
        description: this.element<HTMLElement>('#daily-description'),
        resizeHandle: this.element<HTMLElement>('#daily-description-resize-handle'),
      },
      {
        onLookupInput: (value) => this.problemSelectionController.setProblemNumberDraft(value),
        onLookupSubmit: (value) => {
          void this.problemSelectionController.loadProblemByNumber(value)
        },
        onRetry: () => {
          this.problemSelectionController.retry()
        },
        onBackToToday: () => {
          this.problemSelectionController.selectToday()
        },
        onRefresh: () => this.problemSelectionController.refreshSelectedProblem(),
        onToggleDescription: () => {
          this.dailyDescriptionOpen = !this.dailyDescriptionOpen
          this.storage?.setItem(DAILY_DESCRIPTION_KEY, this.dailyDescriptionOpen ? 'open' : 'closed')
          this.renderDailyProblem()
        },
        onOpenFile: (file) => {
          void this.openFile(file)
        },
        onCreateFile: () => {
          void this.createFileForToday()
        },
        onApplyDescriptionHeight: () => this.paneLayout.applyDailyDescriptionHeight(),
      },
    )
    this.updateController = createUpdateController(
      {
        checkForUpdate: () => this.backend.checkForUpdate(),
        updateAndRestart: () => this.backend.updateAndRestart(),
      },
      {
        setUpdateAvailable: (available) => {
          this.overlay.setUpdateAvailable(available)
          const button = this.root.querySelector<HTMLButtonElement>('#update-button')
          if (button) button.hidden = !available
        },
        setUpdateBusy: (busy) => {
          this.overlay.setUpdateBusy(busy)
          const button = this.root.querySelector<HTMLButtonElement>('#update-button')
          if (button) {
            button.disabled = busy
            button.classList.toggle('is-spinning', busy)
            button.setAttribute('aria-busy', String(busy))
            button.setAttribute('aria-label', busy ? 'Updating leetcoder' : 'Update leetcoder')
            button.title = busy ? 'Updating leetcoder — building and restarting' : 'Update available — build and restart'
          }
        },
        showUpdateStarted: () => this.updateProgressView.start(),
        showError: (message) => {
          this.updateProgressView.fail()
          this.setMessage(`Update failed: ${message}`, 'error')
        },
      },
    )
    this.liveDiagnostics = new LiveDiagnosticsScheduler({
      check: (snapshot) => this.checkLiveDiagnostics(snapshot),
      onResult: (snapshot, diagnostics) => this.applyLiveDiagnostics(snapshot, diagnostics),
      onError: (snapshot, error) => this.handleLiveDiagnosticsError(snapshot, error),
    })
    this.testRunController = new TestRunController({
      state: this.state,
      runProblemTest: this.backend.runProblemTest.bind(this.backend),
      flushPendingSave: () => this.flushPendingSave(),
      setEditorIssues: (issues) => this.editor.setIssues(issues),
      setLiveDiagnosticsBlocked: (blocked) => this.liveDiagnostics.setBlocked(blocked),
      cancelLiveDiagnostics: () => this.liveDiagnostics.cancel(),
      clearLiveDiagnosticsError: () => {
        this.state.liveDiagnosticsError = null
      },
      selectTestsTab: () => this.selectBottomPanelTab('tests'),
      renderAll: () => this.renderAll(),
      renderResult: () => this.renderResult(),
      setMessage: (message, tone) => this.setMessage(message, tone),
      focusTestResult: (key) => {
        const item = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.test-tree-item'))
          .find((entry) => entry.dataset.testKey === key)
        item?.focus()
      },
      isDestroyed: () => this.destroyed,
    })
    this.editor = new JavaEditor(this.element('#editor'), {
      // JavaEditor may emit a bootstrap change while it is being constructed;
      // the document controller is wired immediately afterwards.
      onChange: (source) => this.documentController?.onEditorChange(source),
      onSave: () => {
        void this.saveCurrentFile()
        return true
      },
      onRun: () => {
        void this.testRunController.runCurrentTest()
        return true
      },
      onShowShortcuts: () => {
        this.overlay.openSettingsDialog('keymap')
      },
      onShowSettings: () => {
        this.overlay.openSettingsDialog('appearance')
      },
      onRefactorError: (message) => this.setMessage(message, 'error'),
      onRunTestAtCursor: (methodName) => {
        // A cursor miss falls back to the same all-tests run as Ctrl+R. This
        // keeps the editor keymap and the window-level shortcut consistent.
        void this.testRunController.runCurrentTest(methodName ?? undefined)
        return true
      },
    })
    this.documentController = new DocumentController({
      state: this.state,
      backend: this.backend,
      editor: this.editor,
      getRepositoryGeneration: () => this.repositoryGeneration,
      resetTestState: () => this.testRunController.resetTestState(),
      cancelCurrentRun: () => this.testRunController.cancelCurrentRun(),
      renderAll: () => this.renderAll(),
      renderFileHeading: () => this.renderFileHeading(),
      renderFileTabs: () => this.renderFileTabs(),
      updateFileTabState: () => this.updateFileTabState(),
      updateFileExplorerState: () => this.updateFileExplorerState(),
      updateEditorVisibility: () => this.updateEditorVisibility(),
      renderResult: () => this.renderResult(),
      setExpandedGroup: (group, expanded) => this.setExpandedGroup(group, expanded),
      scheduleLiveDiagnostics: () => this.scheduleLiveDiagnostics(),
      markGitStale: () => this.gitController.markStale(),
      setSavedSource: (source) => {
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      },
      setMessage: (message, tone) => this.setMessage(message, tone),
      renderBusyControls: () => this.updateBusyControls(),
      revealSelectedFileInExplorer: () => this.revealSelectedFileInExplorer(),
      isDestroyed: () => this.destroyed,
    })
    this.fileOperationsController = new FileOperationsController({
      state: this.state,
      backend: this.backend,
      document: this.documentController,
      git: this.gitController,
      createProblem: (repoPath, problem) => createProblemWithRetry(this.backend, repoPath, problem),
      refreshFiles: () => this.refreshFiles(),
      repositoryGeneration: () => this.repositoryGeneration,
      getGitFiles: () => this.state.git.files,
      setAppBusy: (busy) => {
        this.state.busy = busy
      },
      render: () => this.renderAll(),
      setMessage: (message, tone) => this.setMessage(message, tone),
      isDestroyed: () => this.destroyed,
    })
    this.bindEvents()
    this.renderAll()
  }

  async start(): Promise<void> {
    this.updateProgressListenerStop = await listenForUpdateProgress((payload) => {
      this.updateProgressView.update(payload)
    })
    try {
      this.stopWatchingFiles = await this.backend.onRepositoryFilesChanged(
        this.handleRepositoryFilesChanged,
      )
    } catch {
      // Without the watcher the editor still syncs on window focus.
    }
    await this.problemSelectionController.loadDailyProblem()
    const rememberedPath = this.storage?.getItem(LAST_REPOSITORY_KEY) ?? null
    if (rememberedPath) {
      await this.selectRepository(rememberedPath, false)
    } else {
      this.setMessage('Choose a repository to get started.', 'info')
    }
    this.installUpdatePolling()
  }

  private installUpdatePolling(): void {
    if (this.updateCheckTimer !== null) {
      clearInterval(this.updateCheckTimer)
    }
    void this.updateController.checkForUpdate()
    this.updateCheckTimer = setInterval(() => {
      void this.updateController.checkForUpdate()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  async prepareToClose(): Promise<void> {
    await this.documentController.prepareToClose()
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    await this.prepareToClose()
    this.fileOperationsController.dispose()
    this.testRunController.dispose()
    this.liveDiagnostics.dispose()
    this.gitController.dispose()
    this.documentController.dispose()
    this.fileTabsView.dispose()
    this.paneLayout.destroy()
    this.editor.destroy()
    for (const remove of this.appListeners.splice(0)) {
      remove()
    }
    this.problemSelectionController.dispose()
    if (this.updateCheckTimer !== null) {
      clearInterval(this.updateCheckTimer)
      this.updateCheckTimer = null
    }
    this.updateProgressListenerStop?.()
    this.updateProgressListenerStop = null
    this.updateProgressView.fail()
    this.toastController.dispose()
    this.overlay.dispose()
    this.stopWatchingFiles?.()
    this.stopWatchingFiles = null
    void this.backend.stopWatchingRepository().catch(() => {})
    this.destroyed = true
  }

  private renderShell(): void {
    renderShellView(this.root, {
      appVersion: APP_VERSION,
      macPlatform: currentIsMacPlatform(),
      minSidebarWidth: MIN_SIDEBAR_WIDTH,
      maxSidebarWidth: MAX_SIDEBAR_WIDTH,
      minDailyDescriptionHeight: MIN_DAILY_DESCRIPTION_HEIGHT,
      maxDailyDescriptionHeight: MAX_DAILY_DESCRIPTION_HEIGHT,
      minBottomPanelHeight: MIN_BOTTOM_PANEL_HEIGHT,
      maxBottomPanelHeight: MAX_BOTTOM_PANEL_HEIGHT,
      minGitFileListWidth: MIN_GIT_FILE_LIST_WIDTH,
      maxGitFileListWidth: DEFAULT_GIT_FILE_LIST_WIDTH + MIN_GIT_DIFF_WIDTH,
    })
    this.installStaticIcons()
    this.renderEditorEmptyState()
  }

  private installStaticIcons(): void {
    this.element<HTMLButtonElement>('#app-menu-button').append(iconFor('menu', 'button-icon'))
    this.element<HTMLElement>('#update-menu-icon').append(iconFor('refresh', 'app-menu-action-icon'))
    this.element<HTMLElement>('#settings-menu-icon').append(iconFor('settings', 'app-menu-action-icon'))
    this.element<HTMLElement>('#about-menu-icon').append(iconFor('info', 'app-menu-action-icon'))
    this.element<HTMLElement>('#exit-menu-icon').append(iconFor('power', 'app-menu-action-icon'))
    this.element<HTMLButtonElement>('#choose-repository').prepend(iconFor('folderOpen', 'button-icon'))
    this.element<HTMLButtonElement>('#update-button').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLButtonElement>('#refresh-files').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLElement>('#file-search-icon').append(iconFor('search', 'search-icon'))
    this.element<HTMLButtonElement>('#run-test').prepend(iconFor('play', 'button-icon'))
    this.element<HTMLElement>('#git-branch-icon').append(iconFor('gitBranch', 'button-icon'))
  }

  private renderEditorEmptyState(): void {
    const empty = this.element<HTMLElement>('#editor-empty')
    empty.innerHTML = ''
    empty.append(iconFor('fileCode', 'editor-empty-icon'))
    const copy = document.createElement('p')
    copy.className = 'editor-empty-copy'
    copy.textContent = 'Select a problem to start'
    empty.append(copy)
    const hints = document.createElement('div')
    hints.className = 'editor-empty-hints'
    for (const [keys, label] of shortcutHints(currentIsMacPlatform())) {
      const hint = document.createElement('span')
      hint.className = 'editor-empty-hint'
      const kbd = document.createElement('kbd')
      kbd.textContent = keys
      hint.append(kbd, document.createTextNode(` ${label}`))
      hints.append(hint)
    }
    empty.append(hints)
  }


  private bindEvents(): void {
    this.listen(this.element<HTMLButtonElement>('#update-button'), 'click', () => {
      void this.requestApplicationUpdate()
    })
    this.listen(this.element<HTMLButtonElement>('#choose-repository'), 'click', () => {
      void this.chooseRepository()
    })
    this.listen(this.element<HTMLButtonElement>('#refresh-files'), 'click', () => {
      if (!this.state.busy) {
        void this.refreshFiles()
      }
    })
    this.listen(this.element<HTMLElement>('#editor-host'), 'focusin', this.handleEditorFocus)
    this.listen(this.element<HTMLInputElement>('#file-search'), 'input', (event) => {
      this.closeFileContextMenu()
      this.state.fileSearch = (event.target as HTMLInputElement).value
      this.renderFiles()
    })
    this.listen(this.element<HTMLInputElement>('#file-search'), 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        const input = event.currentTarget as HTMLInputElement
        if (input.value.length > 0 || this.state.fileSearch.length > 0) {
          input.value = ''
          this.state.fileSearch = ''
          this.renderFiles()
        }
      }
    })
    this.listen(this.element<HTMLButtonElement>('#run-test'), 'click', () => {
      void this.testRunController.runCurrentTest()
    })
    this.listen(this.element<HTMLButtonElement>('#tests-tab'), 'click', () => {
      this.selectBottomPanelTab('tests')
    })
    this.listen(this.element<HTMLButtonElement>('#git-tab'), 'click', () => {
      this.selectBottomPanelTab('git')
    })
    for (const tab of [
      this.element<HTMLButtonElement>('#tests-tab'),
      this.element<HTMLButtonElement>('#git-tab'),
    ]) {
      this.listen(tab, 'keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
          return
        }
        event.preventDefault()
        const nextTab = event.key === 'Home' || (event.key === 'ArrowLeft' && tab.id === 'git-tab')
          ? 'tests'
          : event.key === 'End' || (event.key === 'ArrowRight' && tab.id === 'tests-tab')
            ? 'git'
            : tab.id === 'tests-tab' ? 'git' : 'tests'
        this.selectBottomPanelTab(nextTab, true)
      })
    }
    this.listen(this.element<HTMLButtonElement>('#git-select-all'), 'click', () => {
      this.gitController.selectAllFiles()
    })
    this.listen(this.element<HTMLButtonElement>('#git-select-none'), 'click', () => {
      this.gitController.selectNoFiles()
    })
    this.listen(this.element<HTMLInputElement>('#git-commit-message'), 'input', (event) => {
      // Typing must not re-render the panel — a rerender would fight the
      // caret. Only the commit-control enablement updates directly.
      this.state.git.commitMessage = (event.target as HTMLInputElement).value
      this.state.git.commitMessageEdited = this.state.git.commitMessage.trim().length > 0
      this.updateGitCommitControls()
    })
    this.listen(this.element<HTMLButtonElement>('#git-commit'), 'click', () => {
      void this.gitController.commitSelectedFiles(false)
    })
    this.listen(this.element<HTMLButtonElement>('#git-commit-push'), 'click', () => {
      void this.gitController.commitSelectedFiles(true)
    })
    this.listen(this.element<HTMLButtonElement>('#delete-file-action'), 'click', () => {
      this.openDeleteFileDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#git-discard-action'), 'click', () => {
      this.openDiscardGitDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#git-show-file-action'), 'click', () => {
      void this.showGitFileInManager()
    })
    this.listen(this.element<HTMLButtonElement>('#duplicate-file-action'), 'click', () => {
      void this.duplicateContextMenuFile()
    })
    this.listen(this.element<HTMLButtonElement>('#rename-file-action'), 'click', () => {
      this.openRenameDialog()
    })
    this.listen(this.element<HTMLFormElement>('#rename-file-form'), 'submit', (event) => {
      event.preventDefault()
      void this.renameDialogFile()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-rename-file'), 'click', () => {
      this.closeRenameDialog()
    })
    this.listen(this.element<HTMLElement>('#rename-file-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeRenameDialog()
      }
    })
    this.listen(this.element<HTMLFormElement>('#discard-git-form'), 'submit', (event) => {
      event.preventDefault()
      this.confirmDiscardGitDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-discard-git'), 'click', () => {
      this.closeDiscardGitDialog()
    })
    this.listen(this.element<HTMLElement>('#discard-git-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDiscardGitDialog()
      }
    })
    this.listen(this.element<HTMLFormElement>('#delete-file-form'), 'submit', (event) => {
      event.preventDefault()
      this.confirmDeleteFileDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-delete-file'), 'click', () => {
      this.closeDeleteFileDialog()
    })
    this.listen(this.element<HTMLElement>('#delete-file-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDeleteFileDialog()
      }
    })
    this.listen(window, 'pointerdown', this.handleContextMenuOutside)
    this.listen(window, 'keydown', this.handleContextMenuKeydown)
    this.listen(window, 'keydown', this.handleGlobalKeydown)
    this.listen(window, 'focus', this.handleWindowFocus)
    this.listen(document, 'visibilitychange', this.handleVisibilityChange)
  }

  private async chooseRepository(): Promise<void> {
    if (this.state.busy) {
      return
    }
    const selection = this.repositoryPicker.open(this.directoryPicker)
    if (!selection) {
      return
    }
    this.renderAll()
    try {
      const selectedPath = await selection
      if (selectedPath) {
        await this.selectRepository(selectedPath, true)
      }
    } catch (error) {
      this.setMessage(errorMessage(error), 'error')
    } finally {
      this.renderAll()
    }
  }

  private async selectRepository(path: string, remember: boolean): Promise<void> {
    if (this.state.busy) {
      return
    }
    this.closeFileContextMenu()
    const switchingRepository = path !== this.state.repoPath
    if (switchingRepository) {
      this.repositoryGeneration += 1
      this.refreshRequestId += 1
    }
    this.state.busy = true
    this.renderAll()
    if (path !== this.state.repoPath && !(await this.flushPendingSave())) {
      this.state.busy = false
      this.renderAll()
      return
    }
    if (switchingRepository) {
      // Clear the old document before loading the new repository. Relative
      // paths can be identical across repositories and must never reuse the
      // previous source, FQCN, or test output.
      void this.backend.stopWatchingRepository().catch(() => {})
      this.state.repoPath = null
      this.state.projectValid = false
      this.state.files = []
      this.state.openTabs = []
      this.state.fileSearch = ''
      this.state.gitContextMenu = null
      this.gitDiscardDialogFile = null
      this.gitDiscardDialogFocusTarget = null
      this.gitController.reset()
      this.resetCurrentFile()
    }
    try {
      const validation = await this.backend.validateProject(path)
      if (!validation.valid) {
        this.storage?.removeItem(LAST_REPOSITORY_KEY)
        throw new Error(validation.message ?? 'This folder does not look like the ps repository.')
      }

      this.state.repoPath = path
      this.state.projectValid = true
      if (remember) {
        this.storage?.setItem(LAST_REPOSITORY_KEY, path)
      }
      await this.refreshFiles()
      try {
        await this.backend.watchRepository(path)
      } catch {
        // Losing the watcher only costs live updates, not the repository.
      }
    } catch (error) {
      this.state.projectValid = false
      this.setMessage(errorMessage(error), 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async refreshFiles(): Promise<boolean> {
    if (!this.state.repoPath || !this.state.projectValid) {
      return false
    }
    const repoPath = this.state.repoPath
    const repositoryGeneration = this.repositoryGeneration
    const requestId = ++this.refreshRequestId
    try {
      const files = await this.backend.listProblemFiles(repoPath)
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      const filesByPath = indexProblemFiles(files)
      const missingTabs = this.state.openTabs.filter((tab) => !findIndexedProblemFile(filesByPath, tab.path))
      if (missingTabs.length > 0 && !(await this.flushPendingSave())) {
        return false
      }
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.state.files = files
      this.gitController.markStale()
      for (const tab of this.state.openTabs) {
        const refreshed = findIndexedProblemFile(filesByPath, tab.path)
        if (refreshed) {
          tab.path = refreshed.path
          tab.name = refreshed.name
          tab.packageSegment = refreshed.packageSegment
        }
      }
      if (missingTabs.length > 0) {
        const missingTabIds = new Set(missingTabs.map((tab) => tab.id))
        this.state.openTabs = this.state.openTabs.filter((tab) => !missingTabIds.has(tab.id))
        if (!this.activeOpenTab()) {
          this.resetCurrentFile()
        }
      }
      if (!this.activeOpenTab() && this.state.selectedPath) {
        this.resetCurrentFile()
      }
      return true
    } catch (error) {
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.setMessage(`Could not list problem files: ${errorMessage(error)}`, 'error')
      return false
    } finally {
      this.renderAll()
    }
  }

  private isCurrentRefresh(repoPath: string, repositoryGeneration: number, requestId: number): boolean {
    return isCurrentRepositoryRefresh(
      { repoPath, repositoryGeneration, requestId },
      {
        repoPath: this.state.repoPath,
        projectValid: this.state.projectValid,
        repositoryGeneration: this.repositoryGeneration,
        refreshRequestId: this.refreshRequestId,
      },
    )
  }

  private activeOpenTab(): OpenFileTab | null {
    return this.documentController.activeOpenTab()
  }

  private openTabForPath(path: string): OpenFileTab | null {
    return this.documentController.openTabForPath(path)
  }

  private liveDiagnosticsSnapshot(): LiveDiagnosticsSnapshot | null {
    if (!this.state.repoPath || !this.state.projectValid
      || !this.state.selectedPath || !this.state.selectedFqcn) {
      return null
    }
    return {
      repoPath: this.state.repoPath,
      relativePath: this.state.selectedPath,
      fullyQualifiedClassName: this.state.selectedFqcn,
      source: this.state.selectedSource,
    }
  }

  private scheduleLiveDiagnostics(): void {
    const snapshot = this.liveDiagnosticsSnapshot()
    if (!snapshot) {
      this.liveDiagnostics.cancel()
      this.state.liveDiagnosticsError = null
      return
    }
    const hadError = Boolean(this.state.liveDiagnosticsError)
    this.state.liveDiagnosticsError = null
    this.liveDiagnostics.schedule(snapshot)
    if (hadError) {
      this.renderResult()
    }
  }

  private checkLiveDiagnostics(snapshot: LiveDiagnosticsSnapshot): Promise<readonly ProblemDiagnostic[]> {
    const method = (this.backend as unknown as LiveDiagnosticsBackend).checkProblemDiagnostics
    if (!method) {
      return Promise.reject(new Error('Live diagnostics are not available in this build.'))
    }
    return method(snapshot.repoPath, snapshot.fullyQualifiedClassName, snapshot.source)
  }

  private isCurrentLiveDiagnosticsSnapshot(snapshot: LiveDiagnosticsSnapshot): boolean {
    return snapshot.repoPath === this.state.repoPath
      && snapshot.relativePath === this.state.selectedPath
      && snapshot.fullyQualifiedClassName === this.state.selectedFqcn
      && snapshot.source === this.state.selectedSource
  }

  private applyLiveDiagnostics(
    snapshot: LiveDiagnosticsSnapshot,
    diagnostics: readonly ProblemDiagnostic[],
  ): void {
    if (this.destroyed || !this.isCurrentLiveDiagnosticsSnapshot(snapshot)) {
      return
    }
    this.state.liveDiagnosticsError = null
    const testResultSource = this.testRunController.resultSource
    const testIssues = testResultSource && this.state.testResult
      && this.testRunController.isResultSourceCurrent(testResultSource)
      ? collectEditorIssues(this.state.testResult, snapshot.relativePath)
      : []
    this.editor.setIssues(
      [...testIssues, ...collectDiagnosticEditorIssues(diagnostics, snapshot.relativePath)],
      { reveal: false },
    )
    this.renderResult()
  }

  private handleLiveDiagnosticsError(snapshot: LiveDiagnosticsSnapshot, error: unknown): void {
    if (this.destroyed || !this.isCurrentLiveDiagnosticsSnapshot(snapshot)) {
      return
    }
    // Keep this in the quiet status row rather than a toast: a compiler
    // service failure should be visible without interrupting typing.
    this.state.liveDiagnosticsError = errorMessage(error)
    this.renderResult()
  }

  private openFile(file: ProblemFileEntry): Promise<void> {
    return this.documentController.openFile(file)
  }

  private openTab(tabId: number): Promise<void> {
    return this.documentController.openTab(tabId)
  }

  private closeOpenTab(tabId: number): Promise<void> {
    return this.documentController.closeOpenTab(tabId)
  }

  private removeOpenTab(tabId: number): OpenFileTab | null {
    return this.documentController.removeOpenTab(tabId)
  }

  private closeAllOpenTabs(): Promise<void> {
    return this.documentController.closeAllOpenTabs()
  }

  private setExpandedGroup(
    group: ProblemFileEntry['packageSegment'],
    expanded: boolean,
  ): void {
    this.expandedGroups.clear()
    for (const key of accordionGroupKeys(group, expanded)) {
      this.expandedGroups.add(key)
    }
  }

  private createFileForToday(): Promise<void> {
    return this.fileOperationsController.createFileForToday()
  }

  private onEditorChange(source: string): void {
    this.documentController.onEditorChange(source)
  }

  private resetCurrentFile(): void {
    this.documentController.resetCurrentFile()
  }

  private saveCurrentFile(): Promise<boolean> {
    return this.documentController.saveCurrentFile()
  }

  private flushPendingSave(): Promise<boolean> {
    return this.documentController.flushPendingSave()
  }

  private selectBottomPanelTab(tab: 'tests' | 'git', focus = false): void {
    this.state.bottomPanelTab = tab
    if (tab !== 'git') {
      this.gitController.clearScheduledRefresh()
    }
    this.renderBottomPanelTabs()
    this.renderGitPanel()
    if (tab === 'git') {
      // The workspace has just become measurable; reclamp persisted width
      // against its actual client width instead of the hidden-panel fallback.
      this.paneLayout.applyGitFileListWidth()
    }
    if (focus) {
      this.element<HTMLButtonElement>(tab === 'tests' ? '#tests-tab' : '#git-tab').focus()
    }
    if (tab === 'git' && this.state.repoPath && this.state.projectValid
      && !this.state.busy && !this.state.git.loading) {
      void this.gitController.refreshStatus()
    }
  }

  private renderBottomPanelTabs(): void {
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

  private readonly handleRepositoryFilesChanged = (change: RepositoryFilesChanged): void => {
    if (this.destroyed || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    if (change.structural) {
      void this.refreshFiles()
    }
    const path = this.state.selectedPath
    if (path && change.paths.some((changed) => sameFilePath(changed, path))) {
      void this.reloadOpenFileFromDisk(path)
    }
  }

  /**
   * Adopt an external edit to the file currently open in the editor.
   *
   * A write this application started is already in the buffer, so it reloads
   * to the same text and changes nothing. When the buffer holds edits that
   * have not reached disk the local version wins: silently replacing unsaved
   * work cannot be undone by the user, while a stale buffer can be refreshed.
   */
  private reloadOpenFileFromDisk(path: string): Promise<void> {
    return this.documentController.reloadOpenFileFromDisk(path)
  }

  private handleAppVisibilityReturn(): void {
    if (!this.isWindowVisible() || this.destroyed) {
      return
    }
    this.problemSelectionController.refreshDailyProblemIfStale()
    // Filesystem events can be missed while the window is hidden, so returning
    // to it re-checks the open file the way an IDE syncs on frame activation.
    if (this.state.selectedPath && this.state.projectValid) {
      void this.reloadOpenFileFromDisk(this.state.selectedPath)
    }
    this.gitController.handleVisibilityReturn()
  }

  private isWindowVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  private renderGitPanel(): void {
    renderGitPanelView(
      this.root,
      {
        bottomPanelTab: this.state.bottomPanelTab,
        busy: this.state.busy,
        git: this.state.git,
        operationLabel: this.gitController.progressLabel,
      },
      {
        onToggleFile: (path, selected) => this.gitController.toggleFile(path, selected),
        onSelectFile: (path) => this.gitController.setActiveFile(path),
        onContextMenu: (file, x, y) => this.openGitContextMenu(file, x, y),
      },
    )
    this.paneLayout.applyGitFileListWidth()
    this.renderGitContextMenu()
  }

  /**
   * Commit-bar enablement plus the computed placeholder. Kept separate from
   * renderGitPanel so typing in the message input never rebuilds the panel
   * (a rebuild would fight the caret).
   */
  private updateGitCommitControls(): void {
    updateGitCommitControlsView(this.root, {
      bottomPanelTab: this.state.bottomPanelTab,
      busy: this.state.busy,
      git: this.state.git,
    })
  }

  /** Update controls whose disabled state changes while a file operation runs. */
  private updateBusyControls(): void {
    const busy = this.state.busy
    this.element<HTMLButtonElement>('#choose-repository').disabled = busy || this.repositoryPicker.isOpen
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

  private updateRunButtonState(): void {
    const runButton = this.element<HTMLButtonElement>('#run-test')
    runButton.disabled = this.state.busy || !this.state.selectedFqcn
    const mac = currentIsMacPlatform()
    const runShortcut = shortcutLabel('run-test', mac)
    runButton.setAttribute('aria-label', `Run all tests (${runShortcut})`)
    runButton.title = this.state.selectedFqcn
      ? `Run all tests (${runShortcut})`
      : 'Select a Java problem file to run'
  }

  private updateEditorVisibility(): void {
    this.element<HTMLElement>('#editor-empty').hidden = Boolean(this.state.selectedPath)
    this.element<HTMLElement>('#editor-host').classList.toggle('is-empty', !this.state.selectedPath)
  }

  /** Update active/open explorer state without rebuilding the file list. */
  private updateFileExplorerState(): void {
    for (const { key } of [...FILE_GROUPS, OTHER_GROUP]) {
      const groupList = this.root.querySelector<HTMLElement>(`#file-group-${key}`)
      const section = groupList?.closest<HTMLElement>('.file-group')
      if (!groupList || !section) {
        continue
      }
      const expanded = this.expandedGroups.has(key)
      const expansionChanged = section.dataset.expanded !== String(expanded)
      section.dataset.expanded = String(expanded)
      groupList.hidden = !expanded
      const toggle = section.querySelector<HTMLButtonElement>('.file-group-toggle')
      if (!toggle) {
        continue
      }
      toggle.setAttribute('aria-expanded', String(expanded))
      const icon = toggle.querySelector<SVGElement>('.group-toggle-icon')
      if (icon && expansionChanged) {
        icon.replaceWith(iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'))
      }
    }
    const selectedPath = this.state.selectedPath ?? ''
    this.root.querySelectorAll<HTMLButtonElement>('.file-item').forEach((button) => {
      const path = button.dataset.path ?? ''
      const active = sameFilePath(path, selectedPath)
      button.classList.toggle('is-active', active)
      button.classList.toggle('is-open', this.openTabForPath(path) !== null)
      if (active) {
        button.setAttribute('aria-current', 'page')
      } else {
        button.removeAttribute('aria-current')
      }
    })
    this.scrollActiveFileIntoView()
  }

  private fileTabsModel(): FileTabsViewModel {
    return {
      openTabs: this.state.openTabs,
      activeTabId: this.state.activeTabId,
      dirty: this.state.dirty,
      hasPendingChanges: this.documentController.hasPendingChanges,
      busy: this.state.busy,
    }
  }

  /** Forward the app-owned tab state to the focused tab-strip view. */
  private updateFileTabState(): void {
    this.fileTabsView.update(this.fileTabsModel())
  }

  private renderAll(): void {
    this.paneLayout.apply()
    this.renderHeader()
    this.overlay.render()
    this.renderShortcutLabels()
    this.renderDailyProblem()
    this.renderFiles()
    this.renderFileTabs()
    this.renderFileHeading()
    this.renderResult()
    this.renderBottomPanelTabs()
    this.renderGitPanel()
    this.renderContextMenu()
    this.renderDiscardGitDialog()
    this.renderDeleteFileDialog()
    this.updateBusyControls()
    this.updateEditorVisibility()
    this.gitController.scheduleRefreshIfNeeded()
  }

  private renderHeader(): void {
    const chip = this.element<HTMLButtonElement>('#choose-repository')
    const label = this.element<HTMLElement>('#repo-path')
    chip.setAttribute('aria-busy', String(this.repositoryPicker.isOpen))
    if (this.repositoryPicker.isOpen) {
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

  private renderShortcutLabels(): void {
    const mac = currentIsMacPlatform()
    this.element<HTMLElement>('#run-shortcut').textContent = shortcutLabel('run-test', mac)
    this.element<HTMLElement>('#run-selected-shortcut').textContent =
      shortcutLabel('run-test-at-cursor', mac)
  }

  private renderDailyProblem(): void {
    const problem = this.state.dailyProblem
    this.dailyProblemView({
      problem,
      existingFile: problem ? findTodayProblemFile(this.state.files, problem) : null,
      projectValid: this.state.projectValid,
      busy: this.state.busy,
      dailyLoading: this.state.dailyLoading,
      dailyError: this.state.dailyError,
      problemSelection: this.state.problemSelection,
      problemNumberDraft: this.problemSelectionController.problemNumberDraft,
      viewingToday: problem ? this.problemSelectionController.isViewingTodayProblem(problem) : false,
      dailyDescriptionOpen: this.dailyDescriptionOpen,
    })
  }

  private renderFileTabs(): void {
    this.fileTabsView.render(this.fileTabsModel())
  }

  private renderFiles(): void {
    renderFilesView(
      {
        list: this.element<HTMLElement>('#file-list'),
        searchInput: this.element<HTMLInputElement>('#file-search'),
        totalCount: this.element<HTMLElement>('#file-count'),
      },
      {
        projectValid: this.state.projectValid,
        files: this.state.files,
        selectedPath: this.state.selectedPath,
        fileSearch: this.state.fileSearch,
        expandedGroups: this.expandedGroups,
        busy: this.state.busy,
        isFileOpen: (path) => this.openTabForPath(path) !== null,
      },
      {
        onFileSelect: (file) => {
          void this.openFile(file)
        },
        onGroupToggle: (group, expanded) => {
          this.setExpandedGroup(group, expanded)
          this.renderFiles()
        },
        onFileContextMenu: (file, position) => {
          this.openFileContextMenu(file, position.x, position.y)
        },
        onRendered: () => this.scrollActiveFileIntoView(),
      },
    )
    if (this.state.contextMenu && !this.state.files.some((file) => file.path === this.state.contextMenu?.file.path)) {
      this.state.contextMenu = null
    }
    this.renderContextMenu()
  }

  private openFileContextMenu(file: ProblemFileEntry, x: number, y: number): void {
    if (this.state.busy || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    this.closeGitContextMenu()
    this.state.contextMenu = {
      file,
      x,
      y,
    }
    this.renderContextMenu()
    this.element<HTMLButtonElement>('#duplicate-file-action').focus()
  }

  private closeFileContextMenu(): void {
    if (!this.state.contextMenu) {
      return
    }
    this.state.contextMenu = null
    this.renderContextMenu()
  }

  private openGitContextMenu(file: GitChangedFile, x: number, y: number): void {
    if (this.state.busy || this.state.git.busy || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    this.closeFileContextMenu()
    this.state.gitContextMenu = {
      file,
      x,
      y,
    }
    this.renderGitContextMenu()
    this.element<HTMLButtonElement>('#git-discard-action').focus()
  }

  private closeGitContextMenu(): void {
    if (!this.state.gitContextMenu) {
      return
    }
    this.state.gitContextMenu = null
    this.renderGitContextMenu()
  }

  private findGitFileFocusTarget(path: string): HTMLElement | null {
    const row = Array.from(this.root.querySelectorAll<HTMLElement>('#git-file-list .git-file-row'))
      .find((entry) => entry.title === path)
    return row?.querySelector<HTMLElement>('.git-file-button')
      ?? this.element<HTMLButtonElement>('#git-tab')
  }

  private restoreGitDiscardFocus(target: HTMLElement | null): void {
    if (target && target.isConnected && !target.closest('[hidden]')
      && (!(target instanceof HTMLButtonElement) || !target.disabled)) {
      target.focus()
      return
    }
    this.element<HTMLButtonElement>('#git-tab').focus()
  }

  private async requestApplicationClose(): Promise<void> {
    try {
      if (this.requestClose) {
        await this.requestClose()
      } else if (typeof window !== 'undefined') {
        window.close()
      }
    } catch (error) {
      this.setMessage(`Could not close leetcoder: ${errorMessage(error)}`, 'error')
    }
  }

  private async requestApplicationUpdate(): Promise<void> {
    this.overlay.closeAppMenu(false)
    if (!this.overlay.isUpdateAvailable || this.overlay.isUpdateBusy) {
      return
    }
    try {
      await this.prepareToClose()
    } catch (error) {
      this.setMessage(`Could not prepare update: ${errorMessage(error)}`, 'error')
      return
    }
    await this.updateController.updateAndRestart()
  }

  private openDiscardGitDialog(): void {
    const context = this.state.gitContextMenu
    if (!context || !this.state.repoPath || !this.state.projectValid || this.state.busy || this.state.git.busy) {
      return
    }
    this.gitDiscardDialogFocusTarget = this.findGitFileFocusTarget(context.file.path)
    this.closeGitContextMenu()
    this.gitDiscardDialogFile = context.file
    this.renderDiscardGitDialog()
    queueMicrotask(() => {
      if (this.gitDiscardDialogFile === context.file) {
        this.element<HTMLButtonElement>('#cancel-discard-git').focus()
      }
    })
  }

  private closeDiscardGitDialog(): void {
    if (!this.gitDiscardDialogFile) {
      return
    }
    const focusTarget = this.gitDiscardDialogFocusTarget
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
    this.renderDiscardGitDialog()
    this.restoreGitDiscardFocus(focusTarget)
  }

  private confirmDiscardGitDialog(): void {
    const file = this.gitDiscardDialogFile
    if (!file || this.state.busy || this.state.git.busy) {
      return
    }
    const focusTarget = this.gitDiscardDialogFocusTarget
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
    this.renderDiscardGitDialog()
    void this.discardGitChangesAfterConfirmation(file, focusTarget)
  }

  private renderDiscardGitDialog(): void {
    renderDiscardGitDialogView(this.root, {
      file: this.gitDiscardDialogFile,
      busy: this.state.busy,
      gitBusy: this.state.git.busy,
    })
  }

  private openDeleteFileDialog(): void {
    const context = this.state.contextMenu
    if (!context || !this.state.repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    this.deleteDialogFocusTarget = Array.from(this.root.querySelectorAll<HTMLElement>('.file-item'))
      .find((item) => sameFilePath(item.dataset.path ?? '', context.file.path))
      ?? null
    this.closeFileContextMenu()
    this.deleteDialogFile = context.file
    this.renderDeleteFileDialog()
    queueMicrotask(() => {
      if (this.deleteDialogFile === context.file) {
        this.element<HTMLButtonElement>('#cancel-delete-file').focus()
      }
    })
  }

  private closeDeleteFileDialog(): void {
    if (!this.deleteDialogFile) {
      return
    }
    const focusTarget = this.deleteDialogFocusTarget
    this.deleteDialogFile = null
    this.deleteDialogFocusTarget = null
    this.renderDeleteFileDialog()
    if (focusTarget?.isConnected && !focusTarget.closest('[hidden]')) {
      focusTarget.focus()
    } else {
      this.element<HTMLInputElement>('#file-search').focus()
    }
  }

  private confirmDeleteFileDialog(): void {
    const file = this.deleteDialogFile
    if (!file || this.state.busy) {
      return
    }
    this.deleteDialogFile = null
    this.deleteDialogFocusTarget = null
    this.renderDeleteFileDialog()
    void this.deleteFileAfterConfirmation(file)
  }

  private renderDeleteFileDialog(): void {
    renderDeleteFileDialogView(this.root, {
      file: this.deleteDialogFile,
      busy: this.state.busy,
    })
  }

  private renderContextMenu(): void {
    renderFileContextMenuView(this.root, {
      context: this.state.contextMenu,
      busy: this.state.busy,
    })
  }

  private renderGitContextMenu(): void {
    renderGitContextMenuView(this.root, {
      context: this.state.gitContextMenu,
      files: this.state.git.files,
      busy: this.state.busy,
      gitBusy: this.state.git.busy,
      loading: this.state.git.loading,
    })
  }

  private async showGitFileInManager(): Promise<void> {
    const context = this.state.gitContextMenu
    if (!context || this.state.busy || this.state.git.busy) {
      return
    }
    this.closeGitContextMenu()
    return this.fileOperationsController.showGitFileInManager(context.file.path)
  }

  private async discardGitChangesAfterConfirmation(
    file: GitChangedFile,
    focusTarget: HTMLElement | null,
  ): Promise<void> {
    try {
      await this.fileOperationsController.discardGitChanges(file)
    } finally {
      this.restoreGitDiscardFocus(focusTarget)
    }
  }

  private async deleteFileAfterConfirmation(file: ProblemFileEntry): Promise<void> {
    await this.fileOperationsController.deleteFile(file)
  }

  private async duplicateContextMenuFile(): Promise<void> {
    const context = this.state.contextMenu
    if (!context || this.state.busy) {
      return
    }
    const file = context.file
    this.closeFileContextMenu()
    await this.fileOperationsController.duplicateFile(file)
  }

  private openRenameDialog(): void {
    const context = this.state.contextMenu
    if (!context || this.state.busy) {
      return
    }
    this.renameTargetFile = context.file
    this.closeFileContextMenu()
    const dialog = this.element<HTMLElement>('#rename-file-dialog')
    const input = this.element<HTMLInputElement>('#rename-file-input')
    input.value = context.file.name.replace(/\.java$/i, '')
    dialog.hidden = false
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
  }

  private closeRenameDialog(): void {
    if (!this.renameTargetFile) {
      return
    }
    this.renameTargetFile = null
    this.element<HTMLElement>('#rename-file-dialog').hidden = true
  }

  private async renameDialogFile(): Promise<void> {
    const file = this.renameTargetFile
    const repoPath = this.state.repoPath
    if (!file || !repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const promptedName = this.element<HTMLInputElement>('#rename-file-input').value
    const newName = normalizeJavaFileName(promptedName)
    if (!newName) {
      this.setMessage('Enter a valid Java filename.', 'error')
      this.element<HTMLInputElement>('#rename-file-input').focus()
      return
    }
    if (newName === file.name) {
      this.closeRenameDialog()
      return
    }
    const existingPaths = new Set(this.state.files.map((entry) => entry.path))
    const requestedPath = joinFilePath(gitDirectoryPath(file.path), newName)
    if (existingPaths.has(requestedPath)) {
      this.setMessage(`A file named ${newName} already exists.`, 'error')
      this.element<HTMLInputElement>('#rename-file-input').focus()
      return
    }
    this.closeRenameDialog()
    await this.fileOperationsController.renameFile(file, newName)
  }

  private scrollActiveFileIntoView(): void {
    if (!this.state.selectedPath) {
      return
    }
    const active = Array.from(this.root.querySelectorAll<HTMLElement>('.file-item'))
      .find((item) => item.dataset.path === this.state.selectedPath)
    const groupList = active?.closest<HTMLElement>('.file-group-list')
    if (!active || active.hidden || groupList?.hidden) {
      return
    }
    const scroll = (): void => {
      // Only the expanded group's list scrolls. Centering keeps a file opened
      // from Today or another action in context while the browser naturally
      // clamps the first and last rows to the list bounds.
      active.scrollIntoView?.({ block: 'center' })
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scroll)
    } else {
      queueMicrotask(scroll)
    }
  }

  private revealSelectedFileInExplorer(): void {
    const selected = this.state.files.find((file) => sameFilePath(file.path, this.state.selectedPath ?? ''))
    if (!selected) {
      return
    }
    const groupIsOnlyExpanded = this.expandedGroups.size === 1
      && this.expandedGroups.has(selected.packageSegment)
    if (!groupIsOnlyExpanded) {
      this.setExpandedGroup(selected.packageSegment, true)
      this.renderFiles()
      return
    }
    this.scrollActiveFileIntoView()
  }

  private renderFileHeading(): void {
    renderFileHeadingView(
      {
        selectedFile: this.element<HTMLElement>('#selected-file'),
        saveStatus: this.element<HTMLElement>('#save-status'),
        editorHost: this.element<HTMLElement>('#editor-host'),
      },
      {
        files: this.state.files,
        selectedPath: this.state.selectedPath,
        savedSource: this.state.savedSource,
        saveError: this.state.saveError,
        saveWriteInFlight: this.documentController.saveWriteInFlight,
        dirty: this.state.dirty,
        hasPendingChanges: this.documentController.hasPendingChanges,
        savedFlash: this.documentController.savedFlash,
        saveShortcutLabel: shortcutLabel('save', currentIsMacPlatform()),
      },
    )
  }

  private renderResult(): void {
    const liveRun = this.state.testRun?.status === 'running' ? this.state.testRun : null
    const output = renderTestResults(
      this.root,
      {
        result: this.state.testResult,
        liveRun,
        testMethod: this.state.testRun?.testMethod ?? null,
        selectedTestKey: this.state.selectedTestKey,
        selectedPath: this.state.selectedPath,
        liveDiagnosticsError: this.state.liveDiagnosticsError,
        macPlatform: currentIsMacPlatform(),
      },
      {
        onSelectTest: (key, focus) => this.testRunController.selectTestResult(key, focus),
        onRevealLocation: (line, column) => this.editor.revealLine(line, column),
      },
    )
    this.testRunController.acceptRenderedSelection(output.selectedTestKey)
  }

  private setMessage(message: string, tone: 'info' | 'success' | 'error'): void {
    this.toastController.show(message, tone)
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void
  private listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void
  private listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): void
  private listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void {
    const bound = listener as EventListener
    target.addEventListener(type, bound)
    this.appListeners.push(() => target.removeEventListener(type, bound))
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`Missing editor element: ${selector}`)
    }
    return element
  }
}

async function defaultDirectoryPicker(): Promise<string | null> {
  return tauriInvoke<string | null>('choose_repository')
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function currentIsMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return isMacPlatform(navigator.platform, navigator.userAgent)
}

// Keep the original app module as a compatibility barrel while feature code
// lives under `app/`. New code can import a focused module directly; existing
// callers and tests do not need to change their import paths.
export {
  accordionGroupKeys,
  isCloseAllTabsShortcut,
  isCloseTabShortcut,
  isCurrentRepositoryRefresh,
  isFileTabsShiftWheel,
  RepositoryPickerCoordinator,
  replacementTabIndex,
} from './app/navigation'
export type { TabCloseShortcutEvent } from './app/navigation'
export { AutosaveCoordinator } from './app/autosave'
export {
  autoSelectedTestKey,
  charDiffSegments,
  conciseTestFailureMessage,
  collectDiagnosticEditorIssues,
  collectEditorIssues,
  defaultVisibleTests,
  filterTestDiagnostics,
  firstFailedTestKey,
  isTestRunSourceCurrent,
  liveSnapshotResult,
  presentTestResult,
  relevantTestStackFrames,
  runnerFailureResult,
  summarizeLiveTests,
  testCaseDetailSectionOrder,
  testCaseHasOutput,
  testFailureMessage,
  testOutputSegments,
  testResultBannerMessage,
} from './app/test-results'
export {
  defaultGitCommitMessage,
  gitFileName,
  gitResultToastMessage,
  normalizeGitDiff,
  normalizeGitStatus,
  parseUnifiedDiffLines,
} from './app/git-helpers'
export {
  discardGitChangesConfirmationMessage,
  discardGitChangesWarningMessage,
  deleteFileConfirmationMessage,
  duplicateFileName,
  filterProblemFiles,
  filterProblemFilesByGroup,
  findFileAfterDuplicate,
  findRestoredFileAfterGitRename,
  findTodayProblemFile,
  normalizeJavaFileName,
} from './app/file-helpers'
export {
  gitDirectoryPath,
  fqcnFromJavaPath,
  sourcePathsMatch,
} from './app/path-helpers'
export {
  applyTheme,
  clampBottomPanelHeight,
  clampContextMenuPosition,
  clampDailyDescriptionHeight,
  clampGitFileListWidth,
  clampSidebarWidth,
  defaultShortcutPlatform,
  isMacPlatform,
  macShortcutDialogLabel,
  nextUtcMidnightDelayMs,
  normalizeDailyProblemDateKey,
  normalizeProblemNumber,
  normalizeThemeMode,
  readThemeMode,
  utcDateKey,
} from './app/layout'
export type {
  AppOptions,
  AutosaveCoordinatorOptions,
  AutosaveSnapshot,
  AutosaveStatus,
  CurrentTestSource,
  DirectoryPicker,
  GitChangedFile,
  GitStatusSnapshot,
  RepositoryRefreshRequest,
  RepositoryRefreshState,
  SettingsSection,
  ShortcutPlatform,
  TestResultPresentation,
  TestRunSnapshot,
  TestRunSourceSnapshot,
  TestRunStatus,
  ThemeMode,
} from './app/types'
export type {
  TestCaseDetailSection,
  TestOutputSegment,
  TestOutputStream,
} from './app/test-results'
export type {
  UnifiedDiffLine,
  UnifiedDiffLineKind,
} from './app/git-helpers'

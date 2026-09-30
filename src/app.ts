import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import {
  createBackendClient,
  errorMessage,
  type BackendClient,
  type ProblemFileEntry,
} from './backend'
import {
  findJavaTestMethodAt,
  JavaEditor,
  isShortcutHelpAltShortcut,
} from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'
import {
  isFileSearchShortcut,
  isProjectSearchShortcut,
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
import { clearGitProgressOverlay } from './app/git-progress'
import { LiveDiagnosticsController } from './app/live-diagnostics-controller'

import {
  isCloseAllTabsShortcut,
  isCloseTabShortcut,
} from './app/navigation'
import { createGitState, GitController } from './app/git-controller'
import { createPaneLayoutController, type PaneLayoutController } from './app/pane-layout'
import { ProblemSelectionController } from './app/problem-selection-controller'
import { DocumentController } from './app/document-controller'
import { FileOperationsController } from './app/file-operations-controller'
import { FileDialogController } from './app/file-dialog-controller'
import { RepositoryController } from './app/repository-controller'
import { ProjectContentSearchController } from './app/project-search-controller'
import { PsLibraryController } from './app/ps-library-controller'
import { JavaTypeMembersController } from './app/java-type-members-controller'
import { FileExplorerController } from './app/file-explorer-controller'
import { ShellControlsView } from './app/shell-controls-view'
import {
  createFileTabsView,
  renderFileHeading as renderFileHeadingView,
  type FileTabsView,
  type FileTabsViewModel,
} from './app/tabs-view'
import { TestRunController } from './app/test-run-controller'
import { ToastController } from './app/toast-controller'
import { OverlayController } from './app/overlay-controller'
import {
  renderGitPanel as renderGitPanelView,
} from './app/git-view'
import { findTodayProblemFile } from './app/file-helpers'
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
import { renderShellView } from './app/shell-view'
import { renderTestResults } from './app/results-view'
import {
  createDailyProblemView,
  type DailyProblemViewRenderer,
} from './app/daily-view'
import type {
  AppOptions,
  AppState,
  DirectoryPicker,
  OpenFileTab,
} from './app/types'
const APP_VERSION = '0.1.0'
const DAILY_DESCRIPTION_KEY = 'leetcoder.daily-description'

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly storage: Storage | undefined
  private readonly requestClose: (() => Promise<void>) | undefined
  private readonly updateProgressView = createUpdateProgressView()
  private readonly toastController: ToastController
  private readonly overlay: OverlayController
  private updateController: UpdateController
  private updateProgressListenerStop: (() => void) | null = null
  private updateCheckTimer: ReturnType<typeof setInterval> | null = null
  private updatePollingInstalled = false
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
  private readonly liveDiagnostics: LiveDiagnosticsController
  private readonly psLibraryController: PsLibraryController
  private readonly javaTypeMembersController: JavaTypeMembersController
  private readonly dailyProblemView: DailyProblemViewRenderer
  private readonly problemSelectionController: ProblemSelectionController
  private readonly appListeners: Array<() => void> = []
  private destroyed = false
  private dailyDescriptionOpen = false
  private readonly gitController: GitController
  private readonly paneLayout: PaneLayoutController
  private readonly fileTabsView: FileTabsView
  private readonly testRunController: TestRunController
  private readonly documentController: DocumentController
  private readonly controlsView: ShellControlsView
  private readonly fileExplorer: FileExplorerController
  private readonly repository: RepositoryController
  private readonly fileDialogs: FileDialogController
  private readonly fileOperationsController: FileOperationsController
  private readonly projectContentSearchController: ProjectContentSearchController
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (this.gitController.commitPushInProgress) {
      event.preventDefault()
      return
    }
    const editorTarget = event.target instanceof Node && this.element('#editor').contains(event.target)
    if (isProjectSearchShortcut(event, currentIsMacPlatform())) {
      event.preventDefault()
      this.fileExplorer.focusFileSearch()
      return
    }
    if (isFileSearchShortcut(event, currentIsMacPlatform())) {
      event.preventDefault()
      this.fileExplorer.focusFileSearch()
      return
    }
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
    this.fileExplorer.revealSelectedFileInExplorer()
  }

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.gitController.clearScheduledRefresh()
      this.problemSelectionController.clearScheduledRefresh()
      this.pauseUpdatePolling()
      return
    }
    this.handleAppVisibilityReturn()
  }

  private readonly handleContextMenuOutside = (event: PointerEvent): void => {
    if (this.gitController.commitPushInProgress) {
      event.preventDefault()
      return
    }
    this.overlay.handleOutsidePointerDown(event)
    this.fileDialogs.handleOutsidePointerDown(event)
  }

  private readonly handleContextMenuKeydown = (event: KeyboardEvent): void => {
    if (this.gitController.commitPushInProgress) {
      event.preventDefault()
      return
    }
    if (this.overlay.handleEscape(event)) {
      return
    }
    this.fileDialogs.handleEscape(event)
  }

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.root = root
    this.backend = options.backend ?? createBackendClient()
    this.storage = options.storage ?? safeStorage()
    this.requestClose = options.requestClose
    this.dailyDescriptionOpen = this.storage?.getItem(DAILY_DESCRIPTION_KEY) === 'open'
    this.gitController = new GitController(this.backend, {
      getContext: () => ({
        repoPath: this.state.repoPath,
        projectValid: this.state.projectValid,
        repositoryGeneration: this.repository.generation,
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
    this.liveDiagnostics = new LiveDiagnosticsController({
      state: this.state,
      backend: this.backend,
      testRun: () => this.testRunController,
      setEditorIssues: (issues, options) => this.editor.setIssues(issues, options),
      renderResult: () => this.renderResult(),
      isActive: () => this.isAppActive(),
    })
    this.testRunController = new TestRunController({
      state: this.state,
      runProblemTest: this.backend.runProblemTest.bind(this.backend),
      stopProblemTest: this.backend.stopProblemTest.bind(this.backend),
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
    this.javaTypeMembersController = new JavaTypeMembersController({ backend: this.backend })
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
      onFocusFileSearch: () => {
        this.fileExplorer.focusFileSearch()
      },
      onSearchProject: () => {
        this.fileExplorer.focusFileSearch()
      },
      onRefactorError: (message) => this.setMessage(message, 'error'),
      requestJavaTypeMembers: typeof this.backend.inspectJavaTypeMembers === 'function'
        ? (typeNames) => this.javaTypeMembersController.inspect(typeNames)
        : undefined,
      onRunTestAtCursor: (methodName) => {
        // A cursor miss falls back to the same all-tests run as Ctrl+R. This
        // keeps the editor keymap and the window-level shortcut consistent.
        void this.testRunController.runCurrentTest(methodName ?? undefined)
        return true
      },
    })
    this.psLibraryController = new PsLibraryController({
      backend: this.backend,
      setMetadata: (metadata) => this.editor.setPsLibraryMetadata(metadata),
      setMessage: (message, tone) => this.setMessage(message, tone),
    })
    this.documentController = new DocumentController({
      state: this.state,
      backend: this.backend,
      editor: this.editor,
      getRepositoryGeneration: () => this.repository.generation,
      resetTestState: () => this.testRunController.resetTestState(),
      cancelCurrentRun: () => this.testRunController.cancelCurrentRun(),
      renderAll: () => this.renderAll(),
      renderFileHeading: () => this.renderFileHeading(),
      renderFileTabs: () => this.renderFileTabs(),
      updateFileTabState: () => this.updateFileTabState(),
      updateFileExplorerState: () => this.fileExplorer.updateFileExplorerState(),
      updateEditorVisibility: () => this.controlsView.updateEditorVisibility(),
      renderResult: () => this.renderResult(),
      setExpandedGroup: (group, expanded) => this.fileExplorer.setExpandedGroup(group, expanded),
      scheduleLiveDiagnostics: () => this.liveDiagnostics.scheduleLiveDiagnostics(),
      markGitStale: () => this.gitController.markStale(),
      setSavedSource: (source) => {
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      },
      setMessage: (message, tone) => this.setMessage(message, tone),
      renderBusyControls: () => this.controlsView.updateBusyControls(),
      revealSelectedFileInExplorer: () => this.fileExplorer.revealSelectedFileInExplorer(),
      isDestroyed: () => this.destroyed,
    })
    this.fileOperationsController = new FileOperationsController({
      state: this.state,
      backend: this.backend,
      document: this.documentController,
      git: this.gitController,
      createProblem: (repoPath, problem) => createProblemWithRetry(this.backend, repoPath, problem),
      refreshFiles: () => this.repository.refreshFiles(),
      repositoryGeneration: () => this.repository.generation,
      getGitFiles: () => this.state.git.files,
      setAppBusy: (busy) => {
        this.state.busy = busy
      },
      render: () => this.renderAll(),
      setMessage: (message, tone) => this.setMessage(message, tone),
      isDestroyed: () => this.destroyed,
    })
    this.fileDialogs = new FileDialogController({
      root: this.root,
      state: this.state,
      operations: this.fileOperationsController,
      setMessage: (message, tone) => this.setMessage(message, tone),
    })
    this.projectContentSearchController = new ProjectContentSearchController({
      host: this.element<HTMLElement>('#project-content-search-results'),
      backend: this.backend,
      getRepositoryPath: () => this.state.projectValid && !this.state.busy ? this.state.repoPath : null,
      beforeSearch: () => this.documentController.flushPendingSave(),
      canNavigate: (match) => this.fileExplorer.canNavigateProjectSearchMatch(match),
      onNavigate: (match, query) => this.fileExplorer.navigateToProjectSearchMatch(match, query),
    })
    this.fileExplorer = new FileExplorerController({
      root: this.root,
      state: this.state,
      document: this.documentController,
      dialogs: this.fileDialogs,
      search: this.projectContentSearchController,
      repositoryGeneration: () => this.repository.generation,
      isActive: () => this.isAppActive(),
      revealLine: (line, column) => this.editor.revealLine(line, column),
    })
    this.repository = new RepositoryController({
      state: this.state,
      backend: this.backend,
      directoryPicker: options.directoryPicker ?? defaultDirectoryPicker,
      storage: this.storage,
      document: this.documentController,
      git: this.gitController,
      dialogs: this.fileDialogs,
      search: this.projectContentSearchController,
      psLibrary: this.psLibraryController,
      javaTypes: this.javaTypeMembersController,
      isActive: () => this.isAppActive(),
      render: () => this.renderAll(),
      setMessage: (message, tone) => this.setMessage(message, tone),
    })
    this.controlsView = new ShellControlsView({
      root: this.root,
      state: this.state,
      pickerOpen: () => this.repository.pickerOpen,
      macPlatform: currentIsMacPlatform,
      invalidatePendingNavigation: () => this.documentController.invalidatePendingNavigation(),
    })
    this.bindEvents()
    this.renderAll()
  }

  async start(): Promise<void> {
    this.updateProgressListenerStop = await listenForUpdateProgress((payload) => {
      this.updateProgressView.update(payload)
    })
    await this.repository.installWatcher()
    // Daily problem loading uses the network and can take considerably longer
    // than local repository setup. Start both operations together so a
    // remembered repository is usable while the daily card is still loading,
    // while keeping start()'s completion contract intact.
    const dailyProblemLoad = this.problemSelectionController.loadDailyProblem()
    const rememberedPath = this.repository.rememberedPath
    let repositoryLoad: Promise<void> = Promise.resolve()
    if (rememberedPath) {
      repositoryLoad = this.repository.selectRepository(rememberedPath, false)
    } else {
      this.setMessage('Choose a repository to get started.', 'info')
    }
    await Promise.all([dailyProblemLoad, repositoryLoad])
    this.installUpdatePolling()
  }

  private installUpdatePolling(): void {
    this.updatePollingInstalled = true
    this.pauseUpdatePolling()
    if (!this.isWindowVisible() || !this.isAppActive()) {
      return
    }
    void this.updateController.checkForUpdate()
    this.updateCheckTimer = setInterval(() => {
      void this.updateController.checkForUpdate()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  private pauseUpdatePolling(): void {
    if (this.updateCheckTimer === null) {
      return
    }
    clearInterval(this.updateCheckTimer)
    this.updateCheckTimer = null
  }

  async prepareToClose(): Promise<void> {
    await this.documentController.prepareToClose()
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    await this.prepareToClose()
    this.destroyed = true
    this.projectContentSearchController.dispose()
    this.psLibraryController.dispose()
    this.javaTypeMembersController.dispose()
    this.fileOperationsController.dispose()
    this.testRunController.dispose()
    this.liveDiagnostics.dispose()
    this.gitController.dispose()
    clearGitProgressOverlay(this.root)
    this.documentController.dispose()
    this.fileTabsView.dispose()
    this.paneLayout.destroy()
    this.editor.destroy()
    this.fileDialogs.dispose()
    for (const remove of this.appListeners.splice(0)) {
      remove()
    }
    this.problemSelectionController.dispose()
    this.pauseUpdatePolling()
    this.updateProgressListenerStop?.()
    this.updateProgressListenerStop = null
    this.updateProgressView.fail()
    this.toastController.dispose()
    this.overlay.dispose()
    this.repository.dispose()
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
      void this.repository.chooseRepository()
    })
    this.listen(this.element<HTMLButtonElement>('#refresh-files'), 'click', () => {
      if (!this.state.busy) {
        void this.repository.refreshFiles()
      }
    })
    this.listen(this.element<HTMLElement>('#editor-host'), 'focusin', this.handleEditorFocus)
    this.listen(this.element<HTMLInputElement>('#file-search'), 'input', (event) => {
      this.fileDialogs.closeFileContextMenu()
      this.state.fileSearch = (event.target as HTMLInputElement).value
      this.fileExplorer.renderFiles()
    })
    this.listen(this.element<HTMLInputElement>('#file-search'), 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        const input = event.currentTarget as HTMLInputElement
        if (input.value.length > 0 || this.state.fileSearch.length > 0) {
          input.value = ''
          this.state.fileSearch = ''
          this.fileExplorer.renderFiles()
        }
      }
    })
    this.listen(this.element<HTMLButtonElement>('#run-test'), 'click', () => {
      if (this.state.testRun?.status === 'running') {
        void this.testRunController.stopCurrentRun()
      } else {
        void this.testRunController.runCurrentTest()
      }
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
      this.controlsView.updateGitCommitControls()
    })
    this.listen(this.element<HTMLButtonElement>('#git-commit'), 'click', () => {
      void this.gitController.commitSelectedFiles(false)
    })
    this.listen(this.element<HTMLButtonElement>('#git-commit-push'), 'click', () => {
      void this.gitController.commitSelectedFiles(true)
    })
    this.fileDialogs.bindEvents()
    this.listen(window, 'pointerdown', this.handleContextMenuOutside)
    this.listen(window, 'keydown', this.handleContextMenuKeydown)
    this.listen(window, 'keydown', this.handleGlobalKeydown)
    this.listen(window, 'focus', this.handleWindowFocus)
    this.listen(document, 'visibilitychange', this.handleVisibilityChange)
  }

  private isAppActive(): boolean {
    return !this.destroyed
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

  private closeAllOpenTabs(): Promise<void> {
    return this.documentController.closeAllOpenTabs()
  }

  private createFileForToday(): Promise<void> {
    return this.fileOperationsController.createFileForToday()
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
    this.controlsView.renderBottomPanelTabs()
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
    if (!this.isWindowVisible() || !this.isAppActive()) {
      return
    }
    if (this.updatePollingInstalled && this.updateCheckTimer === null) {
      this.installUpdatePolling()
    }
    this.problemSelectionController.refreshDailyProblemIfStale()
    this.psLibraryController.revalidateIfStale()
    this.javaTypeMembersController.revalidateIfStale()
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
        commitPushInProgress: this.gitController.commitPushInProgress,
      },
      {
        onToggleFile: (path, selected) => this.gitController.toggleFile(path, selected),
        onSelectFile: (path) => this.gitController.setActiveFile(path),
        onContextMenu: (file, x, y) => this.fileDialogs.openGitContextMenu(file, x, y),
      },
    )
    this.paneLayout.applyGitFileListWidth()
    this.fileDialogs.renderGitContextMenu()
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
    this.controlsView.renderHeader()
    this.overlay.render()
    this.controlsView.renderShortcutLabels()
    this.renderDailyProblem()
    this.fileExplorer.renderFiles()
    this.renderFileTabs()
    this.renderFileHeading()
    this.renderResult()
    this.controlsView.renderBottomPanelTabs()
    this.renderGitPanel()
    this.fileDialogs.renderContextMenu()
    this.fileDialogs.renderDiscardGitDialog()
    this.fileDialogs.renderDeleteFileDialog()
    this.controlsView.updateBusyControls()
    this.controlsView.updateEditorVisibility()
    this.gitController.scheduleRefreshIfNeeded()
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

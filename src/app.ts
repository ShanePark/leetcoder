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

import { AutosaveCoordinator } from './app/autosave'
import {
  accordionGroupKeys,
  isCloseAllTabsShortcut,
  isCloseTabShortcut,
  isCurrentRepositoryRefresh,
  RepositoryPickerCoordinator,
  replacementTabIndex,
} from './app/navigation'
import {
  collectDiagnosticEditorIssues,
  collectEditorIssues,
} from './app/test-results'
import {
  gitFileName,
  isGitNewFile,
} from './app/git-helpers'
import { createGitState, GitController } from './app/git-controller'
import { createPaneLayoutController, type PaneLayoutController } from './app/pane-layout'
import { ProblemSelectionController } from './app/problem-selection-controller'
import {
  createFileTabsView,
  renderFileHeading as renderFileHeadingView,
  type FileTabsView,
  type FileTabsViewModel,
} from './app/tabs-view'
import { TestRunController } from './app/test-run-controller'
import { findIndexedProblemFile, indexProblemFiles } from './app/file-index'
import {
  renderGitPanel as renderGitPanelView,
  updateGitCommitControls as updateGitCommitControlsView,
} from './app/git-view'
import {
  findFileAfterDuplicate,
  findFileAfterRename,
  findRestoredFileAfterGitRename,
  findTodayProblemFile,
  joinFilePath,
  fileMutationResultPath,
  normalizeJavaFileName,
} from './app/file-helpers'
import {
  fqcnFromJavaPath,
  gitDirectoryPath,
  sameFilePath,
} from './app/path-helpers'
import {
  applyTheme,
  DEFAULT_GIT_FILE_LIST_WIDTH,
  MAX_BOTTOM_PANEL_HEIGHT,
  MAX_DAILY_DESCRIPTION_HEIGHT,
  MAX_SIDEBAR_WIDTH,
  MIN_BOTTOM_PANEL_HEIGHT,
  MIN_DAILY_DESCRIPTION_HEIGHT,
  MIN_GIT_DIFF_WIDTH,
  MIN_GIT_FILE_LIST_WIDTH,
  MIN_SIDEBAR_WIDTH,
  THEME_MODE_KEY,
  normalizeThemeMode,
  readThemeMode,
  defaultShortcutPlatform,
  isMacPlatform,
} from './app/layout'
import {
  renderAboutDialog as renderAboutDialogView,
  renderAppMenu as renderAppMenuView,
  renderDeleteFileDialog as renderDeleteFileDialogView,
  renderDiscardGitDialog as renderDiscardGitDialogView,
  renderFileContextMenu as renderFileContextMenuView,
  renderGitContextMenu as renderGitContextMenuView,
  renderSettingsDialog as renderSettingsDialogView,
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
  AutosaveSnapshot,
  DirectoryPicker,
  FileManagementBackend,
  GitChangedFile,
  LiveDiagnosticsBackend,
  OpenFileTab,
  SettingsSection,
  ShortcutPlatform,
  ThemeMode,
} from './app/types'
const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const APP_VERSION = '0.1.0'
const DAILY_DESCRIPTION_KEY = 'leetcoder.daily-description'
const SAVED_FLASH_MS = 1500
const TOAST_DISMISS_MS = 3000
const MAX_VISIBLE_TOASTS = 3

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly repositoryPicker = new RepositoryPickerCoordinator()
  private readonly storage: Storage | undefined
  private readonly requestClose: (() => Promise<void>) | undefined
  private readonly updateProgressView = createUpdateProgressView()
  private updateController: UpdateController
  private updateProgressListenerStop: (() => void) | null = null
  private updateCheckTimer: ReturnType<typeof setInterval> | null = null
  private themeMode: ThemeMode
  private appMenuOpen = false
  private appMenuFocusTarget: HTMLElement | null = null
  private settingsDialogOpen = false
  private settingsDialogFocusTarget: HTMLElement | null = null
  private settingsSection: SettingsSection = 'appearance'
  private aboutDialogOpen = false
  private aboutDialogFocusTarget: HTMLElement | null = null
  private updateAvailable = false
  private updateBusy = false
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
  private readonly autosave: AutosaveCoordinator
  private readonly liveDiagnostics: LiveDiagnosticsScheduler
  private readonly dailyProblemView: DailyProblemViewRenderer
  private readonly problemSelectionController: ProblemSelectionController
  private suppressEditorChange = false
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private externalReloadInFlight = false
  private stopWatchingFiles: (() => void) | null = null
  private shortcutsPlatform: ShortcutPlatform = defaultShortcutPlatform(currentIsMacPlatform())
  private nextOpenTabId = 1
  private closePreparation: Promise<void> | null = null
  private destroyed = false
  private fileOperationId = 0
  private fileOpenInProgress = false
  private saveWriteInFlight = false
  private savedFlash = false
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null
  private dailyDescriptionOpen = false
  private gitDiscardInProgress = false
  private gitDiscardDialogFile: GitChangedFile | null = null
  private gitDiscardDialogFocusTarget: HTMLElement | null = null
  private deleteDialogFile: ProblemFileEntry | null = null
  private deleteDialogFocusTarget: HTMLElement | null = null
  private renameTargetFile: ProblemFileEntry | null = null
  private errorToastElement: HTMLElement | null = null
  private readonly gitController: GitController
  private readonly paneLayout: PaneLayoutController
  private readonly fileTabsView: FileTabsView
  private readonly testRunController: TestRunController
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    accordionGroupKeys('easy', true),
  )
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isSettingsShortcut(event, currentIsMacPlatform())) {
      event.preventDefault()
      this.openSettingsDialog('appearance')
      return
    }
    if (isShortcutHelpAltShortcut(event)) {
      // The keymap has to be reachable from anywhere, including the file
      // explorer and the run panel.
      event.preventDefault()
      this.openSettingsDialog('keymap')
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

  private readonly handleAppMenuKeydown = (event: KeyboardEvent): void => {
    if (!this.appMenuOpen) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.closeAppMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }
    const items = Array.from(this.element<HTMLElement>('#app-menu')
      .querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .filter((item) => !item.hidden && !item.disabled)
    if (items.length === 0) {
      return
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : Math.max(0, Math.min(
          items.length - 1,
          currentIndex + (event.key === 'ArrowDown' ? 1 : -1),
        ))
    event.preventDefault()
    items[nextIndex]?.focus()
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
    const appMenu = this.root.querySelector<HTMLElement>('#app-menu')
    const appMenuButton = this.root.querySelector<HTMLElement>('#app-menu-button')
    const fileMenu = this.root.querySelector<HTMLElement>('#file-context-menu')
    const gitMenu = this.root.querySelector<HTMLElement>('#git-context-menu')
    const target = event.target instanceof Node ? event.target : null
    const insideAppMenu = Boolean(appMenu && !appMenu.hidden && target && appMenu.contains(target))
    const insideAppMenuButton = Boolean(appMenuButton && target && appMenuButton.contains(target))
    const insideFileMenu = Boolean(fileMenu && !fileMenu.hidden && target && fileMenu.contains(target))
    const insideGitMenu = Boolean(gitMenu && !gitMenu.hidden && target && gitMenu.contains(target))
    if (!insideAppMenu && !insideAppMenuButton) {
      this.closeAppMenu()
    }
    if (!insideFileMenu && !insideGitMenu) {
      this.closeFileContextMenu()
      this.closeGitContextMenu()
    }
  }

  private readonly handleContextMenuKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return
    }
    if (this.settingsDialogOpen) {
      event.preventDefault()
      this.closeSettingsDialog()
    } else if (this.aboutDialogOpen) {
      event.preventDefault()
      this.closeAboutDialog()
    } else if (this.appMenuOpen) {
      event.preventDefault()
      this.closeAppMenu()
    } else if (this.gitDiscardDialogFile) {
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
    this.themeMode = readThemeMode(this.storage)
    applyTheme(this.themeMode)
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
          this.updateAvailable = available
          const button = this.root.querySelector<HTMLButtonElement>('#update-button')
          if (button) button.hidden = !available
          this.renderAppMenu()
        },
        setUpdateBusy: (busy) => {
          this.updateBusy = busy
          const button = this.root.querySelector<HTMLButtonElement>('#update-button')
          if (button) {
            button.disabled = busy
            button.classList.toggle('is-spinning', busy)
            button.setAttribute('aria-busy', String(busy))
            button.setAttribute('aria-label', busy ? 'Updating leetcoder' : 'Update leetcoder')
            button.title = busy ? 'Updating leetcoder — building and restarting' : 'Update available — build and restart'
          }
          this.renderAppMenu()
        },
        showUpdateStarted: () => this.updateProgressView.start(),
        showError: (message) => {
          this.updateProgressView.fail()
          this.setMessage(`Update failed: ${message}`, 'error')
        },
      },
    )
    this.autosave = new AutosaveCoordinator(
      (snapshot) => this.persistSnapshot(snapshot),
      {
        onStatusChange: () => {
          if (this.root.querySelector('#save-status')) {
            this.renderFileHeading()
          }
        },
        onError: (error) => this.handleSaveError(error),
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
      onChange: (source) => this.onEditorChange(source),
      onSave: () => {
        void this.saveCurrentFile()
        return true
      },
      onRun: () => {
        void this.testRunController.runCurrentTest()
        return true
      },
      onShowShortcuts: () => {
        this.openSettingsDialog('keymap')
      },
      onShowSettings: () => {
        this.openSettingsDialog('appearance')
      },
      onRefactorError: (message) => this.setMessage(message, 'error'),
      onRunTestAtCursor: (methodName) => {
        // A cursor miss falls back to the same all-tests run as Ctrl+R. This
        // keeps the editor keymap and the window-level shortcut consistent.
        void this.testRunController.runCurrentTest(methodName ?? undefined)
        return true
      },
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
    if (this.closePreparation) {
      return this.closePreparation
    }
    const preparation = (async (): Promise<void> => {
      try {
        await this.autosave.flush()
      } catch (error) {
        this.handleSaveError(error)
        throw error
      }
    })()
    this.closePreparation = preparation
    try {
      await preparation
    } finally {
      if (this.closePreparation === preparation) {
        this.closePreparation = null
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    await this.prepareToClose()
    this.testRunController.dispose()
    this.liveDiagnostics.dispose()
    this.gitController.dispose()
    this.fileTabsView.dispose()
    this.paneLayout.destroy()
    this.editor.destroy()
    this.autosave.dispose()
    this.element<HTMLElement>('#editor-host').removeEventListener('focusin', this.handleEditorFocus)
    window.removeEventListener('keydown', this.handleGlobalKeydown)
    window.removeEventListener('focus', this.handleWindowFocus)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('pointerdown', this.handleContextMenuOutside)
    window.removeEventListener('keydown', this.handleContextMenuKeydown)
    this.problemSelectionController.dispose()
    if (this.updateCheckTimer !== null) {
      clearInterval(this.updateCheckTimer)
      this.updateCheckTimer = null
    }
    this.updateProgressListenerStop?.()
    this.updateProgressListenerStop = null
    this.updateProgressView.fail()
    this.clearSavedFlash()
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
    this.element<HTMLButtonElement>('#app-menu-button').addEventListener('click', () => {
      this.toggleAppMenu()
    })
    this.element<HTMLElement>('#app-menu').addEventListener('keydown', this.handleAppMenuKeydown)
    this.element<HTMLButtonElement>('#update-menu-action').addEventListener('click', () => {
      void this.requestApplicationUpdate()
    })
    this.element<HTMLButtonElement>('#settings-menu-action').addEventListener('click', () => {
      this.closeAppMenu(false)
      this.openSettingsDialog('appearance')
    })
    this.element<HTMLButtonElement>('#about-menu-action').addEventListener('click', () => {
      this.closeAppMenu(false)
      this.openAboutDialog()
    })
    this.element<HTMLButtonElement>('#exit-menu-action').addEventListener('click', () => {
      this.closeAppMenu(false)
      void this.requestApplicationClose()
    })
    this.element<HTMLButtonElement>('#update-button').addEventListener('click', () => {
      void this.requestApplicationUpdate()
    })
    this.element<HTMLButtonElement>('#choose-repository').addEventListener('click', () => {
      void this.chooseRepository()
    })
    this.element<HTMLButtonElement>('#refresh-files').addEventListener('click', () => {
      if (!this.state.busy) {
        void this.refreshFiles()
      }
    })
    this.element<HTMLElement>('#editor-host').addEventListener('focusin', this.handleEditorFocus)
    this.element<HTMLInputElement>('#file-search').addEventListener('input', (event) => {
      this.closeFileContextMenu()
      this.state.fileSearch = (event.target as HTMLInputElement).value
      this.renderFiles()
    })
    this.element<HTMLInputElement>('#file-search').addEventListener('keydown', (event) => {
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
    this.element<HTMLButtonElement>('#run-test').addEventListener('click', () => {
      void this.testRunController.runCurrentTest()
    })
    this.element<HTMLButtonElement>('#tests-tab').addEventListener('click', () => {
      this.selectBottomPanelTab('tests')
    })
    this.element<HTMLButtonElement>('#git-tab').addEventListener('click', () => {
      this.selectBottomPanelTab('git')
    })
    for (const tab of [
      this.element<HTMLButtonElement>('#tests-tab'),
      this.element<HTMLButtonElement>('#git-tab'),
    ]) {
      tab.addEventListener('keydown', (event) => {
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
    this.element<HTMLButtonElement>('#git-select-all').addEventListener('click', () => {
      this.gitController.selectAllFiles()
    })
    this.element<HTMLButtonElement>('#git-select-none').addEventListener('click', () => {
      this.gitController.selectNoFiles()
    })
    this.element<HTMLInputElement>('#git-commit-message').addEventListener('input', (event) => {
      // Typing must not re-render the panel — a rerender would fight the
      // caret. Only the commit-control enablement updates directly.
      this.state.git.commitMessage = (event.target as HTMLInputElement).value
      this.state.git.commitMessageEdited = this.state.git.commitMessage.trim().length > 0
      this.updateGitCommitControls()
    })
    this.element<HTMLButtonElement>('#git-commit').addEventListener('click', () => {
      void this.gitController.commitSelectedFiles(false)
    })
    this.element<HTMLButtonElement>('#git-commit-push').addEventListener('click', () => {
      void this.gitController.commitSelectedFiles(true)
    })
    this.element<HTMLButtonElement>('#delete-file-action').addEventListener('click', () => {
      this.openDeleteFileDialog()
    })
    this.element<HTMLButtonElement>('#git-discard-action').addEventListener('click', () => {
      this.openDiscardGitDialog()
    })
    this.element<HTMLButtonElement>('#git-show-file-action').addEventListener('click', () => {
      void this.showGitFileInManager()
    })
    this.element<HTMLButtonElement>('#duplicate-file-action').addEventListener('click', () => {
      void this.duplicateContextMenuFile()
    })
    this.element<HTMLButtonElement>('#rename-file-action').addEventListener('click', () => {
      this.openRenameDialog()
    })
    this.element<HTMLFormElement>('#rename-file-form').addEventListener('submit', (event) => {
      event.preventDefault()
      void this.renameDialogFile()
    })
    this.element<HTMLButtonElement>('#cancel-rename-file').addEventListener('click', () => {
      this.closeRenameDialog()
    })
    this.element<HTMLElement>('#rename-file-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeRenameDialog()
      }
    })
    this.element<HTMLFormElement>('#discard-git-form').addEventListener('submit', (event) => {
      event.preventDefault()
      this.confirmDiscardGitDialog()
    })
    this.element<HTMLButtonElement>('#cancel-discard-git').addEventListener('click', () => {
      this.closeDiscardGitDialog()
    })
    const shortcutPlatformTabs = [
      this.element<HTMLButtonElement>('#shortcuts-linux-tab'),
      this.element<HTMLButtonElement>('#shortcuts-macos-tab'),
    ]
    for (const tab of shortcutPlatformTabs) {
      tab.addEventListener('click', () => {
        this.setShortcutsPlatform(tab.id === 'shortcuts-macos-tab' ? 'macos' : 'linux')
      })
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          return
        }
        event.preventDefault()
        const platform: ShortcutPlatform = event.key === 'Home' || event.key === 'ArrowLeft'
          ? 'linux'
          : 'macos'
        this.setShortcutsPlatform(platform, true)
      })
    }
    for (const [section, id] of [
      ['appearance', '#settings-appearance-nav'],
      ['keymap', '#settings-keymap-nav'],
    ] as const) {
      this.element<HTMLButtonElement>(id).addEventListener('click', () => {
        this.setSettingsSection(section)
      })
    }
    const settingsNavItems = [
      this.element<HTMLButtonElement>('#settings-appearance-nav'),
      this.element<HTMLButtonElement>('#settings-keymap-nav'),
    ]
    for (const tab of settingsNavItems) {
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          return
        }
        event.preventDefault()
        const section: SettingsSection = event.key === 'Home'
          || event.key === 'ArrowUp'
          || event.key === 'ArrowLeft'
          ? 'appearance'
          : 'keymap'
        this.setSettingsSection(section, true)
      })
    }
    this.element<HTMLButtonElement>('#close-settings').addEventListener('click', () => {
      this.closeSettingsDialog()
    })
    this.element<HTMLElement>('#settings-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeSettingsDialog()
      }
    })
    this.element<HTMLFormElement>('#settings-form').addEventListener('change', (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.name !== 'theme-mode' || !target.checked) {
        return
      }
      this.setThemeMode(target.value)
    })
    this.element<HTMLButtonElement>('#close-about').addEventListener('click', () => {
      this.closeAboutDialog()
    })
    this.element<HTMLElement>('#about-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeAboutDialog()
      }
    })
    this.element<HTMLElement>('#discard-git-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDiscardGitDialog()
      }
    })
    this.element<HTMLFormElement>('#delete-file-form').addEventListener('submit', (event) => {
      event.preventDefault()
      this.confirmDeleteFileDialog()
    })
    this.element<HTMLButtonElement>('#cancel-delete-file').addEventListener('click', () => {
      this.closeDeleteFileDialog()
    })
    this.element<HTMLElement>('#delete-file-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDeleteFileDialog()
      }
    })
    window.addEventListener('pointerdown', this.handleContextMenuOutside)
    window.addEventListener('keydown', this.handleContextMenuKeydown)
    window.addEventListener('keydown', this.handleGlobalKeydown)
    window.addEventListener('focus', this.handleWindowFocus)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
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
    if (this.state.activeTabId === null) {
      return null
    }
    return this.state.openTabs.find((tab) => tab.id === this.state.activeTabId) ?? null
  }

  private openTabForPath(path: string): OpenFileTab | null {
    return this.state.openTabs.find((tab) => sameFilePath(tab.path, path)) ?? null
  }

  private createOpenTab(file: ProblemFileEntry): OpenFileTab {
    return {
      id: this.nextOpenTabId++,
      path: file.path,
      name: file.name,
      packageSegment: file.packageSegment,
    }
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

  private async openFile(file: ProblemFileEntry): Promise<void> {
    if (!this.state.repoPath || this.fileOpenInProgress) {
      return
    }
    const existing = this.openTabForPath(file.path)
    if (existing && existing.id === this.state.activeTabId && sameFilePath(file.path, this.state.selectedPath ?? '')) {
      this.revealSelectedFileInExplorer()
      this.editor.focus()
      return
    }

    const ownsBusy = !this.state.busy
    const repoPath = this.state.repoPath
    const repositoryGeneration = this.repositoryGeneration
    if (ownsBusy) {
      this.fileOpenInProgress = true
      this.state.busy = true
    }
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const source = await this.backend.readProblemFile(repoPath, file.path)
      if (this.state.repoPath !== repoPath || this.repositoryGeneration !== repositoryGeneration) {
        return
      }
      const tabMetadataChanged = Boolean(existing && (
        existing.path !== file.path
        || existing.name !== file.name
        || existing.packageSegment !== file.packageSegment
      ))
      const tab = existing ?? this.createOpenTab(file)
      tab.path = file.path
      tab.name = file.name
      tab.packageSegment = file.packageSegment
      if (!existing) {
        this.state.openTabs.push(tab)
      }
      this.state.activeTabId = tab.id
      this.testRunController.resetTestState()
      this.state.selectedPath = file.path
      this.state.selectedSource = source
      this.state.savedSource = source
      this.state.selectedFqcn = fqcnFromJavaPath(file.path)
      this.state.dirty = false
      this.state.saveError = null
      this.clearSavedFlash()
      this.suppressEditorChange = true
      try {
        this.editor.setValue(source)
      } finally {
        this.suppressEditorChange = false
      }
      // Opening a file reveals only its group; the accordion closes the other
      // groups so the selected row has the full available viewport.
      this.setExpandedGroup(file.packageSegment, true)
      this.renderFileHeading()
      this.renderResult()
      this.updateFileExplorerState()
      if (!existing || tabMetadataChanged) {
        this.renderFileTabs()
      } else {
        this.updateFileTabState()
      }
      this.updateEditorVisibility()
      this.editor.focus()
      this.scheduleLiveDiagnostics()
    } catch (error) {
      this.setMessage(`Could not open ${file.name}: ${errorMessage(error)}`, 'error')
    } finally {
      if (ownsBusy) {
        this.state.busy = false
        this.fileOpenInProgress = false
        this.updateBusyControls()
      }
    }
  }

  private removeOpenTab(tabId: number): OpenFileTab | null {
    const index = this.state.openTabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) {
      return null
    }
    const wasActive = this.state.activeTabId === tabId
    this.state.openTabs.splice(index, 1)
    if (!wasActive) {
      return null
    }
    const replacementIndex = replacementTabIndex(this.state.openTabs.length, index)
    const replacement = replacementIndex === null ? null : this.state.openTabs[replacementIndex]
    this.resetCurrentFile()
    return replacement ?? null
  }

  private async closeAllOpenTabs(): Promise<void> {
    if (this.state.busy || this.state.openTabs.length === 0) {
      return
    }
    this.state.busy = true
    this.updateBusyControls()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      this.state.openTabs = []
      this.resetCurrentFile()
    } finally {
      this.state.busy = false
      this.renderAll()
    }
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

  private async createFileForToday(): Promise<void> {
    if (this.state.busy) {
      return
    }
    const problem = this.state.dailyProblem
    if (!this.state.repoPath || !this.state.projectValid || !problem) {
      this.setMessage('Choose a repository first', 'error')
      return
    }
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const plan = await createProblemWithRetry(this.backend, this.state.repoPath, {
        number: problem.frontendId,
        title: problem.title,
        difficulty: problem.difficulty,
        javaCodeSnippet: problem.javaSnippet,
      })
      this.gitController.markStale()
      await this.refreshFiles()
      const createdFile = this.state.files.find((file) => file.path === plan.path) ?? {
        path: plan.path,
        name: plan.fileName,
        packageSegment: plan.packageSegment,
      }
      await this.openFile(createdFile)
      this.setMessage(`Created ${plan.fileName}.`, 'success')
    } catch (error) {
      this.setMessage(`Could not create the problem file: ${errorMessage(error)}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private onEditorChange(source: string): void {
    if (this.suppressEditorChange || !this.state.selectedPath || !this.state.repoPath) {
      return
    }
    this.editor.setIssues([])
    this.state.selectedSource = source
    this.state.dirty = source !== this.state.savedSource
    this.state.saveError = null
    this.clearSavedFlash()
    if (this.state.testRun?.status === 'running') {
      this.testRunController.cancelCurrentRun()
      this.renderResult()
    }
    if (!this.gitDiscardInProgress) {
      this.autosave.schedule({
        repoPath: this.state.repoPath,
        filePath: this.state.selectedPath,
        source,
      })
    }
    this.renderFileHeading()
    this.updateFileTabState()
    this.scheduleLiveDiagnostics()
  }

  private resetCurrentFile(): void {
    this.state.activeTabId = null
    this.state.selectedPath = null
    this.state.selectedSource = ''
    this.state.savedSource = ''
    this.state.selectedFqcn = null
    this.state.dirty = false
    this.state.saveError = null
    this.testRunController.resetTestState()
    this.suppressEditorChange = true
    try {
      this.editor.setValue('')
    } finally {
      this.suppressEditorChange = false
    }
  }

  private async saveCurrentFile(): Promise<boolean> {
    if (!this.state.repoPath || !this.state.selectedPath) {
      return true
    }
    return this.flushPendingSave()
  }

  private async flushPendingSave(): Promise<boolean> {
    try {
      await this.autosave.flush()
      return !this.autosave.hasPendingChanges
    } catch (error) {
      this.handleSaveError(error)
      return false
    }
  }

  private async persistSnapshot(snapshot: AutosaveSnapshot): Promise<void> {
    this.saveWriteInFlight = true
    this.renderFileHeading()
    try {
      await this.backend.saveProblemFile(snapshot.repoPath, snapshot.filePath, snapshot.source)
    } finally {
      this.saveWriteInFlight = false
    }
    if (snapshot.repoPath !== this.state.repoPath || snapshot.filePath !== this.state.selectedPath) {
      return
    }
    this.state.savedSource = snapshot.source
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.state.saveError = null
    this.element<HTMLElement>('#editor-host').dataset.savedSource = snapshot.source
    this.gitController.markStale()
    if (!this.state.dirty) {
      this.flashSavedIndicator()
    }
    this.renderFileHeading()
    this.updateFileTabState()
  }

  /** Briefly surface "Saved" after a successful write, then clear it. */
  private flashSavedIndicator(): void {
    this.clearSavedFlash()
    this.savedFlash = true
    this.savedFlashTimer = setTimeout(() => {
      this.savedFlashTimer = null
      this.savedFlash = false
      if (!this.destroyed && this.root.querySelector('#save-status')) {
        this.renderFileHeading()
      }
    }, SAVED_FLASH_MS)
  }

  private clearSavedFlash(): void {
    if (this.savedFlashTimer !== null) {
      clearTimeout(this.savedFlashTimer)
      this.savedFlashTimer = null
    }
    this.savedFlash = false
  }

  private handleSaveError(error: unknown): void {
    this.state.saveError = errorMessage(error)
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.setMessage(`Could not save the file: ${this.state.saveError}`, 'error')
    this.renderAll()
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

  private isCurrentFileOperation(
    repoPath: string,
    repositoryGeneration: number,
    operationId: number,
  ): boolean {
    return this.state.projectValid
      && this.state.repoPath === repoPath
      && this.repositoryGeneration === repositoryGeneration
      && this.fileOperationId === operationId
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
  private async reloadOpenFileFromDisk(path: string): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath
      || this.destroyed
      || this.externalReloadInFlight
      || this.saveWriteInFlight
      || this.fileOpenInProgress) {
      return
    }
    this.externalReloadInFlight = true
    const repositoryGeneration = this.repositoryGeneration
    try {
      const source = await this.backend.readProblemFile(repoPath, path)
      if (this.destroyed
        || this.repositoryGeneration !== repositoryGeneration
        || this.state.repoPath !== repoPath
        || this.state.selectedPath !== path
        || source === this.state.savedSource) {
        return
      }
      if (this.state.dirty || this.autosave.hasPendingChanges) {
        this.setMessage(
          `${gitFileName(path)} changed on disk. Your unsaved edits were kept.`,
          'info',
        )
        return
      }
      this.state.savedSource = source
      this.state.selectedSource = source
      this.state.dirty = false
      this.state.saveError = null
      this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      this.suppressEditorChange = true
      try {
        this.editor.reloadExternalValue(source)
      } finally {
        this.suppressEditorChange = false
      }
      this.editor.setIssues([])
      this.gitController.markStale()
      this.scheduleLiveDiagnostics()
      this.renderFileHeading()
      this.updateFileTabState()
    } catch {
      // A file that was deleted or moved is reconciled by the file-list
      // refresh that the same watcher event triggers.
    } finally {
      this.externalReloadInFlight = false
    }
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
      hasPendingChanges: this.autosave.hasPendingChanges,
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
    this.renderAppMenu()
    this.renderSettingsDialog()
    this.renderAboutDialog()
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

  private async openTab(tabId: number): Promise<void> {
    if (this.state.busy) {
      return
    }
    const tab = this.state.openTabs.find((entry) => entry.id === tabId)
    if (!tab) {
      return
    }
    const file = this.state.files.find((entry) => sameFilePath(entry.path, tab.path))
    if (!file) {
      this.state.openTabs = this.state.openTabs.filter((entry) => entry.id !== tabId)
      if (this.state.activeTabId === tabId) {
        this.resetCurrentFile()
      }
      this.renderAll()
      return
    }
    await this.openFile(file)
  }

  private async closeOpenTab(tabId: number): Promise<void> {
    if (this.state.busy) {
      return
    }
    const target = this.state.openTabs.find((tab) => tab.id === tabId)
    if (!target) {
      return
    }
    const wasActive = target.id === this.state.activeTabId
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const replacement = this.removeOpenTab(tabId)
      if (wasActive && replacement) {
        const file = this.state.files.find((entry) => sameFilePath(entry.path, replacement.path)) ?? {
          path: replacement.path,
          name: replacement.name,
          packageSegment: replacement.packageSegment,
        }
        await this.openFile(file)
      }
    } finally {
      this.state.busy = false
      this.renderAll()
    }
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

  private toggleAppMenu(): void {
    if (this.appMenuOpen) {
      this.closeAppMenu()
    } else {
      this.openAppMenu()
    }
  }

  private openAppMenu(): void {
    if (this.appMenuOpen) {
      return
    }
    const active = document.activeElement
    this.appMenuFocusTarget = active instanceof HTMLElement ? active : null
    this.appMenuOpen = true
    this.renderAppMenu()
    queueMicrotask(() => {
      if (!this.appMenuOpen) {
        return
      }
      this.root.querySelector<HTMLButtonElement>('#app-menu [role="menuitem"]:not([hidden]):not(:disabled)')?.focus()
    })
  }

  private closeAppMenu(restoreFocus = true): void {
    if (!this.appMenuOpen) {
      return
    }
    this.appMenuOpen = false
    const target = this.appMenuFocusTarget
    this.appMenuFocusTarget = null
    this.renderAppMenu()
    if (restoreFocus && target && target.isConnected && !target.closest('[hidden]')) {
      target.focus()
    }
  }

  private renderAppMenu(): void {
    renderAppMenuView(this.root, {
      open: this.appMenuOpen,
      updateAvailable: this.updateAvailable,
      updateBusy: this.updateBusy,
      settingsShortcutLabel: shortcutLabel('open-settings', currentIsMacPlatform()),
    })
  }

  private setThemeMode(mode: string): void {
    this.themeMode = normalizeThemeMode(mode)
    applyTheme(this.themeMode)
    this.storage?.setItem(THEME_MODE_KEY, this.themeMode)
    this.renderSettingsDialog()
  }

  private openAboutDialog(): void {
    if (this.aboutDialogOpen) {
      return
    }
    const active = document.activeElement
    this.aboutDialogFocusTarget = active instanceof HTMLElement ? active : null
    this.aboutDialogOpen = true
    this.renderAboutDialog()
    queueMicrotask(() => {
      if (this.aboutDialogOpen) {
        this.element<HTMLButtonElement>('#close-about').focus()
      }
    })
  }

  private closeAboutDialog(): void {
    if (!this.aboutDialogOpen) {
      return
    }
    this.aboutDialogOpen = false
    const target = this.aboutDialogFocusTarget
    this.aboutDialogFocusTarget = null
    this.renderAboutDialog()
    if (target && target.isConnected && !target.closest('[hidden]')) {
      target.focus()
    } else {
      this.element<HTMLButtonElement>('#app-menu-button').focus()
    }
  }

  private renderAboutDialog(): void {
    renderAboutDialogView(this.root, this.aboutDialogOpen)
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
    this.closeAppMenu(false)
    if (!this.updateAvailable || this.updateBusy) {
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

  private setShortcutsPlatform(platform: ShortcutPlatform, focus = false): void {
    if (this.shortcutsPlatform === platform && !focus) {
      return
    }
    this.shortcutsPlatform = platform
    this.renderSettingsDialog()
    if (focus) {
      this.element<HTMLButtonElement>(platform === 'macos' ? '#shortcuts-macos-tab' : '#shortcuts-linux-tab').focus()
    }
  }

  private openSettingsDialog(section: SettingsSection = 'appearance'): void {
    if (!this.settingsDialogOpen) {
      const active = document.activeElement
      this.settingsDialogFocusTarget = active instanceof HTMLElement ? active : null
      this.settingsDialogOpen = true
    }
    this.settingsSection = section
    this.renderSettingsDialog()
    queueMicrotask(() => {
      if (!this.settingsDialogOpen) {
        return
      }
      if (this.settingsSection === 'keymap') {
        this.element<HTMLButtonElement>(this.shortcutsPlatform === 'macos'
          ? '#shortcuts-macos-tab'
          : '#shortcuts-linux-tab').focus()
      } else {
        this.root.querySelector<HTMLInputElement>('#settings-form input:checked')?.focus()
      }
    })
  }

  private closeSettingsDialog(): void {
    if (!this.settingsDialogOpen) {
      return
    }
    this.settingsDialogOpen = false
    const target = this.settingsDialogFocusTarget
    this.settingsDialogFocusTarget = null
    this.renderSettingsDialog()
    if (target && target.isConnected && !target.closest('[hidden]')) {
      target.focus()
    } else {
      this.element<HTMLButtonElement>('#app-menu-button').focus()
    }
  }

  private setSettingsSection(section: SettingsSection, focus = false): void {
    if (this.settingsSection === section && !focus) {
      return
    }
    this.settingsSection = section
    this.renderSettingsDialog()
    if (focus) {
      this.element<HTMLButtonElement>(section === 'keymap'
        ? '#settings-keymap-nav'
        : '#settings-appearance-nav').focus()
    }
  }

  private renderSettingsDialog(): void {
    renderSettingsDialogView(this.root, {
      open: this.settingsDialogOpen,
      section: this.settingsSection,
      platform: this.shortcutsPlatform,
      themeMode: this.themeMode,
    })
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
    const repoPath = this.state.repoPath
    if (!context || !repoPath || !this.state.projectValid || this.state.busy || this.state.git.busy) {
      return
    }
    const filePath = context.file.path
    const operation = this.gitController.startOperation('Opening in File Manager…')
    if (!operation) {
      return
    }
    this.closeGitContextMenu()
    this.renderAll()
    try {
      await this.backend.showInFileManager(repoPath, filePath)
      if (!this.gitController.isCurrentOperation(operation)) {
        return
      }
      this.setMessage(`Opened ${gitFileName(filePath)} in File Manager.`, 'success')
    } catch (error) {
      if (this.gitController.isCurrentOperation(operation)) {
        this.setMessage(`Could not show ${gitFileName(filePath)} in File Manager: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.gitController.finishOperation(operation)
    }
  }

  private async discardGitChangesAfterConfirmation(
    file: GitChangedFile,
    focusTarget: HTMLElement | null,
  ): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath || !this.state.projectValid || this.state.busy || this.state.git.busy) {
      this.restoreGitDiscardFocus(focusTarget)
      return
    }
    if (!this.state.git.files.some((entry) => sameFilePath(entry.path, file.path))) {
      this.setMessage(`The Git change for ${gitFileName(file.path)} is no longer available.`, 'info')
      this.restoreGitDiscardFocus(focusTarget)
      return
    }
    const filePath = file.path
    const targetTab = this.openTabForPath(filePath)
    const targetTabIndex = targetTab ? this.state.openTabs.indexOf(targetTab) : -1
    const wasActive = targetTab?.id === this.state.activeTabId
    const wasSelected = sameFilePath(this.state.selectedPath ?? '', filePath)
    const removesFile = isGitNewFile(file.status)
    const restoredPath = file.originalPath && !sameFilePath(file.originalPath, filePath)
      ? file.originalPath
      : null
    const operation = this.gitController.startOperation('Discarding changes…')
    if (!operation) {
      this.restoreGitDiscardFocus(focusTarget)
      return
    }
    this.closeGitContextMenu()
    this.gitDiscardInProgress = true
    this.renderAll()
    try {
      // Flush the current editor before the destructive backend operation so
      // the discard command always starts from a stable on-disk snapshot.
      if (!(await this.flushPendingSave())
        || !this.gitController.isCurrentOperation(operation)) {
        return
      }
      // The flush above drains the current timer/run. Do not let a queued
      // autosave write the pre-discard source back after Git restores it.
      this.autosave.cancelPending()
      await this.backend.discardGitChanges(repoPath, filePath)
      if (!this.gitController.isCurrentOperation(operation)) {
        return
      }

      let replacement: OpenFileTab | null = null
      if (removesFile && targetTab) {
        if (wasActive) {
          replacement = this.removeOpenTab(targetTab.id)
        } else {
          this.state.openTabs = this.state.openTabs.filter((tab) => tab.id !== targetTab.id)
        }
      } else if (removesFile && wasSelected) {
        this.resetCurrentFile()
      }

      if (!removesFile && wasSelected && !restoredPath) {
        // A tracked file is restored in place. Reload it from disk so the
        // editor cannot continue showing the discarded working-tree source.
        const source = await this.backend.readProblemFile(repoPath, filePath)
        if (!this.gitController.isCurrentOperation(operation)) {
          return
        }
        this.state.selectedSource = source
        this.state.savedSource = source
        this.state.dirty = false
        this.state.saveError = null
        this.clearSavedFlash()
        this.testRunController.resetTestState()
        this.suppressEditorChange = true
        try {
          this.editor.setValue(source)
        } finally {
          this.suppressEditorChange = false
        }
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      }

      this.gitController.markStale()
      await this.refreshFiles()
      if (!this.gitController.isCurrentOperation(operation)) {
        return
      }
      let restoredRename: ProblemFileEntry | null = null
      if (restoredPath && !this.state.files.some((entry) => sameFilePath(entry.path, filePath))) {
        restoredRename = findRestoredFileAfterGitRename(this.state.files, file)
        if (restoredRename && targetTab) {
          targetTab.path = restoredRename.path
          targetTab.name = restoredRename.name
          targetTab.packageSegment = restoredRename.packageSegment
          if (!this.state.openTabs.includes(targetTab)) {
            const insertionIndex = targetTabIndex < 0
              ? this.state.openTabs.length
              : Math.min(targetTabIndex, this.state.openTabs.length)
            this.state.openTabs.splice(insertionIndex, 0, targetTab)
          }
          if (wasActive) {
            this.state.activeTabId = targetTab.id
          }
        }
      }
      if (restoredRename && wasSelected) {
        // The destination of a staged rename disappears after discard. Keep
        // its existing tab identity, point it at the restored source path,
        // and load the restored content into the active editor.
        this.state.selectedPath = restoredRename.path
        this.state.selectedFqcn = fqcnFromJavaPath(restoredRename.path)
        const source = await this.backend.readProblemFile(repoPath, restoredRename.path)
        if (!this.gitController.isCurrentOperation(operation)) {
          return
        }
        this.state.selectedSource = source
        this.state.savedSource = source
        this.state.dirty = false
        this.state.saveError = null
        this.clearSavedFlash()
        this.testRunController.resetTestState()
        this.suppressEditorChange = true
        try {
          this.editor.setValue(source)
        } finally {
          this.suppressEditorChange = false
        }
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      }
      await this.gitController.refreshStatus(true)
      if (!this.gitController.isCurrentOperation(operation)) {
        return
      }
      if (wasActive && replacement) {
        const replacementFile = this.state.files.find((entry) => sameFilePath(entry.path, replacement!.path))
        if (replacementFile) {
          await this.openFile(replacementFile)
        }
      }
      this.setMessage(`Discarded changes to ${gitFileName(filePath)}.`, 'success')
    } catch (error) {
      if (this.gitController.isCurrentOperation(operation)) {
        // Refresh both views even when the backend reports an error: a Git
        // command can have changed the worktree before surfacing its failure.
        await this.refreshFiles()
        await this.gitController.refreshStatus(true)
        if (!this.gitController.isCurrentOperation(operation)) {
          return
        }
        this.setMessage(`Could not discard changes to ${gitFileName(filePath)}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.gitDiscardInProgress = false
      this.gitController.finishOperation(operation)
      this.restoreGitDiscardFocus(focusTarget)
    }
  }

  private async deleteFileAfterConfirmation(file: ProblemFileEntry): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const method = (this.backend as unknown as FileManagementBackend).deleteProblemFile
    if (!method) {
      this.setMessage('Not available in this build', 'error')
      return
    }
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.fileOperationId
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      await method(repoPath, file.path)
      if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const targetTab = this.openTabForPath(file.path)
      const wasActive = targetTab?.id === this.state.activeTabId
      const replacement = targetTab ? this.removeOpenTab(targetTab.id) : null
      if (wasActive && !targetTab) {
        this.resetCurrentFile()
      }
      this.gitController.markStale()
      await this.refreshFiles()
      if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      if (wasActive && replacement) {
        const replacementFile = this.state.files.find((entry) => sameFilePath(entry.path, replacement.path))
        if (replacementFile) {
          await this.openFile(replacementFile)
        }
      }
      this.setMessage(`Deleted ${file.name}.`, 'success')
    } catch (error) {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        // A backend can report an error after the filesystem mutation has
        // already completed. Re-list files before reporting so the explorer
        // reflects the actual repository state.
        await this.refreshFiles()
        if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.setMessage(`Could not delete ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.busy = false
        this.renderAll()
      }
    }
  }

  private async duplicateContextMenuFile(): Promise<void> {
    const context = this.state.contextMenu
    const repoPath = this.state.repoPath
    if (!context || !repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const method = (this.backend as unknown as FileManagementBackend).duplicateProblemFile
    if (!method) {
      this.closeFileContextMenu()
      this.setMessage('Not available in this build', 'error')
      return
    }
    const file = context.file
    const existingPaths = new Set(this.state.files.map((entry) => entry.path))
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.fileOperationId
    this.closeFileContextMenu()
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const result = await method(repoPath, file.path)
      if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.gitController.markStale()
      if (!(await this.refreshFiles()) || !this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const duplicate = findFileAfterDuplicate(
        this.state.files,
        existingPaths,
        file,
        result,
      )
      if (duplicate) {
        // Open the actual newly-created entry so the editor, selected path,
        // and test FQCN all follow the duplicate immediately.
        await this.openFile(duplicate)
        if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
      }
      this.setMessage(
        duplicate ? `Duplicated ${file.name} as ${duplicate.name}.` : `Duplicated ${file.name}.`,
        'success',
      )
    } catch (error) {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        // Re-list after a failed mutation because a backend can report an
        // error after the filesystem operation has already completed.
        await this.refreshFiles()
        if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.setMessage(`Could not duplicate ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.busy = false
        this.renderAll()
      }
    }
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
    const method = (this.backend as unknown as FileManagementBackend).renameProblemFile
    if (!method) {
      this.closeRenameDialog()
      this.setMessage('Not available in this build', 'error')
      return
    }
    const targetTab = this.openTabForPath(file.path)
    const wasSelected = targetTab?.id === this.state.activeTabId
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
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.fileOperationId
    this.closeRenameDialog()
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const result = await method(repoPath, file.path, newName)
      if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const requestedRenamedPath = fileMutationResultPath(result, file.path) ?? requestedPath
      if (targetTab) {
        targetTab.path = requestedRenamedPath
        targetTab.name = newName
        targetTab.packageSegment = file.packageSegment
      }
      this.gitController.markStale()
      const refreshed = await this.refreshFiles()
      if (!refreshed || !this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        if (targetTab && !refreshed) {
          targetTab.path = file.path
          targetTab.name = file.name
          targetTab.packageSegment = file.packageSegment
        }
        return
      }
      const renamed = findFileAfterRename(this.state.files, file, newName, result)
      if (targetTab && renamed) {
        targetTab.path = renamed.path
        targetTab.name = renamed.name
        targetTab.packageSegment = renamed.packageSegment
      }
      if (wasSelected && renamed) {
        await this.openFile(renamed)
      }
      this.setMessage(`Renamed ${file.name} to ${renamed?.name ?? newName}.`, 'success')
    } catch (error) {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        await this.refreshFiles()
        if (!this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.setMessage(`Could not rename ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (this.isCurrentFileOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.busy = false
        this.renderAll()
      }
    }
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
        saveWriteInFlight: this.saveWriteInFlight,
        dirty: this.state.dirty,
        hasPendingChanges: this.autosave.hasPendingChanges,
        savedFlash: this.savedFlash,
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
    const stack = this.element<HTMLElement>('#toast-stack')
    if (tone === 'error' && this.errorToastElement) {
      // A newer error replaces the previous one instead of stacking.
      this.errorToastElement.remove()
      this.errorToastElement = null
    }
    const toast = document.createElement('div')
    toast.className = `toast toast-${tone}`
    toast.append(iconFor(tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'info', 'toast-icon'))
    const copy = document.createElement('span')
    copy.className = 'toast-copy'
    const firstLine = message.split(/\r?\n/, 1)[0]
    copy.textContent = tone === 'error' ? firstLine : message
    if (tone === 'error' && firstLine !== message) {
      toast.title = message
    }
    toast.append(copy)
    if (tone === 'error') {
      toast.setAttribute('role', 'alert')
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'toast-close'
      close.setAttribute('aria-label', 'Dismiss')
      close.append(iconFor('close', 'toast-close-icon'))
      close.addEventListener('click', () => {
        toast.remove()
        if (this.errorToastElement === toast) {
          this.errorToastElement = null
        }
      })
      toast.append(close)
      this.errorToastElement = toast
    }
    stack.append(toast)
    while (stack.children.length > MAX_VISIBLE_TOASTS) {
      const oldest = stack.firstElementChild
      if (!oldest) {
        break
      }
      if (oldest === this.errorToastElement) {
        this.errorToastElement = null
      }
      oldest.remove()
    }
    if (tone !== 'error') {
      setTimeout(() => {
        toast.remove()
      }, TOAST_DISMISS_MS)
    }
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

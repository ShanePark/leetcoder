import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import {
  createBackendClient,
  errorMessage,
  type BackendClient,
  type DailyProblem,
  type GitPushResult,
  type ProblemDiagnostic,
  type ProblemFileEntry,
  type TestCaseResult,
  type TestResult,
  type TestRunProgress,
  type RepositoryFilesChanged,
} from './backend'
import {
  findJavaTestMethodAt,
  JavaEditor,
  isShortcutHelpAltShortcut,
} from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'
import { sanitizeProblemHtml } from './sanitize'
import {
  SHORTCUT_SECTIONS,
  formatShortcut,
  isSettingsShortcut,
  platformBindings,
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
  isFileTabsShiftWheel,
  RepositoryPickerCoordinator,
  replacementTabIndex,
} from './app/navigation'
import {
  autoSelectedTestKey,
  collectDiagnosticEditorIssues,
  collectEditorIssues,
  isTestRunSourceCurrent,
  liveSnapshotResult,
  runnerFailureResult,
  testFailureMessage,
  testResultBannerMessage,
  sameTest,
} from './app/test-results'
import {
  asGitCommitResult,
  asGitPushResult,
  defaultGitCommitMessage,
  gitFileName,
  gitResultToastMessage,
  gitStatusGlyph,
  isGitNewFile,
  normalizeGitDiff,
  normalizeGitStatus,
  normalizeGitStatusLabel,
  parseUnifiedDiffLines,
} from './app/git-helpers'
import {
  discardGitChangesWarningMessage,
  findFileAfterDuplicate,
  findFileAfterRename,
  findRestoredFileAfterGitRename,
  findTodayProblemFile,
  filterProblemFiles,
  filterProblemFilesByGroup,
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
  clampBottomPanelHeight,
  clampContextMenuPosition,
  clampDailyDescriptionHeight,
  clampGitFileListWidth,
  clampSidebarWidth,
  BOTTOM_PANEL_HEIGHT_KEY,
  DAILY_DESCRIPTION_HEIGHT_KEY,
  DAILY_DESCRIPTION_LAYOUT_OVERHEAD,
  DEFAULT_GIT_FILE_LIST_WIDTH,
  GIT_FILE_LIST_WIDTH_KEY,
  MAX_BOTTOM_PANEL_HEIGHT,
  MAX_DAILY_DESCRIPTION_HEIGHT,
  MAX_SIDEBAR_WIDTH,
  MIN_BOTTOM_PANEL_HEIGHT,
  MIN_DAILY_DESCRIPTION_HEIGHT,
  MIN_GIT_DIFF_WIDTH,
  MIN_GIT_FILE_LIST_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_CODE_CARD_HEIGHT,
  SIDEBAR_WIDTH_KEY,
  THEME_MODE_KEY,
  VIEWPORT_MARGIN,
  maxBottomPanelHeight,
  maxDailyDescriptionHeight,
  maxGitFileListWidth,
  maxSidebarWidth,
  macShortcutDialogLabel,
  normalizeDailyProblemDateKey,
  normalizeProblemNumber,
  normalizeThemeMode,
  nextUtcMidnightDelayMs,
  readBottomPanelHeight,
  readDailyDescriptionHeight,
  readGitFileListWidth,
  readSidebarWidth,
  readThemeMode,
  windowHeight,
  defaultShortcutPlatform,
  isMacPlatform,
  utcDateKey,
} from './app/layout'
import { renderShellView } from './app/shell-view'
import { renderTestResults, TEST_RUN_ROOT_KEY } from './app/results-view'
import type {
  AppOptions,
  AppState,
  AutosaveSnapshot,
  DirectoryPicker,
  FileManagementBackend,
  GitBackendClient,
  GitChangedFile,
  LiveDiagnosticsBackend,
  OpenFileTab,
  ProblemSelection,
  SettingsSection,
  ShortcutPlatform,
  TestRunSnapshot,
  TestRunSourceSnapshot,
  TestRunnerBackend,
  ThemeMode,
} from './app/types'
const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const APP_VERSION = '0.1.0'
const DAILY_DESCRIPTION_KEY = 'leetcoder.daily-description'
const GIT_REFRESH_DEBOUNCE_MS = 250
const GIT_POLL_INTERVAL_MS = 4000
const DAILY_RETRY_INTERVAL_MS = 60_000
const FILE_CONTEXT_MENU_WIDTH = 156
const FILE_CONTEXT_MENU_HEIGHT = 108
const GIT_CONTEXT_MENU_WIDTH = 190
const GIT_CONTEXT_MENU_HEIGHT = 76
const SAVED_FLASH_MS = 1500
const TOAST_DISMISS_MS = 3000
const MAX_VISIBLE_TOASTS = 3

const FILE_GROUPS: Array<{ key: ProblemFileEntry['packageSegment']; label: string }> = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'xhard', label: 'Hard' },
]
/** Files outside the difficulty packages; shown only when the group is non-empty. */
const OTHER_GROUP: { key: ProblemFileEntry['packageSegment']; label: string } = {
  key: 'other',
  label: 'Other',
}

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
    git: {
      branch: null,
      files: [],
      selectedPaths: [],
      activePath: null,
      diffByPath: {},
      fallbackDiff: '',
      loading: false,
      diffLoading: false,
      busy: false,
      error: null,
      commitMessage: '',
      commitMessageEdited: false,
      loadedRepoPath: null,
      stale: false,
    },
  }
  private editor: JavaEditor
  private readonly autosave: AutosaveCoordinator
  private readonly liveDiagnostics: LiveDiagnosticsScheduler
  private suppressEditorChange = false
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private externalReloadInFlight = false
  private stopWatchingFiles: (() => void) | null = null
  private shortcutsPlatform: ShortcutPlatform = defaultShortcutPlatform(currentIsMacPlatform())
  private testRunGeneration = 0
  /** Whether the user has explicitly chosen a row in the current run. */
  private testSelectionExplicit = false
  private nextOpenTabId = 1
  private closePreparation: Promise<void> | null = null
  private destroyed = false
  private testResultSource: TestRunSourceSnapshot | null = null
  private liveRenderFrame: number | null = null
  private liveRenderToken = 0
  private bottomPanelHeight: number
  private panelResizeStartY: number | null = null
  private panelResizeStartHeight: number | null = null
  private gitFileListWidth: number
  private gitSplitterStartX: number | null = null
  private gitSplitterStartWidth: number | null = null
  private sidebarWidth: number
  private sidebarSplitterStartX: number | null = null
  private sidebarSplitterStartWidth: number | null = null
  private dailyDescriptionHeight: number
  private dailyDescriptionResizeStartY: number | null = null
  private dailyDescriptionResizeStartHeight: number | null = null
  private gitStatusRequestId = 0
  private gitDiffRequestId = 0
  private gitOperationId = 0
  private fileOperationId = 0
  private fileOpenInProgress = false
  private gitRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private dailyRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private dailyRequestId = 0
  private problemNumberDraft: string | null = null
  private lastProblemRequest: ProblemSelection = 'daily'
  /** Remember the current daily id while a manual problem is being viewed. */
  private latestDailyProblem: { frontendId: string; dateKey: string } | null = null
  private pendingGitDiffPath: string | null = null
  private saveWriteInFlight = false
  private savedFlash = false
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null
  private dailyDescriptionOpen = false
  private gitDiscardInProgress = false
  private gitDiscardDialogFile: GitChangedFile | null = null
  private gitDiscardDialogFocusTarget: HTMLElement | null = null
  private deleteDialogFile: ProblemFileEntry | null = null
  private deleteDialogFocusTarget: HTMLElement | null = null
  private renderedFileTabsActiveId: number | null = null
  private renameTargetFile: ProblemFileEntry | null = null
  private errorToastElement: HTMLElement | null = null
  private sanitizedDescriptionSource: string | null = null
  private sanitizedDescriptionElement: HTMLElement | null = null
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
        void this.runCurrentTest()
      } else {
        // Ctrl+Shift+R is still useful outside an @Test method. In that
        // context it follows Ctrl+R and runs the complete test class.
        void this.runCurrentTest(findJavaTestMethodAt(this.editor.view.state) ?? undefined)
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

  private readonly handlePanelPointerMove = (event: PointerEvent): void => {
    if (this.panelResizeStartY === null || this.panelResizeStartHeight === null) {
      return
    }
    const nextHeight = clampBottomPanelHeight(
      this.panelResizeStartHeight + this.panelResizeStartY - event.clientY,
    )
    if (nextHeight === this.bottomPanelHeight) {
      return
    }
    this.bottomPanelHeight = nextHeight
    this.applyBottomPanelHeight()
    this.applyDailyDescriptionHeight()
  }

  private readonly handlePanelPointerUp = (): void => {
    if (this.panelResizeStartY === null) {
      return
    }
    this.panelResizeStartY = null
    this.panelResizeStartHeight = null
    this.root.classList.remove('is-resizing-panel')
    this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
  }

  private readonly handlePanelWindowBlur = (): void => {
    this.handlePanelPointerUp()
    this.handleGitSplitterPointerUp()
    this.handleSidebarSplitterPointerUp()
    this.handleDailyDescriptionResizePointerUp()
  }

  private readonly handleWindowFocus = (): void => {
    this.handleAppVisibilityReturn()
  }

  private readonly handleEditorFocus = (): void => {
    this.revealSelectedFileInExplorer()
  }

  private readonly handleFileTabsWheel = (event: WheelEvent): void => {
    const list = this.root.querySelector<HTMLElement>('#file-tabs')
    if (!list || !isFileTabsShiftWheel(event) || list.scrollWidth <= list.clientWidth) {
      return
    }
    event.preventDefault()
    list.scrollLeft += event.deltaY
  }

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this.clearScheduledGitRefresh()
      this.clearScheduledDailyRefresh()
      return
    }
    this.handleAppVisibilityReturn()
  }

  private readonly handleWindowResize = (): void => {
    const nextHeight = clampBottomPanelHeight(this.bottomPanelHeight)
    if (nextHeight !== this.bottomPanelHeight) {
      this.bottomPanelHeight = nextHeight
      this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
    }
    this.applyBottomPanelHeight()
    const nextWidth = clampGitFileListWidth(this.gitFileListWidth, this.gitWorkspaceWidth())
    if (nextWidth !== this.gitFileListWidth) {
      this.gitFileListWidth = nextWidth
      this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
    }
    this.applyGitFileListWidth()
    const nextSidebarWidth = clampSidebarWidth(this.sidebarWidth, this.sidebarWorkspaceWidth())
    if (nextSidebarWidth !== this.sidebarWidth) {
      this.sidebarWidth = nextSidebarWidth
      this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
    }
    this.applySidebarWidth()
    const nextDescriptionHeight = clampDailyDescriptionHeight(
      this.dailyDescriptionHeight,
      this.dailyDescriptionWorkspaceHeight(),
    )
    if (nextDescriptionHeight !== this.dailyDescriptionHeight) {
      this.dailyDescriptionHeight = nextDescriptionHeight
      this.storage?.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, String(this.dailyDescriptionHeight))
    }
    this.applyDailyDescriptionHeight()
  }

  private readonly handleGitSplitterPointerMove = (event: PointerEvent): void => {
    if (this.gitSplitterStartX === null || this.gitSplitterStartWidth === null) {
      return
    }
    const nextWidth = clampGitFileListWidth(
      this.gitSplitterStartWidth + event.clientX - this.gitSplitterStartX,
      this.gitWorkspaceWidth(),
    )
    if (nextWidth === this.gitFileListWidth) {
      return
    }
    this.gitFileListWidth = nextWidth
    this.applyGitFileListWidth()
  }

  private readonly handleGitSplitterPointerUp = (): void => {
    if (this.gitSplitterStartX === null) {
      return
    }
    this.gitSplitterStartX = null
    this.gitSplitterStartWidth = null
    this.root.classList.remove('is-resizing-git')
    this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
  }

  private readonly handleGitSplitterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextWidth = event.key === 'Home'
      ? MIN_GIT_FILE_LIST_WIDTH
      : event.key === 'End'
        ? maxGitFileListWidth(this.gitWorkspaceWidth())
        : this.gitFileListWidth + (event.key === 'ArrowRight' ? 16 : -16)
    this.gitFileListWidth = clampGitFileListWidth(nextWidth, this.gitWorkspaceWidth())
    this.applyGitFileListWidth()
    this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
  }

  private readonly handleSidebarSplitterPointerMove = (event: PointerEvent): void => {
    if (this.sidebarSplitterStartX === null || this.sidebarSplitterStartWidth === null) {
      return
    }
    const nextWidth = clampSidebarWidth(
      this.sidebarSplitterStartWidth + event.clientX - this.sidebarSplitterStartX,
      this.sidebarWorkspaceWidth(),
    )
    if (nextWidth === this.sidebarWidth) {
      return
    }
    this.sidebarWidth = nextWidth
    this.applySidebarWidth()
  }

  private readonly handleSidebarSplitterPointerUp = (): void => {
    if (this.sidebarSplitterStartX === null) {
      return
    }
    this.sidebarSplitterStartX = null
    this.sidebarSplitterStartWidth = null
    this.root.classList.remove('is-resizing-sidebar')
    this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
  }

  private readonly handleSidebarSplitterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextWidth = event.key === 'Home'
      ? MIN_SIDEBAR_WIDTH
      : event.key === 'End'
        ? maxSidebarWidth(this.sidebarWorkspaceWidth())
        : this.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16)
    this.sidebarWidth = clampSidebarWidth(nextWidth, this.sidebarWorkspaceWidth())
    this.applySidebarWidth()
    this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
  }

  private readonly handleDailyDescriptionResizePointerMove = (event: PointerEvent): void => {
    if (this.dailyDescriptionResizeStartY === null || this.dailyDescriptionResizeStartHeight === null) {
      return
    }
    const nextHeight = clampDailyDescriptionHeight(
      this.dailyDescriptionResizeStartHeight + event.clientY - this.dailyDescriptionResizeStartY,
      this.dailyDescriptionWorkspaceHeight(),
    )
    if (nextHeight === this.dailyDescriptionHeight) {
      return
    }
    this.dailyDescriptionHeight = nextHeight
    this.applyDailyDescriptionHeight()
  }

  private readonly handleDailyDescriptionResizePointerUp = (): void => {
    if (this.dailyDescriptionResizeStartY === null) {
      return
    }
    this.dailyDescriptionResizeStartY = null
    this.dailyDescriptionResizeStartHeight = null
    this.root.classList.remove('is-resizing-description')
    this.storage?.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, String(this.dailyDescriptionHeight))
  }

  private readonly handleDailyDescriptionResizeKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextHeight = event.key === 'Home'
      ? MIN_DAILY_DESCRIPTION_HEIGHT
      : event.key === 'End'
        ? maxDailyDescriptionHeight(this.dailyDescriptionWorkspaceHeight())
        : this.dailyDescriptionHeight + (event.key === 'ArrowDown' ? 16 : -16)
    this.dailyDescriptionHeight = clampDailyDescriptionHeight(
      nextHeight,
      this.dailyDescriptionWorkspaceHeight(),
    )
    this.applyDailyDescriptionHeight()
    this.storage?.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, String(this.dailyDescriptionHeight))
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

  private readonly handlePanelKeydown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 40 : 16
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
    } else {
      return
    }
    const nextHeight = event.key === 'Home'
      ? MIN_BOTTOM_PANEL_HEIGHT
      : event.key === 'End'
        ? maxBottomPanelHeight()
        : this.bottomPanelHeight + (event.key === 'ArrowUp' ? step : -step)
    this.bottomPanelHeight = clampBottomPanelHeight(nextHeight)
    this.applyBottomPanelHeight()
    this.applyDailyDescriptionHeight()
    this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
  }

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.root = root
    this.backend = options.backend ?? createBackendClient()
    this.directoryPicker = options.directoryPicker ?? defaultDirectoryPicker
    this.storage = options.storage ?? safeStorage()
    this.requestClose = options.requestClose
    this.themeMode = readThemeMode(this.storage)
    applyTheme(this.themeMode)
    this.bottomPanelHeight = readBottomPanelHeight(this.storage)
    this.gitFileListWidth = readGitFileListWidth(this.storage)
    this.sidebarWidth = readSidebarWidth(this.storage)
    this.dailyDescriptionHeight = readDailyDescriptionHeight(this.storage)
    this.dailyDescriptionOpen = this.storage?.getItem(DAILY_DESCRIPTION_KEY) === 'open'
    this.renderShell()
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
    this.editor = new JavaEditor(this.element('#editor'), {
      onChange: (source) => this.onEditorChange(source),
      onSave: () => {
        void this.saveCurrentFile()
        return true
      },
      onRun: () => {
        void this.runCurrentTest()
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
        void this.runCurrentTest(methodName ?? undefined)
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
    await this.loadDailyProblem()
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
    this.cancelScheduledLiveRender()
    this.liveDiagnostics.dispose()
    this.clearScheduledGitRefresh()
    this.editor.destroy()
    this.autosave.dispose()
    this.element<HTMLElement>('#editor-host').removeEventListener('focusin', this.handleEditorFocus)
    this.element<HTMLElement>('#file-tabs').removeEventListener('wheel', this.handleFileTabsWheel)
    window.removeEventListener('keydown', this.handleGlobalKeydown)
    window.removeEventListener('focus', this.handleWindowFocus)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('pointermove', this.handlePanelPointerMove)
    window.removeEventListener('pointerup', this.handlePanelPointerUp)
    window.removeEventListener('pointercancel', this.handlePanelPointerUp)
    window.removeEventListener('pointermove', this.handleGitSplitterPointerMove)
    window.removeEventListener('pointerup', this.handleGitSplitterPointerUp)
    window.removeEventListener('pointercancel', this.handleGitSplitterPointerUp)
    window.removeEventListener('pointermove', this.handleSidebarSplitterPointerMove)
    window.removeEventListener('pointerup', this.handleSidebarSplitterPointerUp)
    window.removeEventListener('pointercancel', this.handleSidebarSplitterPointerUp)
    window.removeEventListener('pointermove', this.handleDailyDescriptionResizePointerMove)
    window.removeEventListener('pointerup', this.handleDailyDescriptionResizePointerUp)
    window.removeEventListener('pointercancel', this.handleDailyDescriptionResizePointerUp)
    window.removeEventListener('blur', this.handlePanelWindowBlur)
    window.removeEventListener('resize', this.handleWindowResize)
    window.removeEventListener('pointerdown', this.handleContextMenuOutside)
    window.removeEventListener('keydown', this.handleContextMenuKeydown)
    this.clearScheduledDailyRefresh()
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
    this.element<HTMLElement>('#file-tabs').addEventListener('wheel', this.handleFileTabsWheel, { passive: false })
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
      void this.runCurrentTest()
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
      this.selectAllGitFiles()
    })
    this.element<HTMLButtonElement>('#git-select-none').addEventListener('click', () => {
      this.selectNoGitFiles()
    })
    this.element<HTMLInputElement>('#git-commit-message').addEventListener('input', (event) => {
      // Typing must not re-render the panel — a rerender would fight the
      // caret. Only the commit-control enablement updates directly.
      this.state.git.commitMessage = (event.target as HTMLInputElement).value
      this.state.git.commitMessageEdited = this.state.git.commitMessage.trim().length > 0
      this.updateGitCommitControls()
    })
    this.element<HTMLButtonElement>('#git-commit').addEventListener('click', () => {
      void this.commitSelectedGitFiles(false)
    })
    this.element<HTMLButtonElement>('#git-commit-push').addEventListener('click', () => {
      void this.commitAndPushGitChanges()
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
    const sidebarSplitter = this.element<HTMLElement>('#sidebar-splitter')
    sidebarSplitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      this.sidebarSplitterStartX = event.clientX
      this.sidebarSplitterStartWidth = this.sidebarWidth
      this.root.classList.add('is-resizing-sidebar')
      sidebarSplitter.setPointerCapture?.(event.pointerId)
    })
    sidebarSplitter.addEventListener('keydown', this.handleSidebarSplitterKeydown)
    sidebarSplitter.addEventListener('lostpointercapture', this.handleSidebarSplitterPointerUp)
    const descriptionResizeHandle = this.element<HTMLElement>('#daily-description-resize-handle')
    descriptionResizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || descriptionResizeHandle.hidden) {
        return
      }
      event.preventDefault()
      this.dailyDescriptionResizeStartY = event.clientY
      this.dailyDescriptionResizeStartHeight = this.dailyDescriptionHeight
      this.root.classList.add('is-resizing-description')
      descriptionResizeHandle.setPointerCapture?.(event.pointerId)
    })
    descriptionResizeHandle.addEventListener('keydown', this.handleDailyDescriptionResizeKeydown)
    descriptionResizeHandle.addEventListener('lostpointercapture', this.handleDailyDescriptionResizePointerUp)
    const gitSplitter = this.element<HTMLElement>('#git-splitter')
    gitSplitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      this.gitSplitterStartX = event.clientX
      this.gitSplitterStartWidth = this.gitFileListWidth
      this.root.classList.add('is-resizing-git')
      gitSplitter.setPointerCapture?.(event.pointerId)
    })
    gitSplitter.addEventListener('keydown', this.handleGitSplitterKeydown)
    gitSplitter.addEventListener('lostpointercapture', this.handleGitSplitterPointerUp)
    const resizeHandle = this.element<HTMLElement>('#bottom-panel-resize-handle')
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      this.panelResizeStartY = event.clientY
      this.panelResizeStartHeight = this.bottomPanelHeight
      this.root.classList.add('is-resizing-panel')
      resizeHandle.setPointerCapture?.(event.pointerId)
    })
    resizeHandle.addEventListener('keydown', this.handlePanelKeydown)
    resizeHandle.addEventListener('lostpointercapture', this.handlePanelPointerUp)
    window.addEventListener('pointermove', this.handlePanelPointerMove)
    window.addEventListener('pointerup', this.handlePanelPointerUp)
    window.addEventListener('pointercancel', this.handlePanelPointerUp)
    window.addEventListener('pointermove', this.handleGitSplitterPointerMove)
    window.addEventListener('pointerup', this.handleGitSplitterPointerUp)
    window.addEventListener('pointercancel', this.handleGitSplitterPointerUp)
    window.addEventListener('pointermove', this.handleSidebarSplitterPointerMove)
    window.addEventListener('pointerup', this.handleSidebarSplitterPointerUp)
    window.addEventListener('pointercancel', this.handleSidebarSplitterPointerUp)
    window.addEventListener('pointermove', this.handleDailyDescriptionResizePointerMove)
    window.addEventListener('pointerup', this.handleDailyDescriptionResizePointerUp)
    window.addEventListener('pointercancel', this.handleDailyDescriptionResizePointerUp)
    window.addEventListener('blur', this.handlePanelWindowBlur)
    window.addEventListener('resize', this.handleWindowResize)
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
      this.resetGitState()
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

  private async loadDailyProblem(notifyOnError = false): Promise<void> {
    if (this.state.dailyLoading) {
      return
    }
    const requestId = ++this.dailyRequestId
    this.lastProblemRequest = 'daily'
    this.state.dailyLoading = true
    this.state.dailyError = null
    this.renderAll()
    try {
      const problem = await this.backend.fetchDailyProblem()
      if (this.destroyed || requestId !== this.dailyRequestId) {
        return
      }
      const problemDateKey = normalizeDailyProblemDateKey(problem.date)
      const currentDateKey = utcDateKey()
      if (!problemDateKey) {
        this.state.dailyRetryPending = true
        this.state.dailyError = 'The daily problem returned an invalid date.'
        if (notifyOnError) {
          this.setMessage(`Could not load today’s problem: ${this.state.dailyError}`, 'error')
        }
      } else if (problemDateKey !== currentDateKey) {
        // The provider still serves yesterday's problem. Not an error: the
        // card shows a waiting state and the retry timer keeps polling.
        this.state.dailyRetryPending = true
        this.state.dailyProblemDateKey = problemDateKey
        this.state.dailyError = null
        if (notifyOnError) {
          this.setMessage('Today’s problem is not available yet. Try again shortly.', 'info')
        }
      } else {
        this.state.dailyProblem = problem
        this.state.problemSelection = 'daily'
        this.problemNumberDraft = problem.frontendId
        this.latestDailyProblem = {
          frontendId: problem.frontendId,
          dateKey: problemDateKey,
        }
        this.state.dailyProblemDateKey = problemDateKey
        this.state.dailyRetryPending = false
        this.state.dailyError = null
      }
    } catch (error) {
      if (this.destroyed || requestId !== this.dailyRequestId) {
        return
      }
      this.state.dailyRetryPending = true
      this.state.dailyError = errorMessage(error)
      if (notifyOnError) {
        this.setMessage(`Could not load today’s problem: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (!this.destroyed && requestId === this.dailyRequestId) {
        this.state.dailyLoading = false
        this.scheduleDailyProblemRefresh(this.state.dailyRetryPending ? DAILY_RETRY_INTERVAL_MS : nextUtcMidnightDelayMs())
        this.renderAll()
      }
    }
  }

  private async loadProblemByNumber(value: string): Promise<void> {
    const problemNumber = normalizeProblemNumber(value)
    if (!problemNumber) {
      this.setMessage('Enter a valid LeetCode problem number.', 'error')
      return
    }
    if (this.state.dailyLoading) {
      return
    }

    const requestId = ++this.dailyRequestId
    this.lastProblemRequest = 'manual'
    this.problemNumberDraft = problemNumber
    this.state.dailyLoading = true
    this.state.dailyError = null
    this.renderAll()
    try {
      const problem = await this.backend.fetchProblemByNumber(problemNumber)
      if (this.destroyed || requestId !== this.dailyRequestId) {
        return
      }
      this.state.dailyProblem = problem
      this.state.problemSelection = 'manual'
      this.state.dailyProblemDateKey = null
      this.state.dailyRetryPending = false
      this.state.dailyError = null
    } catch (error) {
      if (this.destroyed || requestId !== this.dailyRequestId) {
        return
      }
      // Keep the currently displayed problem intact when a lookup fails.
      if (this.state.dailyProblem && this.problemNumberDraft === problemNumber) {
        this.problemNumberDraft = this.state.dailyProblem.frontendId
      }
      this.state.dailyRetryPending = false
      this.state.dailyError = errorMessage(error)
      this.setMessage(`Could not load problem #${problemNumber}: ${errorMessage(error)}`, 'error')
    } finally {
      if (!this.destroyed && requestId === this.dailyRequestId) {
        this.state.dailyLoading = false
        this.scheduleDailyProblemRefresh()
        this.renderAll()
      }
    }
  }

  private refreshSelectedProblem(): void {
    if (this.state.problemSelection === 'manual' && this.state.dailyProblem) {
      void this.loadProblemByNumber(this.state.dailyProblem.frontendId)
      return
    }
    void this.loadDailyProblem(true)
  }

  private isViewingTodayProblem(problem: DailyProblem): boolean {
    const currentDateKey = utcDateKey()
    if (this.state.problemSelection === 'daily') {
      return this.state.dailyProblemDateKey === currentDateKey
    }
    return this.latestDailyProblem?.frontendId === problem.frontendId
      && this.latestDailyProblem.dateKey === currentDateKey
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
      const missingTabs = this.state.openTabs.filter((tab) => !files.some((file) => sameFilePath(file.path, tab.path)))
      if (missingTabs.length > 0 && !(await this.flushPendingSave())) {
        return false
      }
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.state.files = files
      this.markGitStale()
      for (const tab of this.state.openTabs) {
        const refreshed = files.find((file) => sameFilePath(file.path, tab.path))
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
    const testIssues = this.testResultSource && this.state.testResult
      && this.isTestRunSourceCurrent(this.testResultSource)
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

  private resetTestState(): void {
    this.state.testResult = null
    this.state.testRun = null
    this.state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.testRunGeneration += 1
    this.editor.setIssues([])
    this.liveDiagnostics.cancel()
    this.state.liveDiagnosticsError = null
    this.testResultSource = null
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
      this.resetTestState()
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
      this.markGitStale()
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
    const activeRunId = this.state.testRun?.status === 'running'
      ? this.state.testRun.id
      : null
    this.editor.setIssues([])
    this.state.selectedSource = source
    this.testResultSource = null
    this.state.dirty = source !== this.state.savedSource
    this.state.saveError = null
    this.clearSavedFlash()
    if (activeRunId !== null) {
      this.discardStaleTestRun(activeRunId)
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
    this.resetTestState()
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
    this.markGitStale()
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

  private async runCurrentTest(testMethod?: string): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (!this.state.repoPath || !this.state.selectedPath || !this.state.selectedFqcn) {
      this.setMessage('Select a Java problem file to run', 'info')
      return
    }
    const runSnapshot: TestRunSourceSnapshot = {
      repoPath: this.state.repoPath,
      filePath: this.state.selectedPath,
      source: this.state.selectedSource,
    }
    const runRepoPath = runSnapshot.repoPath
    const runFilePath = runSnapshot.filePath
    const runFqcn = this.state.selectedFqcn
    this.state.busy = true
    const runId = ++this.testRunGeneration
    const run: TestRunSnapshot = {
      id: runId,
      status: 'running',
      phase: 'starting',
      startedAt: Date.now(),
      tests: [],
      stdout: '',
      stderr: '',
      activeTest: null,
      error: null,
      testMethod: testMethod ?? null,
    }
    this.state.testRun = run
    this.state.testResult = null
    this.testResultSource = null
    this.state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.liveDiagnostics.setBlocked(true)
    this.editor.setIssues([])
    // A starting run always brings the Tests tab forward so progress is visible.
    this.selectBottomPanelTab('tests')
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        if (this.isCurrentTestRun(runId)) {
          if (!this.isTestRunSourceCurrent(runSnapshot)) {
            this.discardStaleTestRun(runId)
            return
          }
          const failure = runnerFailureResult(
            run,
            this.state.saveError ?? 'The source file could not be saved before running tests.',
          )
          run.status = 'error'
          run.error = testFailureMessage(failure)
          this.state.testResult = failure
          this.testResultSource = runSnapshot
          this.autoSelectFailedTest(failure)
        }
        return
      }
      const runner = (this.backend as unknown as TestRunnerBackend).runProblemTest
      const onProgress = (progress: TestRunProgress): void => this.applyTestRunProgress(runId, progress)
      const result = testMethod === undefined
        ? await runner(runRepoPath, runFqcn, onProgress)
        : await runner(runRepoPath, runFqcn, onProgress, testMethod)
      if (!this.isCurrentTestRun(runId)) {
        return
      }
      if (!this.isTestRunSourceCurrent(runSnapshot)) {
        this.discardStaleTestRun(runId)
        return
      }
      this.state.testResult = result
      this.testResultSource = runSnapshot
      this.autoSelectFailedTest(result)
      this.editor.setIssues(collectEditorIssues(result, runFilePath))
      run.status = 'completed'
      run.phase = result.phase
      run.tests = result.tests
      run.stdout = result.stdout
      run.stderr = result.stderr
      run.activeTest = null
      run.error = result.success ? null : testFailureMessage(result)
      if (result.success) {
        // Failures never toast: the Tests panel is already front and center.
        this.setMessage(testResultBannerMessage(result), 'success')
      }
    } catch (error) {
      if (this.isCurrentTestRun(runId)) {
        if (!this.isTestRunSourceCurrent(runSnapshot)) {
          this.discardStaleTestRun(runId)
          return
        }
        const failure = runnerFailureResult(run, errorMessage(error))
        run.status = 'error'
        run.phase = failure.phase
        run.error = testFailureMessage(failure)
        run.activeTest = null
        this.state.testResult = failure
        this.testResultSource = runSnapshot
        this.autoSelectFailedTest(failure)
      }
    } finally {
      this.liveDiagnostics.setBlocked(false)
      this.state.busy = false
      this.renderAll()
    }
  }

  private isCurrentTestRun(runId: number): boolean {
    return this.state.testRun?.id === runId
      && this.testRunGeneration === runId
  }

  private isTestRunSourceCurrent(snapshot: TestRunSourceSnapshot): boolean {
    return isTestRunSourceCurrent(snapshot, {
      repoPath: this.state.repoPath,
      filePath: this.state.selectedPath,
      source: this.state.selectedSource,
    })
  }

  private discardStaleTestRun(runId: number): void {
    if (!this.isCurrentTestRun(runId)) {
      return
    }
    this.state.testRun = null
    this.state.testResult = null
    this.testResultSource = null
    this.state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.editor.setIssues([])
    this.setMessage('Run cancelled — file changed', 'info')
  }

  private applyTestRunProgress(runId: number, progress: TestRunProgress): void {
    if (!this.isCurrentTestRun(runId)) {
      return
    }
    const run = this.state.testRun
    if (!run || run.status !== 'running') {
      return
    }
    switch (progress.kind) {
      case 'started':
        run.phase = 'starting'
        break
      case 'phase':
        run.phase = progress.phase
        break
      case 'log':
        run[progress.stream] += progress.text
        break
      case 'testStarted':
        run.activeTest = progress.test
        this.upsertLiveTest(run, { ...progress.test, status: 'running' })
        break
      case 'testFinished':
        this.upsertLiveTest(run, progress.test)
        if (progress.test.status === 'failed' || progress.test.status === 'error') {
          this.autoSelectFailedTest(liveSnapshotResult(run))
        }
        if (sameTest(run.activeTest, progress.test)) {
          run.activeTest = null
        }
        break
    }
    this.scheduleLiveResultRender()
  }

  private upsertLiveTest(run: TestRunSnapshot, test: TestCaseResult): void {
    const index = run.tests.findIndex((entry) => sameTest(entry, test))
    if (index < 0) {
      run.tests.push(test)
      return
    }
    run.tests[index] = { ...run.tests[index], ...test }
  }

  private scheduleLiveResultRender(): void {
    if (this.destroyed || this.liveRenderFrame !== null) {
      return
    }
    const token = ++this.liveRenderToken
    const flush = (): void => {
      if (token !== this.liveRenderToken || this.destroyed) {
        return
      }
      this.liveRenderFrame = null
      this.renderResult()
    }
    if (typeof window.requestAnimationFrame === 'function') {
      this.liveRenderFrame = window.requestAnimationFrame(flush)
    } else {
      // The fallback keeps the same coalescing behavior in non-visual test
      // environments where requestAnimationFrame is unavailable.
      this.liveRenderFrame = -1
      queueMicrotask(() => {
        if (this.liveRenderFrame === -1) {
          flush()
        }
      })
    }
  }

  private cancelScheduledLiveRender(): void {
    this.liveRenderToken += 1
    if (
      this.liveRenderFrame !== null
      && this.liveRenderFrame !== -1
      && typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(this.liveRenderFrame)
    }
    this.liveRenderFrame = null
  }

  private resetGitState(): void {
    this.clearScheduledGitRefresh()
    this.state.gitContextMenu = null
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
    this.gitStatusRequestId += 1
    this.gitDiffRequestId += 1
    this.gitOperationId += 1
    this.pendingGitDiffPath = null
    this.state.git = {
      branch: null,
      files: [],
      selectedPaths: [],
      activePath: null,
      diffByPath: {},
      fallbackDiff: '',
      loading: false,
      diffLoading: false,
      busy: false,
      error: null,
      commitMessage: '',
      commitMessageEdited: false,
      loadedRepoPath: null,
      stale: false,
    }
  }

  private applyBottomPanelHeight(): void {
    const panel = this.element<HTMLElement>('#bottom-panel')
    panel.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeight}px`)
    const handle = this.element<HTMLElement>('#bottom-panel-resize-handle')
    handle.setAttribute('aria-valuenow', String(this.bottomPanelHeight))
    handle.setAttribute('aria-valuemax', String(maxBottomPanelHeight()))
  }

  private gitWorkspaceWidth(): number {
    const workspace = this.root.querySelector<HTMLElement>('.git-workspace')
    return workspace && workspace.clientWidth > 0 ? workspace.clientWidth : 900
  }

  private sidebarWorkspaceWidth(): number {
    const workspace = this.root.querySelector<HTMLElement>('.workspace')
    if (workspace && workspace.clientWidth > 0) {
      return workspace.clientWidth
    }
    if (typeof window !== 'undefined' && window.innerWidth > 0) {
      return window.innerWidth
    }
    return 1000
  }

  private applySidebarWidth(): void {
    const workspace = this.element<HTMLElement>('.workspace')
    const width = clampSidebarWidth(this.sidebarWidth, this.sidebarWorkspaceWidth())
    this.sidebarWidth = width
    workspace.style.setProperty('--sidebar-width', `${width}px`)
    const splitter = this.element<HTMLElement>('#sidebar-splitter')
    splitter.setAttribute('aria-valuenow', String(width))
    splitter.setAttribute('aria-valuemax', String(maxSidebarWidth(this.sidebarWorkspaceWidth())))
  }

  private dailyDescriptionWorkspaceHeight(): number {
    const column = this.root.querySelector<HTMLElement>('.editor-column')
    if (column && column.clientHeight > 0) {
      return column.clientHeight
    }
    // jsdom and the initial hidden webview do not expose layout metrics. The
    // workspace is the viewport minus the app header and bottom panel.
    return Math.max(
      MIN_DAILY_DESCRIPTION_HEIGHT + MIN_CODE_CARD_HEIGHT + DAILY_DESCRIPTION_LAYOUT_OVERHEAD,
      windowHeight() - 44 - this.bottomPanelHeight,
    )
  }

  private applyDailyDescriptionHeight(): void {
    const description = this.element<HTMLElement>('#daily-description')
    const height = clampDailyDescriptionHeight(
      this.dailyDescriptionHeight,
      this.dailyDescriptionWorkspaceHeight(),
    )
    this.dailyDescriptionHeight = height
    description.style.setProperty('--daily-description-height', `${height}px`)
    const handle = this.element<HTMLElement>('#daily-description-resize-handle')
    handle.setAttribute('aria-valuenow', String(height))
    handle.setAttribute('aria-valuemax', String(maxDailyDescriptionHeight(this.dailyDescriptionWorkspaceHeight())))
  }

  private applyGitFileListWidth(): void {
    const workspace = this.element<HTMLElement>('.git-workspace')
    const width = clampGitFileListWidth(this.gitFileListWidth, this.gitWorkspaceWidth())
    this.gitFileListWidth = width
    workspace.style.setProperty('--git-file-list-width', `${width}px`)
    const splitter = this.element<HTMLElement>('#git-splitter')
    splitter.setAttribute('aria-valuenow', String(width))
    splitter.setAttribute('aria-valuemax', String(maxGitFileListWidth(this.gitWorkspaceWidth())))
  }

  private selectBottomPanelTab(tab: 'tests' | 'git', focus = false): void {
    this.state.bottomPanelTab = tab
    if (tab !== 'git') {
      this.clearScheduledGitRefresh()
    }
    this.renderBottomPanelTabs()
    this.renderGitPanel()
    if (tab === 'git') {
      // The workspace has just become measurable; reclamp persisted width
      // against its actual client width instead of the hidden-panel fallback.
      this.applyGitFileListWidth()
    }
    if (focus) {
      this.element<HTMLButtonElement>(tab === 'tests' ? '#tests-tab' : '#git-tab').focus()
    }
    if (tab === 'git' && this.state.repoPath && this.state.projectValid
      && !this.state.busy && !this.state.git.loading) {
      void this.refreshGitStatus()
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

  private isCurrentGitStatusRequest(
    repoPath: string,
    repositoryGeneration: number,
    requestId: number,
  ): boolean {
    return this.state.projectValid
      && this.state.repoPath === repoPath
      && this.repositoryGeneration === repositoryGeneration
      && this.gitStatusRequestId === requestId
  }

  private isCurrentGitDiffRequest(
    repoPath: string,
    repositoryGeneration: number,
    statusRequestId: number,
    diffRequestId: number,
  ): boolean {
    return this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, statusRequestId)
      && this.gitDiffRequestId === diffRequestId
  }

  private isCurrentGitOperation(
    repoPath: string,
    repositoryGeneration: number,
    operationId: number,
  ): boolean {
    return this.state.projectValid
      && this.state.repoPath === repoPath
      && this.repositoryGeneration === repositoryGeneration
      && this.gitOperationId === operationId
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

  private markGitStale(): void {
    this.gitStatusRequestId += 1
    this.gitDiffRequestId += 1
    this.clearScheduledGitRefresh()
    this.state.git.stale = true
    this.state.git.loading = false
    this.state.git.diffLoading = false
    if (this.state.bottomPanelTab === 'git') {
      this.renderGitPanel()
      this.scheduleGitRefreshIfNeeded()
    }
  }

  private scheduleGitRefreshIfNeeded(): void {
    if (this.gitRefreshTimer !== null
      || this.state.bottomPanelTab !== 'git'
      || !this.state.repoPath
      || !this.state.projectValid
      || !this.isWindowVisible()
      || this.state.busy
      || this.state.git.busy
      || this.state.git.loading) {
      return
    }
    this.gitRefreshTimer = setTimeout(() => {
      this.gitRefreshTimer = null
      if (this.state.bottomPanelTab !== 'git'
        || !this.state.repoPath
        || !this.state.projectValid
        || !this.isWindowVisible()
        || this.state.busy
        || this.state.git.busy
        || this.state.git.loading
        || this.state.bottomPanelTab !== 'git') {
        this.scheduleGitRefreshIfNeeded()
        return
      }
      // Consume this stale marker before attempting the request. The regular
      // poll remains active after an error, while request guards prevent an
      // older response from painting over a newer repository state.
      this.state.git.stale = false
      void this.refreshGitStatus()
    }, this.state.git.stale ? GIT_REFRESH_DEBOUNCE_MS : GIT_POLL_INTERVAL_MS)
  }

  private clearScheduledGitRefresh(): void {
    if (this.gitRefreshTimer !== null) {
      clearTimeout(this.gitRefreshTimer)
      this.gitRefreshTimer = null
    }
  }

  private clearScheduledDailyRefresh(): void {
    if (this.dailyRefreshTimer !== null) {
      clearTimeout(this.dailyRefreshTimer)
      this.dailyRefreshTimer = null
    }
  }

  private scheduleDailyProblemRefresh(delayMs = nextUtcMidnightDelayMs()): void {
    this.clearScheduledDailyRefresh()
    if (this.destroyed
      || this.state.dailyLoading
      || this.state.problemSelection !== 'daily'
      || !this.isWindowVisible()) {
      return
    }
    this.dailyRefreshTimer = setTimeout(() => {
      this.dailyRefreshTimer = null
      if (!this.isWindowVisible() || this.destroyed) {
        return
      }
      this.refreshDailyProblemIfStale()
    }, Math.max(1, delayMs))
  }

  private refreshDailyProblemIfStale(): void {
    const currentDateKey = utcDateKey()
    if (this.state.dailyLoading || this.state.problemSelection !== 'daily') {
      return
    }
    if (this.state.dailyRetryPending
      || !this.state.dailyProblem
      || this.state.dailyProblemDateKey !== currentDateKey) {
      void this.loadDailyProblem()
      return
    }
    this.scheduleDailyProblemRefresh()
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
      this.testResultSource = null
      this.markGitStale()
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
    this.refreshDailyProblemIfStale()
    // Filesystem events can be missed while the window is hidden, so returning
    // to it re-checks the open file the way an IDE syncs on frame activation.
    if (this.state.selectedPath && this.state.projectValid) {
      void this.reloadOpenFileFromDisk(this.state.selectedPath)
    }
    if (this.state.bottomPanelTab !== 'git'
      || !this.state.projectValid
      || !this.state.repoPath
      || this.state.busy
      || this.state.git.busy
      || this.state.git.loading) {
      return
    }
    this.clearScheduledGitRefresh()
    void this.refreshGitStatus()
  }

  private isWindowVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  private async refreshGitStatus(allowBusy = false): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath || !this.state.projectValid) {
      this.state.git.error = 'Choose a repository first'
      this.renderGitPanel()
      return
    }
    if ((!allowBusy && this.state.busy) || this.state.git.loading) {
      return
    }
    this.clearScheduledGitRefresh()
    const gitBackend = this.backend as unknown as GitBackendClient
    const method = gitBackend.getGitStatus ?? gitBackend.listGitChanges
    if (!method) {
      this.state.git.error = 'Not available in this build'
      this.state.git.loadedRepoPath = repoPath
      this.renderGitPanel()
      return
    }
    const previousPaths = this.state.git.selectedPaths
    const repositoryGeneration = this.repositoryGeneration
    const requestId = ++this.gitStatusRequestId
    this.pendingGitDiffPath = null
    this.state.git.loading = true
    this.state.git.stale = false
    this.state.git.error = null
    this.renderGitPanel()
    try {
      const snapshot = normalizeGitStatus(await method(repoPath))
      if (!this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, requestId)) {
        return
      }
      const availablePaths = new Set(snapshot.files.map((file) => file.path))
      const preserveSelection = this.state.git.loadedRepoPath === repoPath
      const selectedPaths = preserveSelection
        ? previousPaths.filter((path) => availablePaths.has(path))
        : snapshot.files.map((file) => file.path)
      this.state.git.branch = snapshot.branch
      this.state.git.files = snapshot.files
      this.state.git.selectedPaths = selectedPaths
      this.state.git.activePath = snapshot.files.some((file) => file.path === this.state.git.activePath)
        ? this.state.git.activePath
        : snapshot.files[0]?.path ?? null
      this.state.git.diffByPath = {}
      this.state.git.fallbackDiff = ''
      this.state.git.loadedRepoPath = repoPath
      const activePath = this.state.git.activePath
      await this.loadGitDiff(
        repoPath,
        activePath ? [activePath] : [],
        requestId,
        repositoryGeneration,
      )
      if (!this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, requestId)) {
        return
      }
      this.state.git.stale = false
    } catch (error) {
      if (!this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, requestId)) {
        return
      }
      this.state.git.error = errorMessage(error)
    } finally {
      if (this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, requestId)) {
        this.state.git.loading = false
        this.renderAll()
      }
    }
  }

  private async loadGitDiff(
    repoPath: string,
    paths: string[],
    statusRequestId = this.gitStatusRequestId,
    repositoryGeneration = this.repositoryGeneration,
  ): Promise<void> {
    if (paths.length === 0) {
      if (this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, statusRequestId)) {
        this.state.git.diffLoading = false
      }
      return
    }
    const method = (this.backend as unknown as GitBackendClient).getGitDiff
    if (!method) {
      if (this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, statusRequestId)) {
        this.state.git.error = 'Not available in this build'
      }
      return
    }
    const diffRequestId = ++this.gitDiffRequestId
    this.state.git.diffLoading = true
    this.renderGitPanel()
    try {
      const normalized = normalizeGitDiff(await method(repoPath, paths), paths)
      if (!this.isCurrentGitDiffRequest(repoPath, repositoryGeneration, statusRequestId, diffRequestId)) {
        return
      }
      this.state.git.diffByPath = { ...this.state.git.diffByPath, ...normalized }
      if (!this.state.git.activePath && paths[0]) {
        this.state.git.activePath = paths[0]
      }
    } catch (error) {
      if (!this.isCurrentGitDiffRequest(repoPath, repositoryGeneration, statusRequestId, diffRequestId)) {
        return
      }
      this.state.git.error = errorMessage(error)
    } finally {
      if (this.isCurrentGitDiffRequest(repoPath, repositoryGeneration, statusRequestId, diffRequestId)) {
        this.state.git.diffLoading = false
        this.renderGitPanel()
        const nextPath = this.pendingGitDiffPath
        if (nextPath
          && this.state.git.activePath === nextPath
          && !this.state.git.diffByPath[nextPath]
          && this.state.repoPath === repoPath
          && this.state.projectValid) {
          this.pendingGitDiffPath = null
          void this.loadGitDiff(repoPath, [nextPath], statusRequestId, repositoryGeneration)
        }
      }
    }
  }

  private setActiveGitFile(path: string): void {
    if (this.state.busy || this.state.git.busy || !this.state.git.files.some((file) => file.path === path)) {
      return
    }
    this.state.git.activePath = path
    this.renderGitPanel()
    if (this.state.git.diffByPath[path]) {
      this.pendingGitDiffPath = null
      return
    }
    if (this.state.git.diffLoading) {
      this.pendingGitDiffPath = path
      return
    }
    if (this.state.repoPath) {
      void this.loadGitDiff(this.state.repoPath, [path], this.gitStatusRequestId, this.repositoryGeneration)
    }
  }

  private updateGitSelection(paths: string[]): void {
    if (this.state.busy || this.state.git.busy) {
      return
    }
    this.state.git.selectedPaths = paths.filter((path, index) => paths.indexOf(path) === index)
    this.state.git.error = null
    this.renderGitPanel()
  }

  private toggleGitFile(path: string, selected: boolean): void {
    const paths = selected
      ? [...this.state.git.selectedPaths, path]
      : this.state.git.selectedPaths.filter((entry) => entry !== path)
    this.updateGitSelection(paths)
  }

  private selectAllGitFiles(): void {
    this.updateGitSelection(this.state.git.files.map((file) => file.path))
  }

  private selectNoGitFiles(): void {
    this.updateGitSelection([])
  }

  private async commitSelectedGitFiles(pushAfterCommit: boolean): Promise<void> {
    if (this.state.busy || this.state.git.busy) {
      return
    }
    const repoPath = this.state.repoPath
    const paths = [...this.state.git.selectedPaths]
    if (!repoPath || !this.state.projectValid) {
      this.state.git.error = 'Choose a repository first'
      this.renderGitPanel()
      return
    }
    if (paths.length === 0) {
      this.state.git.error = 'Select at least one file to commit'
      this.renderGitPanel()
      return
    }
    const gitBackend = this.backend as unknown as GitBackendClient
    const method = gitBackend.commitGitChanges ?? gitBackend.commitGit
    if (!method) {
      this.state.git.error = 'Not available in this build'
      this.renderGitPanel()
      return
    }
    const pushMethod = gitBackend.pushGit
    if (pushAfterCommit && !pushMethod) {
      this.state.git.error = 'Not available in this build'
      this.renderGitPanel()
      return
    }
    const selectedFiles = this.state.git.files.filter((file) => paths.includes(file.path))
    const message = this.state.git.commitMessage.trim() || defaultGitCommitMessage(selectedFiles)
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.gitOperationId
    this.state.busy = true
    this.state.git.busy = true
    this.state.git.error = null
    this.renderAll()
    let committed = false
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const commitResult = asGitCommitResult(await method(repoPath, paths, message))
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      committed = true
      let pushResult: GitPushResult | null = null
      if (pushAfterCommit && pushMethod) {
        pushResult = asGitPushResult(await pushMethod(repoPath))
      }
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.state.git.commitMessage = ''
      this.state.git.commitMessageEdited = false
      await this.refreshGitStatus(true)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.setMessage(
        gitResultToastMessage(paths.length, pushAfterCommit, commitResult, pushResult),
        'success',
      )
    } catch (error) {
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const failure = errorMessage(error)
      // Git may have staged paths before a commit failure. Refresh the view so
      // the user can see that mutation while retaining the original error.
      await this.refreshGitStatus(true)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.state.git.error = failure
      this.setMessage(
        committed && pushAfterCommit
          ? `Committed, but could not push: ${this.state.git.error}`
          : `Could not commit changes: ${this.state.git.error}`,
        'error',
      )
    } finally {
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.busy = false
        this.state.git.busy = false
        this.renderAll()
      }
    }
  }

  private async commitAndPushGitChanges(): Promise<void> {
    await this.commitSelectedGitFiles(true)
  }

  private renderGitPanel(): void {
    const panel = this.element<HTMLElement>('#git-panel')
    panel.hidden = this.state.bottomPanelTab !== 'git'
    const git = this.state.git
    this.element<HTMLElement>('#git-branch').textContent = git.branch ?? ''
    const count = this.element<HTMLElement>('#git-file-count')
    count.textContent = git.files.length > 0 ? String(git.files.length) : ''
    count.hidden = git.files.length === 0
    const status = this.element<HTMLElement>('#git-status')
    if (git.error) {
      status.hidden = false
      status.textContent = git.error
    } else {
      status.hidden = true
      status.textContent = ''
    }

    const list = this.element<HTMLElement>('#git-file-list')
    list.innerHTML = ''
    if (git.loading && git.files.length === 0) {
      const loading = document.createElement('div')
      loading.className = 'git-empty git-loading'
      loading.textContent = 'Loading…'
      list.append(loading)
    } else if (git.files.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'git-empty'
      empty.textContent = 'No changes'
      list.append(empty)
    } else {
      for (const file of git.files) {
        const row = document.createElement('div')
        row.className = 'git-file-row'
        row.classList.toggle('is-active', file.path === git.activePath)
        row.classList.toggle('is-selected', git.selectedPaths.includes(file.path))
        row.title = file.path
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.className = 'git-file-checkbox'
        checkbox.checked = git.selectedPaths.includes(file.path)
        checkbox.setAttribute('aria-label', `Select ${file.path} for commit`)
        checkbox.disabled = this.state.busy || git.busy || git.loading
        checkbox.addEventListener('change', () => {
          this.toggleGitFile(file.path, checkbox.checked)
        })
        const fileButton = document.createElement('button')
        fileButton.type = 'button'
        fileButton.className = 'git-file-button'
        fileButton.disabled = this.state.busy || git.busy
        fileButton.addEventListener('click', () => this.setActiveGitFile(file.path))
        const statusBadge = document.createElement('span')
        statusBadge.className = `git-file-status git-file-status-${normalizeGitStatusLabel(file.status)}`
        statusBadge.textContent = gitStatusGlyph(file.status)
        statusBadge.setAttribute('aria-label', file.status)
        const fileName = document.createElement('span')
        fileName.className = 'git-file-name'
        fileName.textContent = gitFileName(file.path)
        fileButton.append(statusBadge, fileName)
        const dirPath = gitDirectoryPath(file.path)
        if (dirPath) {
          const filePath = document.createElement('span')
          filePath.className = 'git-file-path'
          // The LRM guards keep punctuation from flipping when direction:rtl
          // is used to ellipsize the head of the path instead of the tail.
          filePath.textContent = `‎${dirPath}‎`
          filePath.title = dirPath
          fileButton.append(filePath)
        }
        const stats = document.createElement('span')
        stats.className = 'git-file-stats'
        if (file.additions !== null) {
          const additions = document.createElement('span')
          additions.className = 'git-additions'
          additions.textContent = `+${file.additions}`
          stats.append(additions)
        }
        if (file.deletions !== null) {
          const deletions = document.createElement('span')
          deletions.className = 'git-deletions'
          deletions.textContent = `−${file.deletions}`
          stats.append(deletions)
        }
        fileButton.append(stats)
        row.append(checkbox, fileButton)
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          this.openGitContextMenu(file, event.clientX, event.clientY)
        })
        list.append(row)
      }
    }

    const activeFile = git.files.find((file) => file.path === git.activePath)
    const diffFile = this.element<HTMLElement>('#git-diff-file')
    diffFile.textContent = activeFile ? gitFileName(activeFile.path) : 'Select a file'
    if (activeFile) {
      diffFile.title = activeFile.path
    } else {
      diffFile.removeAttribute('title')
    }
    const diffState = this.element<HTMLElement>('#git-diff-state')
    diffState.textContent = activeFile ? normalizeGitStatusLabel(activeFile.status) : ''
    diffState.hidden = !activeFile
    const diff = this.element<HTMLElement>('#git-diff')
    diff.innerHTML = ''
    if (git.diffLoading && activeFile && !git.diffByPath[activeFile.path]) {
      const loading = document.createElement('div')
      loading.className = 'git-empty git-loading'
      loading.textContent = 'Loading…'
      diff.append(loading)
    } else if (activeFile) {
      const text = git.diffByPath[activeFile.path] ?? ''
      if (text) {
        diff.append(renderUnifiedDiff(text))
      } else {
        const empty = document.createElement('div')
        empty.className = 'git-empty'
        empty.textContent = 'No diff available'
        diff.append(empty)
      }
    } else {
      const empty = document.createElement('div')
      empty.className = 'git-empty'
      empty.textContent = git.files.length === 0 ? 'No changes' : 'Select a file'
      diff.append(empty)
    }

    const input = this.element<HTMLInputElement>('#git-commit-message')
    if (input.value !== git.commitMessage) {
      input.value = git.commitMessage
    }
    this.updateGitCommitControls()
    this.applyGitFileListWidth()
    this.renderGitContextMenu()
  }

  /**
   * Commit-bar enablement plus the computed placeholder. Kept separate from
   * renderGitPanel so typing in the message input never rebuilds the panel
   * (a rebuild would fight the caret).
   */
  private updateGitCommitControls(): void {
    const git = this.state.git
    const selectedFiles = git.files.filter((file) => git.selectedPaths.includes(file.path))
    const input = this.element<HTMLInputElement>('#git-commit-message')
    input.placeholder = defaultGitCommitMessage(selectedFiles)
    input.disabled = this.state.busy || git.busy || git.files.length === 0
    const commitDisabled = this.state.busy || git.busy || git.loading || git.selectedPaths.length === 0
    this.element<HTMLButtonElement>('#git-commit').disabled = commitDisabled
    this.element<HTMLButtonElement>('#git-commit-push').disabled = commitDisabled
    this.element<HTMLButtonElement>('#git-select-all').disabled = this.state.busy || git.busy || git.loading || git.files.length === 0
    this.element<HTMLButtonElement>('#git-select-none').disabled = this.state.busy || git.busy || git.loading || git.selectedPaths.length === 0
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

  /** Update tab selection and the active tab's dirty marker without rebuilding tabs. */
  private updateFileTabState(): void {
    const list = this.element<HTMLElement>('#file-tabs')
    const items = Array.from(list.querySelectorAll<HTMLElement>('.file-tab'))
    if (items.length !== this.state.openTabs.length) {
      this.renderFileTabs()
      return
    }
    const activeChanged = this.renderedFileTabsActiveId !== this.state.activeTabId
    const itemsById = new Map(items.map((item) => [item.dataset.tabId ?? '', item]))
    for (const tab of this.state.openTabs) {
      const item = itemsById.get(String(tab.id))
      const tabButton = item?.querySelector<HTMLButtonElement>('[role="tab"]')
      if (!item || !tabButton) {
        this.renderFileTabs()
        return
      }
      const active = tab.id === this.state.activeTabId
      item.classList.toggle('is-active', active)
      tabButton.setAttribute('aria-selected', String(active))
      tabButton.tabIndex = active ? 0 : -1
      const dirty = active && (this.state.dirty || this.autosave.hasPendingChanges)
      const dirtyMarker = item.querySelector<HTMLElement>('.file-tab-dirty')
      if (dirty && !dirtyMarker) {
        const marker = document.createElement('span')
        marker.className = 'file-tab-dirty'
        marker.setAttribute('aria-label', 'Unsaved changes')
        tabButton.append(marker)
      } else if (!dirty && dirtyMarker) {
        dirtyMarker.remove()
      }
      item.classList.toggle('is-dirty', dirty)
    }
    this.renderedFileTabsActiveId = this.state.activeTabId
    if (activeChanged && this.state.activeTabId !== null) {
      this.scheduleActiveFileTabReveal(this.state.activeTabId)
    }
  }

  private renderAll(): void {
    this.cancelScheduledLiveRender()
    this.applyBottomPanelHeight()
    this.applySidebarWidth()
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
    this.scheduleGitRefreshIfNeeded()
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
    const header = this.element<HTMLElement>('#daily-header')
    const description = this.element<HTMLElement>('#daily-description')
    const resizeHandle = this.element<HTMLElement>('#daily-description-resize-handle')
    const activeElement = document.activeElement
    const focusedLookup = activeElement instanceof HTMLInputElement
      && activeElement.classList.contains('problem-lookup-input')
      && header.contains(activeElement)
    const lookupInput = focusedLookup ? activeElement : null
    const lookupSelectionStart = lookupInput?.selectionStart ?? null
    const lookupSelectionEnd = lookupInput?.selectionEnd ?? null
    header.innerHTML = ''
    const problem = this.state.dailyProblem

    header.append(this.renderProblemLookup(problem))
    if (focusedLookup) {
      const input = header.querySelector<HTMLInputElement>('.problem-lookup-input')
      if (input) {
        input.focus()
        if (lookupSelectionStart !== null && lookupSelectionEnd !== null) {
          input.setSelectionRange(lookupSelectionStart, lookupSelectionEnd)
        }
      }
    }

    if (!problem) {
      description.hidden = true
      resizeHandle.hidden = true
      this.applyDailyDescriptionHeight()
      if (this.state.dailyLoading) {
        header.append(this.renderDailySkeleton())
      } else if (this.state.dailyError) {
        header.append(this.renderDailyError())
      } else {
        const waiting = document.createElement('span')
        waiting.className = 'daily-waiting'
        waiting.textContent = 'Waiting for today’s problem…'
        header.append(waiting)
      }
      return
    }

    const title = document.createElement('strong')
    title.className = 'problem-title'
    title.textContent = problem.title
    title.title = problem.title
    const difficulty = document.createElement('span')
    difficulty.className = `difficulty difficulty-${problem.difficulty.toLowerCase()}`
    difficulty.textContent = problem.difficulty
    const viewingToday = this.isViewingTodayProblem(problem)
    const today = document.createElement(viewingToday ? 'span' : 'button')
    today.className = viewingToday ? 'daily-today-status' : 'secondary-button daily-today'
    if (viewingToday) {
      today.setAttribute('aria-label', 'Today’s problem')
      today.append(iconFor('calendarDays', 'button-icon'))
      today.append(document.createTextNode('Today’s problem'))
    } else {
      const todayButton = today as HTMLButtonElement
      todayButton.type = 'button'
      todayButton.title = 'Show today’s problem'
      todayButton.setAttribute('aria-label', 'Back to today')
      todayButton.disabled = this.state.busy || this.state.dailyLoading
      todayButton.append(iconFor('calendarDays', 'button-icon'))
      todayButton.append(document.createTextNode('Back to today'))
      todayButton.addEventListener('click', () => {
        this.problemNumberDraft = null
        this.state.problemSelection = 'daily'
        this.state.dailyProblemDateKey = null
        void this.loadDailyProblem(true)
      })
    }
    const actions = document.createElement('div')
    actions.className = 'daily-actions'

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'icon-button'
    const refreshLabel = this.state.problemSelection === 'manual'
      ? 'Refresh selected problem'
      : 'Refresh today’s problem'
    refresh.setAttribute('aria-label', refreshLabel)
    refresh.title = refreshLabel
    refresh.append(iconFor('refresh', 'button-icon'))
    refresh.disabled = this.state.busy || this.state.dailyLoading
    refresh.classList.toggle('is-spinning', this.state.dailyLoading)
    refresh.addEventListener('click', () => {
      this.refreshSelectedProblem()
    })
    actions.append(refresh)

    const link = document.createElement('a')
    link.className = 'icon-button'
    link.href = problem.url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.setAttribute('aria-label', 'Open on LeetCode')
    link.title = 'Open on LeetCode'
    link.append(iconFor('externalLink', 'button-icon'))
    actions.append(link)

    const hasContent = Boolean(problem.content && problem.content.trim().length > 0)
    if (hasContent) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'icon-button daily-description-toggle'
      toggle.setAttribute('aria-label', 'Toggle problem description')
      toggle.setAttribute('aria-expanded', String(this.dailyDescriptionOpen))
      toggle.setAttribute('aria-controls', 'daily-description')
      toggle.title = 'Description'
      toggle.append(iconFor('bookOpen', 'button-icon'))
      toggle.classList.toggle('is-active', this.dailyDescriptionOpen)
      toggle.addEventListener('click', () => {
        this.dailyDescriptionOpen = !this.dailyDescriptionOpen
        this.storage?.setItem(DAILY_DESCRIPTION_KEY, this.dailyDescriptionOpen ? 'open' : 'closed')
        this.renderDailyProblem()
      })
      actions.append(toggle)
    }

    const existingFile = findTodayProblemFile(this.state.files, problem)
    const primary = document.createElement('button')
    primary.type = 'button'
    primary.className = 'primary-button daily-primary'
    primary.textContent = existingFile ? 'Open file' : 'Create file'
    if (!this.state.projectValid) {
      primary.disabled = true
      primary.title = 'Choose a repository first'
    } else {
      primary.disabled = this.state.busy
    }
    primary.addEventListener('click', () => {
      if (existingFile) {
        void this.openFile(existingFile)
      } else {
        void this.createFileForToday()
      }
    })
    actions.append(primary)
    header.append(title, difficulty, today, actions)

    if (hasContent && this.dailyDescriptionOpen) {
      description.hidden = false
      this.renderDailyDescription(description, problem.content ?? '')
      resizeHandle.hidden = false
      this.applyDailyDescriptionHeight()
    } else {
      description.hidden = true
      resizeHandle.hidden = true
      this.applyDailyDescriptionHeight()
    }
  }

  private renderProblemLookup(problem: DailyProblem | null): HTMLElement {
    const form = document.createElement('form')
    form.className = 'problem-lookup'
    form.setAttribute('aria-label', 'Load a LeetCode problem by number')

    const field = document.createElement('label')
    field.className = 'problem-lookup-field'
    field.title = 'Load a LeetCode problem by number'
    const prefix = document.createElement('span')
    prefix.className = 'problem-lookup-prefix'
    prefix.textContent = '#'
    prefix.setAttribute('aria-hidden', 'true')
    const input = document.createElement('input')
    input.className = 'problem-lookup-input'
    input.type = 'text'
    input.inputMode = 'numeric'
    input.pattern = '[0-9]*'
    input.placeholder = 'number'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.value = this.problemNumberDraft ?? problem?.frontendId ?? ''
    input.setAttribute('aria-label', 'LeetCode problem number')
    input.addEventListener('input', () => {
      this.problemNumberDraft = input.value
    })
    input.addEventListener('focus', () => {
      input.select()
    })
    field.append(prefix, input)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'icon-button problem-lookup-submit'
    submit.setAttribute('aria-label', 'Load problem')
    submit.title = 'Load problem'
    submit.append(iconFor('arrowRight', 'button-icon'))
    submit.disabled = this.state.busy || this.state.dailyLoading
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.loadProblemByNumber(input.value)
    })

    form.append(field, submit)
    return form
  }

  private renderDailySkeleton(): HTMLElement {
    const skeleton = document.createElement('div')
    skeleton.className = 'daily-skeleton'
    skeleton.setAttribute('aria-label', 'Loading today’s problem')
    skeleton.setAttribute('role', 'progressbar')
    skeleton.setAttribute('aria-busy', 'true')
    for (const width of ['48px', '220px', '52px']) {
      const bar = document.createElement('span')
      bar.className = 'skeleton-bar'
      bar.style.width = width
      skeleton.append(bar)
    }
    return skeleton
  }

  private renderDailyError(): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'daily-error'
    const message = document.createElement('span')
    message.className = 'daily-error-copy'
    message.textContent = 'Couldn’t load this problem'
    if (this.state.dailyError) {
      message.title = this.state.dailyError
    }
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'text-button'
    retry.textContent = 'Retry'
    retry.disabled = this.state.dailyLoading
    retry.addEventListener('click', () => {
      if (this.lastProblemRequest === 'manual') {
        void this.loadProblemByNumber(this.problemNumberDraft ?? '')
      } else {
        void this.loadDailyProblem(true)
      }
    })
    wrapper.append(message, retry)
    return wrapper
  }

  private renderDailyDescription(container: HTMLElement, content: string): void {
    // Sanitizing rebuilds a DOM tree; cache it so toggling or unrelated
    // rerenders do not re-parse the same HTML payload.
    if (this.sanitizedDescriptionSource !== content || !this.sanitizedDescriptionElement) {
      const body = document.createElement('div')
      body.className = 'daily-description-body'
      body.append(sanitizeProblemHtml(content))
      this.sanitizedDescriptionSource = content
      this.sanitizedDescriptionElement = body
    }
    if (this.sanitizedDescriptionElement.parentElement !== container) {
      container.innerHTML = ''
      container.append(this.sanitizedDescriptionElement)
    }
  }

  private renderFileTabs(): void {
    const list = this.element<HTMLElement>('#file-tabs')
    const activeChanged = this.renderedFileTabsActiveId !== this.state.activeTabId
    this.renderedFileTabsActiveId = this.state.activeTabId
    list.innerHTML = ''
    for (const tab of this.state.openTabs) {
      const item = document.createElement('div')
      item.className = 'file-tab'
      item.setAttribute('role', 'presentation')
      item.dataset.tabId = String(tab.id)

      const tabButton = document.createElement('button')
      tabButton.type = 'button'
      tabButton.className = 'file-tab-button'
      tabButton.setAttribute('role', 'tab')
      const active = tab.id === this.state.activeTabId
      item.classList.toggle('is-active', active)
      tabButton.setAttribute('aria-selected', String(active))
      tabButton.setAttribute('aria-controls', 'editor-host')
      tabButton.tabIndex = active ? 0 : -1
      tabButton.title = tab.path

      const label = document.createElement('span')
      label.className = 'file-tab-label'
      label.textContent = tab.name.replace(/\.java$/i, '')
      tabButton.append(label)
      tabButton.setAttribute('aria-label', tab.name)

      if (active && (this.state.dirty || this.autosave.hasPendingChanges)) {
        const dirty = document.createElement('span')
        dirty.className = 'file-tab-dirty'
        dirty.setAttribute('aria-label', 'Unsaved changes')
        tabButton.append(dirty)
        item.classList.add('is-dirty')
      }

      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'file-tab-close'
      close.setAttribute('aria-label', `Close ${tab.name}`)
      close.title = `Close ${tab.name}`
      close.textContent = '×'
      close.disabled = this.state.busy
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        void this.closeOpenTab(tab.id)
      })
      close.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        void this.closeOpenTab(tab.id)
      })

      tabButton.addEventListener('click', () => {
        void this.openTab(tab.id)
      })
      tabButton.addEventListener('keydown', (event) => {
        const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const currentIndex = tabs.indexOf(tabButton)
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void this.openTab(tab.id)
          return
        }
        if (currentIndex < 0 || tabs.length === 0) {
          return
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          return
        }
        event.preventDefault()
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : Math.max(0, Math.min(
              tabs.length - 1,
              currentIndex + (event.key === 'ArrowLeft' ? -1 : 1),
            ))
        tabs[nextIndex].focus()
      })
      item.append(tabButton, close)
      list.append(item)
    }
    if (activeChanged && this.state.activeTabId !== null) {
      this.scheduleActiveFileTabReveal(this.state.activeTabId)
    }
  }

  private scheduleActiveFileTabReveal(tabId: number): void {
    const reveal = (): void => {
      if (this.state.activeTabId !== tabId) {
        return
      }
      const list = this.element<HTMLElement>('#file-tabs')
      const item = Array.from(list.querySelectorAll<HTMLElement>('.file-tab'))
        .find((entry) => entry.dataset.tabId === String(tabId))
      item?.querySelector<HTMLElement>('[role="tab"]')?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      })
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(reveal)
    } else {
      queueMicrotask(reveal)
    }
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
    const list = this.element<HTMLElement>('#file-list')
    list.innerHTML = ''
    const searchInput = this.element<HTMLInputElement>('#file-search')
    if (searchInput.value !== this.state.fileSearch) {
      searchInput.value = this.state.fileSearch
    }
    const totalCount = this.element<HTMLElement>('#file-count')
    if (!this.state.projectValid) {
      totalCount.textContent = ''
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'Choose a repository to see problems'
      list.append(empty)
      return
    }

    const searchTerm = this.state.fileSearch.trim()
    const javaFiles = this.state.files.filter((file) => /\.java$/i.test(file.path))
    totalCount.textContent = javaFiles.length > 0 ? String(javaFiles.length) : ''
    const filteredFiles = filterProblemFiles(javaFiles, searchTerm)
    if (searchTerm && filteredFiles.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'No matches'
      list.append(empty)
      return
    }

    const groups = [...FILE_GROUPS, OTHER_GROUP]
    const grouped = groups.map((group) => ({
      group,
      files: filterProblemFilesByGroup(javaFiles, group.key, searchTerm),
    }))
    const anyFiles = grouped.some((entry) => entry.files.length > 0)

    for (const { group, files } of grouped) {
      // Hide empty groups; when the repository has no files at all, still show
      // the difficulty skeleton so the structure reads at a glance. The Other
      // bucket only ever appears when it has files.
      if (files.length === 0 && (anyFiles || group.key === 'other')) {
        continue
      }
      const section = document.createElement('section')
      section.className = 'file-group'
      const expanded = this.expandedGroups.has(group.key)
      section.dataset.expanded = String(expanded)

      const headingButton = document.createElement('button')
      headingButton.type = 'button'
      headingButton.className = 'file-group-toggle'
      headingButton.setAttribute('aria-expanded', String(expanded))
      headingButton.setAttribute('aria-controls', `file-group-${group.key}`)
      const groupLabel = document.createElement('span')
      groupLabel.className = 'file-group-label'
      groupLabel.append(
        iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'),
        createGroupDot(group.key),
        document.createTextNode(group.label),
      )
      const count = document.createElement('span')
      count.className = 'file-count'
      count.textContent = String(files.length)
      headingButton.append(groupLabel, count)
      headingButton.addEventListener('click', () => {
        const nextExpanded = !this.expandedGroups.has(group.key)
        this.setExpandedGroup(group.key, nextExpanded)
        // Re-render all groups so a newly opened group closes the previously
        // expanded group in both state and DOM. This also keeps the active row
        // scroll target in the newly visible viewport.
        this.renderFiles()
      })
      section.append(headingButton)
      const groupList = document.createElement('div')
      groupList.className = 'file-group-list'
      groupList.id = `file-group-${group.key}`
      groupList.hidden = !expanded
      for (const file of files) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'file-item'
        const active = sameFilePath(file.path, this.state.selectedPath ?? '')
        button.classList.toggle('is-active', active)
        button.classList.toggle('is-open', this.openTabForPath(file.path) !== null)
        if (active) {
          button.setAttribute('aria-current', 'page')
        }
        button.disabled = this.state.busy
        button.setAttribute('aria-haspopup', 'menu')
        button.dataset.path = file.path
        button.title = file.path
        const fileName = document.createElement('span')
        fileName.className = 'file-item-name'
        fileName.textContent = file.name.replace(/\.java$/i, '')
        button.append(fileName)
        button.addEventListener('click', () => {
          void this.openFile(file)
        })
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          this.openFileContextMenu(file, event.clientX, event.clientY)
        })
        groupList.append(button)
      }
      if (files.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'group-empty'
        empty.textContent = 'No files yet'
        groupList.append(empty)
      }
      section.append(groupList)
      list.append(section)
    }

    this.scrollActiveFileIntoView()
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
    const menu = this.root.querySelector<HTMLElement>('#app-menu')
    const button = this.root.querySelector<HTMLButtonElement>('#app-menu-button')
    const update = this.root.querySelector<HTMLButtonElement>('#update-menu-action')
    const settings = this.root.querySelector<HTMLButtonElement>('#settings-menu-action')
    const settingsShortcut = this.root.querySelector<HTMLElement>('#settings-menu-shortcut')
    if (!menu || !button || !update) {
      return
    }
    menu.hidden = !this.appMenuOpen
    button.setAttribute('aria-expanded', String(this.appMenuOpen))
    update.hidden = !this.updateAvailable
    update.disabled = this.updateBusy
    update.setAttribute('aria-busy', String(this.updateBusy))
    if (settings && settingsShortcut) {
      const label = shortcutLabel('open-settings', currentIsMacPlatform())
      settingsShortcut.textContent = label
      settings.title = `Open Settings (${label})`
      settings.setAttribute('aria-label', `Settings (${label})`)
    }
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
    const dialog = this.root.querySelector<HTMLElement>('#about-dialog')
    if (dialog) {
      dialog.hidden = !this.aboutDialogOpen
    }
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
    const dialog = this.root.querySelector<HTMLElement>('#settings-dialog')
    if (!dialog) {
      return
    }
    dialog.hidden = !this.settingsDialogOpen
    const appearanceNav = this.element<HTMLButtonElement>('#settings-appearance-nav')
    const keymapNav = this.element<HTMLButtonElement>('#settings-keymap-nav')
    const appearancePanel = this.element<HTMLElement>('#settings-appearance-panel')
    const keymapPanel = this.element<HTMLElement>('#settings-keymap-panel')
    const appearanceSelected = this.settingsSection === 'appearance'
    for (const [tab, selected] of [[appearanceNav, appearanceSelected], [keymapNav, !appearanceSelected]] as const) {
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    appearancePanel.hidden = !appearanceSelected
    keymapPanel.hidden = appearanceSelected
    const linuxTab = this.element<HTMLButtonElement>('#shortcuts-linux-tab')
    const macosTab = this.element<HTMLButtonElement>('#shortcuts-macos-tab')
    const mac = this.shortcutsPlatform === 'macos'
    for (const [tab, selected] of [[linuxTab, !mac], [macosTab, mac]] as const) {
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    const body = this.element<HTMLElement>('#shortcuts-body')
    body.setAttribute('aria-labelledby', mac ? 'shortcuts-macos-tab' : 'shortcuts-linux-tab')
    body.innerHTML = ''
    keymapPanel.classList.toggle('is-macos', mac)
    this.root.querySelectorAll<HTMLInputElement>('#settings-form input[name="theme-mode"]').forEach((input) => {
      input.checked = input.value === this.themeMode
    })
    for (const section of SHORTCUT_SECTIONS) {
      const group = document.createElement('section')
      group.className = 'shortcuts-group'
      const heading = document.createElement('h3')
      heading.className = 'shortcuts-group-title'
      heading.textContent = section.title
      group.append(heading)
      const list = document.createElement('dl')
      list.className = 'shortcuts-list'
      for (const entry of section.entries) {
        const keys = document.createElement('dt')
        keys.className = 'shortcuts-keys'
        for (const [index, binding] of platformBindings(entry, mac).entries()) {
          if (index > 0) {
            keys.append(document.createTextNode(' / '))
          }
          const key = document.createElement('kbd')
          const label = formatShortcut(binding, mac)
          const displayLabel = mac ? macShortcutDialogLabel(binding, label) : label
          key.textContent = displayLabel
          key.setAttribute('aria-label', displayLabel)
          key.title = displayLabel
          keys.append(key)
        }
        const description = document.createElement('dd')
        description.className = 'shortcuts-description'
        description.textContent = entry.description
        list.append(keys, description)
      }
      group.append(list)
      body.append(group)
    }
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
    const dialog = this.element<HTMLElement>('#discard-git-dialog')
    const file = this.gitDiscardDialogFile
    dialog.hidden = !file
    if (!file) {
      this.element<HTMLElement>('#discard-git-path').textContent = ''
      this.element<HTMLElement>('#discard-git-message').textContent = ''
      return
    }
    this.element<HTMLElement>('#discard-git-path').textContent = file.path
    this.element<HTMLElement>('#discard-git-message').textContent = discardGitChangesWarningMessage()
    this.element<HTMLButtonElement>('#confirm-discard-git').disabled = this.state.busy || this.state.git.busy
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
    const dialog = this.element<HTMLElement>('#delete-file-dialog')
    const file = this.deleteDialogFile
    dialog.hidden = !file
    this.element<HTMLElement>('#delete-file-name').textContent = file?.name ?? ''
    this.element<HTMLButtonElement>('#confirm-delete-file').disabled = this.state.busy
  }

  private renderContextMenu(): void {
    const menu = this.element<HTMLElement>('#file-context-menu')
    const context = this.state.contextMenu
    if (!context) {
      menu.hidden = true
      return
    }
    const width = FILE_CONTEXT_MENU_WIDTH
    const height = FILE_CONTEXT_MENU_HEIGHT
    const margin = VIEWPORT_MARGIN
    const viewportWidth = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1000
    const viewportHeight = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800
    menu.style.left = `${Math.max(margin, Math.min(context.x, viewportWidth - width - margin))}px`
    menu.style.top = `${Math.max(margin, Math.min(context.y, viewportHeight - height - margin))}px`
    menu.hidden = false
    // Keep the menu action labels compact. The confirmation dialog below
    // contains the target filename, while the context menu exposes the
    // available file operations.
    this.element<HTMLElement>('#duplicate-file-label').textContent = 'Duplicate'
    this.element<HTMLElement>('#rename-file-label').textContent = 'Rename'
    this.element<HTMLElement>('#delete-file-label').textContent = 'Delete'
    this.element<HTMLButtonElement>('#duplicate-file-action').disabled = this.state.busy
    this.element<HTMLButtonElement>('#rename-file-action').disabled = this.state.busy
    this.element<HTMLButtonElement>('#delete-file-action').disabled = this.state.busy
  }

  private renderGitContextMenu(): void {
    const menu = this.element<HTMLElement>('#git-context-menu')
    const context = this.state.gitContextMenu
    const fileStillChanged = context
      && this.state.git.files.some((file) => sameFilePath(file.path, context.file.path))
    if (!context || !fileStillChanged) {
      menu.hidden = true
      return
    }
    const position = clampContextMenuPosition(
      context.x,
      context.y,
      GIT_CONTEXT_MENU_WIDTH,
      GIT_CONTEXT_MENU_HEIGHT,
    )
    menu.style.left = `${position.x}px`
    menu.style.top = `${position.y}px`
    menu.hidden = false
    const disabled = this.state.busy || this.state.git.busy || this.state.git.loading
    this.element<HTMLButtonElement>('#git-discard-action').disabled = disabled
    this.element<HTMLButtonElement>('#git-show-file-action').disabled = disabled
  }

  private async showGitFileInManager(): Promise<void> {
    const context = this.state.gitContextMenu
    const repoPath = this.state.repoPath
    if (!context || !repoPath || !this.state.projectValid || this.state.busy || this.state.git.busy) {
      return
    }
    const method = (this.backend as unknown as GitBackendClient).showInFileManager
    if (!method) {
      this.closeGitContextMenu()
      this.setMessage('Not available in this build', 'error')
      return
    }
    const filePath = context.file.path
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.gitOperationId
    this.closeGitContextMenu()
    this.state.git.busy = true
    this.renderAll()
    try {
      await method(repoPath, filePath)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.setMessage(`Opened ${gitFileName(filePath)} in File Manager.`, 'success')
    } catch (error) {
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        this.setMessage(`Could not show ${gitFileName(filePath)} in File Manager: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.git.busy = false
        this.renderAll()
      }
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
    const method = (this.backend as unknown as GitBackendClient).discardGitChanges
    if (!method) {
      this.setMessage('Not available in this build', 'error')
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
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.gitOperationId
    this.closeGitContextMenu()
    this.state.busy = true
    this.state.git.busy = true
    this.gitDiscardInProgress = true
    this.renderAll()
    try {
      // Flush the current editor before the destructive backend operation so
      // the discard command always starts from a stable on-disk snapshot.
      if (!(await this.flushPendingSave())
        || !this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      // The flush above drains the current timer/run. Do not let a queued
      // autosave write the pre-discard source back after Git restores it.
      this.autosave.cancelPending()
      await method(repoPath, filePath)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
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
        if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.state.selectedSource = source
        this.state.savedSource = source
        this.state.dirty = false
        this.state.saveError = null
        this.clearSavedFlash()
        this.resetTestState()
        this.suppressEditorChange = true
        try {
          this.editor.setValue(source)
        } finally {
          this.suppressEditorChange = false
        }
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      }

      this.markGitStale()
      await this.refreshFiles()
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
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
        if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.state.selectedSource = source
        this.state.savedSource = source
        this.state.dirty = false
        this.state.saveError = null
        this.clearSavedFlash()
        this.resetTestState()
        this.suppressEditorChange = true
        try {
          this.editor.setValue(source)
        } finally {
          this.suppressEditorChange = false
        }
        this.element<HTMLElement>('#editor-host').dataset.savedSource = source
      }
      await this.refreshGitStatus(true)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
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
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        // Refresh both views even when the backend reports an error: a Git
        // command can have changed the worktree before surfacing its failure.
        await this.refreshFiles()
        await this.refreshGitStatus(true)
        if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.setMessage(`Could not discard changes to ${gitFileName(filePath)}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.gitDiscardInProgress = false
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        this.state.busy = false
        this.state.git.busy = false
        this.renderAll()
      }
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
      this.markGitStale()
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
      this.markGitStale()
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
      this.markGitStale()
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
    const selectedFile = this.element<HTMLElement>('#selected-file')
    const file = this.state.files.find((entry) => sameFilePath(entry.path, this.state.selectedPath ?? ''))
    selectedFile.textContent = file?.name ?? ''
    const saveStatus = this.element<HTMLElement>('#save-status')
    saveStatus.className = 'save-status'
    saveStatus.innerHTML = ''
    saveStatus.removeAttribute('title')
    if (!this.state.selectedPath) {
      this.element<HTMLElement>('#editor-host').dataset.savedSource = this.state.savedSource
      return
    }
    if (this.state.saveError) {
      saveStatus.classList.add('is-error')
      saveStatus.textContent = 'Save failed'
      saveStatus.title = this.state.saveError
    } else if (this.saveWriteInFlight) {
      saveStatus.classList.add('is-saving')
      saveStatus.textContent = 'Saving…'
    } else if (this.state.dirty || this.autosave.hasPendingChanges) {
      saveStatus.classList.add('is-unsaved')
      const dot = document.createElement('span')
      dot.className = 'save-dot'
      dot.setAttribute('aria-hidden', 'true')
      saveStatus.append(dot, document.createTextNode('Unsaved'))
      saveStatus.title = `Saves automatically · ${shortcutLabel('save', currentIsMacPlatform())}`
    } else if (this.savedFlash) {
      saveStatus.classList.add('is-saved')
      saveStatus.textContent = 'Saved'
    }
    this.element<HTMLElement>('#editor-host').dataset.savedSource = this.state.savedSource
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
        onSelectTest: (key, focus) => this.selectTestResult(key, focus),
        onRevealLocation: (line, column) => this.editor.revealLine(line, column),
      },
    )
    if (output.selectedTestKey !== this.state.selectedTestKey) {
      this.state.selectedTestKey = output.selectedTestKey
      this.testSelectionExplicit = false
    }
  }

  private selectTestResult(key: string, focus = false): void {
    const nextKey = key === TEST_RUN_ROOT_KEY ? null : key
    this.testSelectionExplicit = true
    if (this.state.selectedTestKey === nextKey) {
      return
    }
    this.state.selectedTestKey = nextKey
    this.renderResult()
    if (focus) {
      const item = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.test-tree-item'))
        .find((entry) => entry.dataset.testKey === key)
      item?.focus()
    }
  }

  private autoSelectFailedTest(result: TestResult): void {
    this.state.selectedTestKey = autoSelectedTestKey(
      result.tests,
      this.state.selectedTestKey,
      this.testSelectionExplicit,
    )
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

/** The 6px colored difficulty dot in a sidebar group heading. */
function createGroupDot(groupKey: ProblemFileEntry['packageSegment']): HTMLElement {
  const dot = document.createElement('span')
  dot.className = 'group-dot group-dot-' + groupKey
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

function currentIsMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return isMacPlatform(navigator.platform, navigator.userAgent)
}

function renderUnifiedDiff(diff: string): HTMLElement {
  const fragment = document.createDocumentFragment()
  for (const parsedLine of parseUnifiedDiffLines(diff)) {
    const row = document.createElement('div')
    row.className = `git-diff-line is-${parsedLine.kind}`
    const oldNumber = document.createElement('span')
    oldNumber.className = 'git-diff-line-number git-diff-old-line'
    const newNumber = document.createElement('span')
    newNumber.className = 'git-diff-line-number git-diff-new-line'
    const marker = document.createElement('span')
    marker.className = 'git-diff-line-marker'
    marker.textContent = parsedLine.marker
    marker.setAttribute('aria-hidden', 'true')
    const content = document.createElement('code')
    content.className = 'git-diff-line-content'
    // textContent is deliberate: source text must never be interpreted as
    // markup, and an empty code node still reserves the row's line height.
    content.textContent = parsedLine.content
    if (parsedLine.oldLine !== null) {
      oldNumber.textContent = String(parsedLine.oldLine)
    }
    if (parsedLine.newLine !== null) {
      newNumber.textContent = String(parsedLine.newLine)
    }
    row.append(oldNumber, newNumber, marker, content)
    fragment.append(row)
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'git-diff-lines'
  wrapper.append(fragment)
  return wrapper
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

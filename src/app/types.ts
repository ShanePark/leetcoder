import type {
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitPushResult,
  ProblemDiagnostic,
  ProblemFileEntry,
  RepositoryFilesChanged,
  TestCaseResult,
  TestDiagnostic,
  TestPhase,
  TestResult,
  TestRunProgress,
} from '../backend'

export type ThemeMode = 'system' | 'dark' | 'light'
export type ShortcutPlatform = 'linux' | 'macos'
export type SettingsSection = 'appearance' | 'keymap'

export type DirectoryPicker = () => Promise<string | null>

export interface AppOptions {
  backend?: BackendClient
  directoryPicker?: DirectoryPicker
  storage?: Storage
  /** Request a native window close through the close-safety handler. */
  requestClose?: () => Promise<void>
}

export interface AutosaveSnapshot {
  repoPath: string
  filePath: string
  source: string
}

export type AutosaveStatus = 'idle' | 'saving' | 'error'

export interface AutosaveCoordinatorOptions {
  delayMs?: number
  onStatusChange?: (status: AutosaveStatus) => void
  onError?: (error: unknown) => void
}

export interface TestResultPresentation {
  phaseLabel: string
  statusLabel: string
  failureMessage: string | null
  rawLogsOpen: boolean
}

export type TestRunStatus = 'running' | 'completed' | 'error'

export interface TestRunSnapshot {
  id: number
  status: TestRunStatus
  phase: TestPhase
  startedAt: number
  tests: TestCaseResult[]
  stdout: string
  stderr: string
  activeTest: TestCaseResult | null
  error: string | null
  testMethod: string | null
}

export interface TestRunSourceSnapshot {
  repoPath: string
  filePath: string
  source: string
}

export interface CurrentTestSource {
  repoPath: string | null
  filePath: string | null
  source: string
}

/** A normalized working-tree entry used by the Git tab. */
export interface GitChangedFile {
  path: string
  status: string
  staged: boolean
  additions: number | null
  deletions: number | null
  originalPath?: string | null
}

export interface GitStatusSnapshot {
  branch: string | null
  files: GitChangedFile[]
}

/** Optional Git methods supported by the desktop bridge. */
export interface GitBackendClient {
  getGitStatus?: (projectRoot: string) => Promise<unknown>
  listGitChanges?: (projectRoot: string) => Promise<unknown>
  getGitDiff?: (projectRoot: string, paths: string[]) => Promise<unknown>
  discardGitChanges?: (projectRoot: string, path: string) => Promise<void>
  showInFileManager?: (projectRoot: string, path: string) => Promise<void>
  commitGitChanges?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  commitGit?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  pushGit?: (projectRoot: string) => Promise<unknown>
}

export interface TestRunnerBackend {
  runProblemTest: (
    projectRoot: string,
    fullyQualifiedClassName: string,
    onProgress?: (progress: TestRunProgress) => void,
    testMethod?: string,
  ) => Promise<TestResult>
}

export interface LiveDiagnosticsBackend {
  checkProblemDiagnostics?: (
    projectRoot: string,
    fullyQualifiedClassName: string,
    source: string,
  ) => Promise<readonly ProblemDiagnostic[]>
}

export interface FileManagementBackend {
  deleteProblemFile?: (projectRoot: string, path: string) => Promise<unknown>
  duplicateProblemFile?: (projectRoot: string, path: string) => Promise<unknown>
  renameProblemFile?: (projectRoot: string, path: string, newName: string) => Promise<unknown>
}

export interface GitState {
  branch: string | null
  files: GitChangedFile[]
  selectedPaths: string[]
  activePath: string | null
  diffByPath: Record<string, string>
  fallbackDiff: string
  loading: boolean
  diffLoading: boolean
  busy: boolean
  error: string | null
  commitMessage: string
  commitMessageEdited: boolean
  loadedRepoPath: string | null
  stale: boolean
}

export interface FileContextMenuState {
  file: ProblemFileEntry
  x: number
  y: number
}

export interface GitContextMenuState {
  file: GitChangedFile
  x: number
  y: number
}

/** Metadata for a file that is open in the editor tab strip. */
export interface OpenFileTab {
  id: number
  path: string
  name: string
  packageSegment: ProblemFileEntry['packageSegment']
}

export type ProblemSelection = 'daily' | 'manual'

export interface AppState {
  repoPath: string | null
  projectValid: boolean
  files: ProblemFileEntry[]
  openTabs: OpenFileTab[]
  activeTabId: number | null
  selectedPath: string | null
  selectedSource: string
  savedSource: string
  selectedFqcn: string | null
  dirty: boolean
  dailyProblem: DailyProblem | null
  problemSelection: ProblemSelection
  dailyProblemDateKey: string | null
  dailyRetryPending: boolean
  dailyError: string | null
  dailyLoading: boolean
  testResult: TestResult | null
  testRun: TestRunSnapshot | null
  liveDiagnosticsError: string | null
  /** Stable key of the testcase whose details are shown in the run panel. */
  selectedTestKey: string | null
  busy: boolean
  fileSearch: string
  saveError: string | null
  bottomPanelTab: 'tests' | 'git'
  git: GitState
  contextMenu: FileContextMenuState | null
  gitContextMenu: GitContextMenuState | null
}

export interface RepositoryRefreshRequest {
  repoPath: string
  repositoryGeneration: number
  requestId: number
}

export interface RepositoryRefreshState {
  repoPath: string | null
  projectValid: boolean
  repositoryGeneration: number
  refreshRequestId: number
}

export type { BackendClient, GitCommitResult, GitPushResult, ProblemDiagnostic,
  ProblemFileEntry, RepositoryFilesChanged, TestCaseResult, TestDiagnostic, TestPhase,
  TestResult, TestRunProgress }

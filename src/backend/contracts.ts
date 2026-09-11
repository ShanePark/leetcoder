import type { ProblemFilePlan } from '../domain'

/** LeetCode problem metadata returned by the daily or numeric lookup command. */
export interface DailyProblem {
  date: string
  frontendId: string
  title: string
  titleSlug: string
  difficulty: string
  url: string
  javaSnippet?: string | null
  content?: string | null
}

/** Build metadata used by the self-update control in the desktop shell. */
export interface UpdateStatus {
  supported: boolean
  available: boolean
  currentCommit: string
  latestCommit: string
}

/** A Java source file returned by the repository file-list command. */
export interface ProblemFileEntry {
  path: string
  name: string
  packageSegment: 'easy' | 'medium' | 'xhard' | 'other'
}

/** The path and source returned after a file mutation. */
export interface ProblemFileContent {
  relativePath: string
  content: string
}

/** Problem source files changed outside this application. */
export interface RepositoryFilesChanged {
  /** Repository-relative POSIX paths, sorted and de-duplicated. */
  paths: string[]
  /** True when a file was created, removed, or renamed, so the list is stale. */
  structural: boolean
}

/** A path reported by Git as changed in the selected repository. */
export interface GitFileChange {
  path: string
  status: string
  indexStatus: string
  worktreeStatus: string
  originalPath?: string | null
}

export interface GitCommitResult {
  commitHash: string
  message: string
  paths: string[]
}

export interface GitPushResult {
  output: string
  branch?: string | null
}

export interface ProjectValidation {
  valid: boolean
  message?: string
}

export type TestPhase = 'compile' | 'test' | 'unknown' | string

export type TestCaseStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'running' | 'unknown' | string

export interface TestSummary {
  total: number
  passed: number
  failed: number
  skipped: number
  errors: number
  durationMs?: number | null
}

export interface TestCaseResult {
  name: string
  className?: string
  displayName?: string
  status: TestCaseStatus
  durationMs?: number | null
  message?: string | null
  details?: string | null
  stdout?: string | null
  stderr?: string | null
  expected?: string | null
  actual?: string | null
  file?: string | null
  line?: number | null
  column?: number | null
}

export interface TestDiagnostic {
  message: string
  severity: 'error' | 'warning' | 'info' | string
  file?: string | null
  line?: number | null
  column?: number | null
  origin?: 'javac' | 'runner' | 'junit'
  sourceLine?: string | null
  caret?: string | null
}

/** A compiler diagnostic for the current editor source snapshot. */
export type ProblemDiagnostic = TestDiagnostic

export interface TestResult {
  success: boolean
  phase: TestPhase
  summary: TestSummary
  tests: TestCaseResult[]
  diagnostics: TestDiagnostic[]
  stdout: string
  stderr: string
  exitCode?: number | null
}

export type TestRunProgress =
  | { kind: 'started' }
  | { kind: 'phase'; phase: TestPhase }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'testStarted'; test: TestCaseResult }
  | { kind: 'testFinished'; test: TestCaseResult }

export type TestRunProgressHandler = (progress: TestRunProgress) => void

export interface BackendClient {
  validateProject(repoPath: string): Promise<ProjectValidation>
  fetchDailyProblem(): Promise<DailyProblem>
  fetchProblemByNumber(frontendId: string): Promise<DailyProblem>
  listProblemFiles(repoPath: string): Promise<ProblemFileEntry[]>
  readProblemFile(repoPath: string, path: string): Promise<string>
  createProblemFile(repoPath: string, plan: ProblemFilePlan): Promise<void>
  saveProblemFile(repoPath: string, path: string, content: string): Promise<void>
  deleteProblemFile(repoPath: string, path: string): Promise<void>
  duplicateProblemFile(repoPath: string, path: string): Promise<ProblemFileContent>
  renameProblemFile(repoPath: string, path: string, newPath: string): Promise<ProblemFileContent>
  listGitChanges(repoPath: string): Promise<GitFileChange[]>
  discardGitChanges(repoPath: string, path: string): Promise<void>
  showInFileManager(repoPath: string, path: string): Promise<void>
  getGitDiff(repoPath: string, paths: string[]): Promise<string>
  commitGit(repoPath: string, paths: string[], message: string): Promise<GitCommitResult>
  pushGit(repoPath: string): Promise<GitPushResult>
  runProblemTest(
    repoPath: string,
    fullyQualifiedClassName: string,
    onProgress?: TestRunProgressHandler,
    testMethod?: string,
  ): Promise<TestResult>
  /** Compile an editor snapshot without saving it or running tests. */
  checkProblemDiagnostics?(
    repoPath: string,
    fullyQualifiedClassName: string,
    source: string,
  ): Promise<ProblemDiagnostic[]>
  /** Start reporting external changes to the given repository's source tree. */
  watchRepository(repoPath: string): Promise<void>
  stopWatchingRepository(): Promise<void>
  /** Subscribe to watcher events; resolves to an unsubscribe function. */
  onRepositoryFilesChanged(
    handler: (change: RepositoryFilesChanged) => void,
  ): Promise<() => void>
  checkForUpdate(): Promise<UpdateStatus>
  updateAndRestart(): Promise<void>
}

/** Tauri's event bridge, narrowed to what the watcher subscription needs. */
export type Listen = (
  event: string,
  handler: (message: { payload: unknown }) => void,
) => Promise<() => void>

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

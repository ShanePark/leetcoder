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

/** The commit of a release build staged in the background and ready to install. */
export interface UpdateBuild {
  commit: string
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

/** One matching line from an on-demand project search. Coordinates are one-based. */
export interface ProjectSearchMatch {
  path: string
  line: number
  /** UTF-16 code-unit column, matching editor coordinates. */
  column: number
  preview: string
}

/** Results from searching saved text files in the selected repository. */
export interface ProjectSearchResult {
  matches: ProjectSearchMatch[]
  truncated: boolean
  skippedFiles: number
}

/** A parameter in a method declared by the project's Ps library. */
export interface PsParameter {
  name: string | null
  typeName: string
}

/** A method declared by the project's Ps library. */
export interface PsMethod {
  name: string
  returnType: string
  parameters: PsParameter[]
}

/** Public Ps methods discovered from the selected project's classpath. */
export interface PsLibraryMetadata {
  fingerprint: string
  methods: PsMethod[]
}

/** One parameter in a public method discovered from a Java type. */
export interface JavaMemberParameter {
  name: string | null
  typeName: string
}

/** One public method discovered from a Java type, including inherited methods. */
export interface JavaMethodMember {
  name: string
  returnType: string
  parameters: JavaMemberParameter[]
  isStatic: boolean
}

/** One public field discovered from a Java type. */
export interface JavaFieldMember {
  name: string
  typeName: string
  isStatic: boolean
}

/** Public members for one requested Java type. */
export interface JavaTypeMembers {
  typeName: string
  /** False means the type was not present on the resolved project classpath. */
  available: boolean
  methods: JavaMethodMember[]
  fields: JavaFieldMember[]
}

/** Public Java members for a bounded batch of requested types. */
export interface JavaTypeMembersMetadata {
  fingerprint: string
  types: JavaTypeMembers[]
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

/** Result of fast-forwarding the current branch to its upstream. */
export interface GitPullResult {
  /** Whether the branch moved to include upstream commits. */
  updated: boolean
  output: string
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

export interface AiProviderInfo {
  id: string
  displayName: string
}

/** Whether an AI provider credential is stored. The key itself never leaves native code. */
export interface AiStatus {
  configured: boolean
  /** The current provider, reported even when no key is stored. */
  provider: AiProviderInfo
}

/** `requesting` names the model actually sent; `received` means the reply arrived, before parsing. */
export type AiProgress = { stage: 'requesting'; model: string } | { stage: 'received' }

export type AiProgressHandler = (progress: AiProgress) => void

export interface AiKeySaveResult {
  /** False when the key was saved but the provider could not be reached to verify it. */
  verified: boolean
}

export interface AiModel {
  id: string
  displayName: string
  deprecated: boolean
  /** A newer model of the same line exists. It stays usable as an existing pin. */
  superseded: boolean
  /** Null when the price cache has no entry for the model. */
  pricing: AiModelPricing | null
}

export interface AiModelPricing {
  /** USD per million tokens. */
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number | null
  cacheWritePerMTok: number | null
}

export interface AiModelList {
  models: AiModel[]
  defaultModelId: string | null
  fetchedAt: number | null
  /** The refresh failed; `models` is the cached list. */
  error: string | null
}

export interface AiGenerateRequest {
  selectedModelId: string | null
  problemTitle: string
  problemContent: string
  /** The snippet signature that identifies the method under test. */
  entryPoint: string | null
  /** The problem's starting code, which shows classes the file may not declare yet. */
  javaSnippet: string | null
  methodHeaders: string[]
  psSignatures: string[]
  /**
   * A failing case pasted from the judge. When present, the statements test only
   * this case, for a new test method, instead of the problem's examples.
   */
  failingCase?: string
}

export interface AiGenerateResult {
  outcome: 'ok' | 'refused' | 'truncated'
  /** Empty unless `outcome` is `ok`. */
  statements: string[]
  servedModel: string
  /** A pinned model left the list, so the default was used. */
  fellBack: boolean
}

export type AiResponseLanguage = 'english' | 'korean'

export interface AiReviewTestCase {
  name: string
  status: TestCaseStatus
  message?: string | null
  expected?: string | null
  actual?: string | null
  /** The caller truncates long output. */
  stdout?: string | null
}

export interface AiReviewTestRun {
  success: boolean
  phase: TestPhase
  summary: { total: number; passed: number; failed: number; skipped: number; errors: number }
  tests: AiReviewTestCase[]
  /** Compiler and runner diagnostic messages. */
  diagnostics: string[]
}

export interface AiReviewRequest {
  selectedModelId: string | null
  problemTitle: string
  problemContent: string
  entryPoint: string | null
  /** The whole open solution file. */
  source: string
  /** Present only when the last run was made on exactly this source. */
  testRun: AiReviewTestRun | null
  language: AiResponseLanguage
}

export type AiReviewVerdict = 'correct' | 'incorrect' | 'unsure'

export interface AiReviewMissedCase {
  input: string
  reason: string
}

/** Prose fields are in the requested language; `verdict` stays the English enum. */
export interface AiReview {
  verdict: AiReviewVerdict
  summary: string
  /** Why the failing tests fail; null when nothing failed or no run was sent. */
  failureCause: string | null
  /** Concrete bugs or wrong assumptions in the code. */
  issues: string[]
  /** Inputs the code likely gets wrong or that the tests do not cover. */
  missedCases: AiReviewMissedCase[]
  efficiency: { time: string; space: string; assessment: string }
  improvements: string[]
}

export interface AiReviewResult {
  outcome: 'ok' | 'refused' | 'truncated'
  /** Non-null only when `outcome` is `ok`. */
  review: AiReview | null
  servedModel: string
  /** A pinned model left the list, so the default was used. */
  fellBack: boolean
  /** The request that produced this result. */
  usage: AiRequestUsage
}

export interface AiRequestUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Null when the served model's price is unknown. Priced as the usage ledger prices it. */
  costUsd: number | null
}

export interface AiUsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  unpricedRequests: number
  approximateRequests: number
  refusedRequests: number
}

export interface AiModelUsage {
  model: string
  totals: AiUsageTotals
}

export interface AiUsageBucket {
  startMs: number
  totals: AiUsageTotals
  perModel: AiModelUsage[]
}

export interface AiUsageSummary {
  buckets: AiUsageBucket[]
  allTime: AiUsageTotals
  skippedLines: number
}

export interface BackendClient {
  validateProject(repoPath: string): Promise<ProjectValidation>
  inspectPsLibrary(repoPath: string): Promise<PsLibraryMetadata>
  inspectJavaTypeMembers?(
    repoPath: string,
    typeNames: string[],
  ): Promise<JavaTypeMembersMetadata>
  fetchDailyProblem(): Promise<DailyProblem>
  fetchProblemBySlug(titleSlug: string): Promise<DailyProblem>
  listProblemFiles(repoPath: string): Promise<ProblemFileEntry[]>
  searchProject(
    repoPath: string,
    query: string,
    caseSensitive: boolean,
    excludePaths?: readonly string[],
  ): Promise<ProjectSearchResult>
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
  /**
   * Fetch the upstream and fast-forward the current branch to it. Rejects,
   * without merging or rebasing, when the branch diverged or the update
   * would overwrite local changes.
   */
  pullGit(repoPath: string): Promise<GitPullResult>
  pushGit(repoPath: string): Promise<GitPushResult>
  /** Commits on the current branch that its upstream lacks; 0 without an upstream. */
  countUnpushedGitCommits(repoPath: string): Promise<number>
  runProblemTest(
    repoPath: string,
    fullyQualifiedClassName: string,
    testRunId: number,
    onProgress?: TestRunProgressHandler,
    testMethod?: string,
  ): Promise<TestResult>
  stopProblemTest(testRunId: number): Promise<boolean>
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
  /** Build and stage the latest local commit without replacing the running app. */
  buildUpdate(): Promise<UpdateBuild>
  /** Install the staged build and restart into it. */
  applyUpdate(): Promise<void>
  aiStatus(): Promise<AiStatus>
  /** Rejects when the provider rejects the key, which is then not saved. */
  aiSaveKey(apiKey: string): Promise<AiKeySaveResult>
  aiClearKey(): Promise<void>
  aiListModels(refresh: boolean): Promise<AiModelList>
  aiGenerateTests(
    request: AiGenerateRequest,
    onProgress?: AiProgressHandler,
  ): Promise<AiGenerateResult>
  /** Rejects when the request is too large or the reply cannot be read. */
  reviewAiCode(request: AiReviewRequest, onProgress?: AiProgressHandler): Promise<AiReviewResult>
  /**
   * Usage per bucket, with one bucket for each ascending start. A bucket runs up
   * to the next start and the last is open-ended; older entries count only toward `allTime`.
   */
  aiUsage(bucketStartsMs: number[]): Promise<AiUsageSummary>
}

/** Tauri's event bridge, narrowed to what the watcher subscription needs. */
export type Listen = (
  event: string,
  handler: (message: { payload: unknown }) => void,
) => Promise<() => void>

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

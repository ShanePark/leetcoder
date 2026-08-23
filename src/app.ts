import { open } from '@tauri-apps/plugin-dialog'

import {
  createBackendClient,
  errorMessage,
  type BackendClient,
  type DailyProblem,
  type ProblemFileEntry,
  type TestResult,
  type TestCaseResult,
  type TestDiagnostic,
  type TestPhase,
  type TestRunProgress,
} from './backend'
import { JavaEditor, type EditorIssue } from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'

const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const BOTTOM_PANEL_HEIGHT_KEY = 'leetcoder.bottom-panel-height'
const GIT_FILE_LIST_WIDTH_KEY = 'leetcoder.git-file-list-width'
const DEFAULT_BOTTOM_PANEL_HEIGHT = 280
const MIN_BOTTOM_PANEL_HEIGHT = 180
const MAX_BOTTOM_PANEL_HEIGHT = 640
const DEFAULT_GIT_FILE_LIST_WIDTH = 300
const MIN_GIT_FILE_LIST_WIDTH = 180
const MIN_GIT_DIFF_WIDTH = 260
const GIT_SPLITTER_WIDTH = 7
const GIT_WORKSPACE_GAP = 16
const GIT_REFRESH_DEBOUNCE_MS = 250
const FILE_CONTEXT_MENU_WIDTH = 96
const FILE_CONTEXT_MENU_HEIGHT = 38
const VIEWPORT_MARGIN = 8
const FILE_GROUPS: Array<{ key: ProblemFileEntry['packageSegment']; label: string }> = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'xhard', label: 'Hard' },
]

export type DirectoryPicker = () => Promise<string | null>

export interface AppOptions {
  backend?: BackendClient
  directoryPicker?: DirectoryPicker
  storage?: Storage
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
}

export interface GitStatusSnapshot {
  branch: string | null
  files: GitChangedFile[]
}

/**
 * Git is intentionally kept optional here so the web preview and older
 * desktop binaries can still boot while the Rust command bridge is updated.
 * The backend implementation can expose richer DTOs; the normalizers below
 * accept the common object/array/string variants.
 */
interface GitBackendClient {
  getGitStatus?: (projectRoot: string) => Promise<unknown>
  listGitChanges?: (projectRoot: string) => Promise<unknown>
  getGitDiff?: (projectRoot: string, paths: string[]) => Promise<unknown>
  commitGitChanges?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  commitGit?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  pushGit?: (projectRoot: string) => Promise<unknown>
}

interface FileManagementBackend {
  deleteProblemFile?: (projectRoot: string, path: string) => Promise<unknown>
}

interface GitState {
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

interface FileContextMenuState {
  file: ProblemFileEntry
  x: number
  y: number
}

/**
 * A backend result is only valid for the exact document that started the run.
 * Comparing the source as well as the path prevents an older run from painting
 * failures onto an edited buffer while its process is still finishing.
 */
export function isTestRunSourceCurrent(
  snapshot: TestRunSourceSnapshot,
  current: CurrentTestSource,
): boolean {
  return snapshot.repoPath === current.repoPath
    && snapshot.filePath === current.filePath
    && snapshot.source === current.source
}

/**
 * Turns a structured run result into the short, actionable copy used above
 * the detailed test rows. The full process output remains available below.
 */
export function presentTestResult(result: TestResult): TestResultPresentation {
  const phaseLabel = testPhaseLabel(result.phase)
  const failureMessage = result.success ? null : testFailureMessage(result)
  return {
    phaseLabel,
    statusLabel: result.success
      ? 'Passed'
      : result.summary.errors > 0
        ? `Error · ${phaseLabel}`
        : `Failed · ${phaseLabel}`,
    failureMessage,
    rawLogsOpen: false,
  }
}

export function testResultBannerMessage(result: TestResult): string {
  if (result.success) {
    return 'Test passed.'
  }
  const reason = testFailureMessage(result)
  const phase = normalizeTestPhase(result.phase)
  if (phase === 'compile') {
    return `Compilation failed: ${reason}`
  }
  if (phase === 'runner') {
    return `Test runner failed: ${reason}`
  }
  if (phase === 'noTests') {
    return `No tests found: ${reason}`
  }
  if (phase === 'test') {
    return `Tests failed: ${reason}`
  }
  return `Test failed: ${reason}`
}

function testPhaseLabel(phase: TestPhase): string {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (normalized === 'starting') {
    return 'Starting'
  }
  if (normalized === 'finishing') {
    return 'Finishing'
  }
  switch (normalizeTestPhase(phase)) {
    case 'compile':
      return 'Compilation'
    case 'runner':
      return 'Test runner'
    case 'noTests':
      return 'No tests'
    case 'test':
      return 'Tests'
    default:
      return phase.trim() || 'Test run'
  }
}

function normalizeTestPhase(phase: TestPhase): 'compile' | 'runner' | 'noTests' | 'test' | 'unknown' {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (normalized === 'compile' || normalized === 'compilation') {
    return 'compile'
  }
  if (normalized === 'runner' || normalized === 'run' || normalized === 'execution') {
    return 'runner'
  }
  if (normalized === 'notest' || normalized === 'notests') {
    return 'noTests'
  }
  if (normalized === 'test' || normalized === 'tests') {
    return 'test'
  }
  if (normalized === 'compiling') {
    return 'compile'
  }
  if (normalized === 'runningtests') {
    return 'test'
  }
  return 'unknown'
}

export function testFailureMessage(result: TestResult): string {
  const phase = normalizeTestPhase(result.phase)
  const diagnostic = result.diagnostics.find(
    (entry) => entry.message.trim().length > 0 && entry.severity.trim().toLowerCase() === 'error',
  ) ?? result.diagnostics.find((entry) => entry.message.trim().length > 0)
  const failedTest = result.tests.find(
    (test) => (test.status === 'failed' || test.status === 'error') && test.message?.trim().length,
  )
  if (phase === 'compile' && diagnostic) {
    return shortenResultMessage(diagnostic.message)
  }
  if (phase === 'test' && failedTest?.message) {
    return shortenResultMessage(failedTest.message)
  }
  const stderr = firstUsefulOutputLine(result.stderr)
  if (stderr) {
    return shortenResultMessage(stderr)
  }
  const stdout = firstUsefulOutputLine(result.stdout)
  if (stdout) {
    return shortenResultMessage(stdout)
  }
  if (diagnostic) {
    return shortenResultMessage(diagnostic.message)
  }
  if (phase === 'compile') {
    return 'The Java source could not be compiled.'
  }
  if (phase === 'runner') {
    return 'The test runner stopped before reporting any tests.'
  }
  if (phase === 'noTests') {
    return 'The test task completed without reporting any tests.'
  }
  return 'The test run stopped before reporting a result.'
}

/** Whether a testcase has output worth showing in its expanded result row. */
export function testCaseHasOutput(test: TestCaseResult): boolean {
  return (test.stdout?.length ?? 0) > 0 || (test.stderr?.length ?? 0) > 0
}

/** Hide noisy JDK annotation-enum warnings while retaining actionable diagnostics. */
export function filterTestDiagnostics(diagnostics: TestDiagnostic[]): TestDiagnostic[] {
  return diagnostics.filter((diagnostic) => {
    return !/unknown\s+enum\s+constant\s+[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+/i.test(diagnostic.message)
  })
}

export function conciseTestFailureMessage(test: TestCaseResult): string | null {
  const message = test.message?.trim()
  if (message) {
    return shortenResultMessage(message)
  }
  const details = test.details?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^at\s+/.test(line) && !/^caused by:\s*$/i.test(line))
  return details ? shortenResultMessage(details) : null
}

export function relevantTestStackFrames(details: string | null | undefined): string[] {
  if (!details) {
    return []
  }
  return details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^at\s+/.test(line) && !isInternalTestFrame(line))
    .slice(0, 4)
}

export function defaultVisibleTests(
  tests: TestCaseResult[],
  isRunning = false,
): { tests: TestCaseResult[]; hiddenCount: number } {
  if (isRunning || !tests.some((test) => test.status === 'failed' || test.status === 'error')) {
    return { tests, hiddenCount: 0 }
  }
  const visible = tests.filter((test) => test.status === 'failed' || test.status === 'error')
  return { tests: visible, hiddenCount: tests.length - visible.length }
}

function isInternalTestFrame(line: string): boolean {
  return /^at\s+(?:java\.|javax\.|jdk\.|sun\.|com\.sun\.|org\.junit\.|org\.gradle\.|org\.hamcrest\.|kotlin\.|worker\.)/i.test(line)
}

/**
 * Match a backend source path against the currently open repository-relative
 * path. Gradle/JUnit may report an absolute path, a repository suffix, or
 * only the Java basename depending on where the failure was discovered.
 */
export function sourcePathsMatch(selectedPath: string, reportedPath: string): boolean {
  const selected = normalizeSourcePath(selectedPath)
  const reported = normalizeSourcePath(reportedPath)
  if (!selected || !reported) {
    return false
  }
  if (selected === reported || selected.endsWith(`/${reported}`) || reported.endsWith(`/${selected}`)) {
    return true
  }
  // A basename-only report is common in JUnit stack traces. Once the
  // backend gives us directory information, require the suffix match above
  // so two unrelated files with the same name cannot mark this editor.
  return !reported.includes('/') && sourceBasename(selected) === reported
}

function normalizeSourcePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .toLocaleLowerCase()
}

export function gitFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

export function defaultGitCommitMessage(paths: string[]): string {
  const normalized = paths.filter((path) => path.trim().length > 0)
  if (normalized.length === 0) {
    return 'Create selected files'
  }
  if (normalized.length === 1) {
    return `Create ${gitFileName(normalized[0])}`
  }
  return `Create ${gitFileName(normalized[0])} and ${normalized.length - 1} more`
}

/** Normalize the backend's Git status payload into the fields the UI needs. */
export function normalizeGitStatus(value: unknown): GitStatusSnapshot {
  if (typeof value === 'string') {
    return {
      branch: null,
      files: value.split(/\r?\n/).map(parseGitStatusLine).filter((file): file is GitChangedFile => file !== null),
    }
  }
  const record = isRecordValue(value) ? value : null
  const rawFiles = Array.isArray(value)
    ? value
    : record
      ? record.files ?? record.changes ?? record.entries ?? record.statuses ?? record.paths
      : undefined
  const files = Array.isArray(rawFiles)
    ? rawFiles.map((entry) => normalizeGitFile(entry)).filter((file): file is GitChangedFile => file !== null)
    : []
  const branch = record
    ? stringValueForGit(record.branch) ?? stringValueForGit(record.currentBranch) ?? stringValueForGit(record.head)
    : null
  return { branch, files: dedupeGitFiles(files) }
}

/** Normalize a Git diff payload to one diff string per repository-relative path. */
export function normalizeGitDiff(value: unknown, requestedPaths: string[] = []): Record<string, string> {
  const diffs: Record<string, string> = {}
  const assign = (path: string | null, diff: string): void => {
    const text = diff.trimEnd()
    if (!text) {
      return
    }
    if (path) {
      diffs[path] = text
      return
    }
    const parsed = splitUnifiedDiff(text)
    if (Object.keys(parsed).length > 0) {
      Object.assign(diffs, parsed)
      return
    }
    for (const requestedPath of requestedPaths) {
      diffs[requestedPath] = text
    }
  }

  if (typeof value === 'string') {
    assign(null, value)
    return diffs
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        assign(null, item)
        continue
      }
      if (!isRecordValue(item)) {
        continue
      }
      const path = stringValueForGit(item.path) ?? stringValueForGit(item.relativePath) ?? stringValueForGit(item.relative_path)
      const diff = stringValueForGit(item.diff) ?? stringValueForGit(item.patch) ?? stringValueForGit(item.content)
      if (diff) {
        assign(path, diff)
      }
    }
    return diffs
  }
  if (!isRecordValue(value)) {
    return diffs
  }
  const nested = value.files ?? value.diffs ?? value.changes
  if (Array.isArray(nested)) {
    Object.assign(diffs, normalizeGitDiff(nested, requestedPaths))
  }
  const rawDiff = stringValueForGit(value.diff) ?? stringValueForGit(value.patch) ?? stringValueForGit(value.content)
  if (rawDiff) {
    const path = stringValueForGit(value.path) ?? stringValueForGit(value.relativePath) ?? stringValueForGit(value.relative_path)
    assign(path, rawDiff)
  }
  return diffs
}

function parseGitStatusLine(line: string): GitChangedFile | null {
  const raw = line.replace(/\r$/, '')
  if (!raw.trim()) {
    return null
  }
  // Porcelain v1: XY path, with a quoted path only in unusual filenames.
  const match = /^(?<index>.)(?<worktree>.)\s+(?<path>.+)$/.exec(raw)
  if (!match?.groups?.path) {
    return null
  }
  const index = match.groups.index ?? ' '
  const worktree = match.groups.worktree ?? ' '
  const status = statusFromGitCodes(index, worktree)
  return {
    path: unquoteGitPath(match.groups.path),
    status,
    staged: isGitIndexStaged(index),
    additions: null,
    deletions: null,
  }
}

function normalizeGitFile(value: unknown): GitChangedFile | null {
  if (typeof value === 'string') {
    return { path: value, status: 'modified', staged: false, additions: null, deletions: null }
  }
  if (!isRecordValue(value)) {
    return null
  }
  const path = stringValueForGit(value.path)
    ?? stringValueForGit(value.relativePath)
    ?? stringValueForGit(value.relative_path)
    ?? stringValueForGit(value.name)
  if (!path) {
    return null
  }
  const index = stringValueForGit(value.indexStatus) ?? stringValueForGit(value.index_status) ?? stringValueForGit(value.index)
  const worktree = stringValueForGit(value.worktreeStatus) ?? stringValueForGit(value.worktree_status) ?? stringValueForGit(value.worktree)
  const rawStatus = stringValueForGit(value.status) ?? stringValueForGit(value.state) ?? stringValueForGit(value.statusCode) ?? stringValueForGit(value.status_code)
  const additions = numberValueForGit(value.additions ?? value.insertions ?? value.added)
  const deletions = numberValueForGit(value.deletions ?? value.removals ?? value.deleted)
  const staged = typeof value.staged === 'boolean'
    ? value.staged
    : isGitIndexStaged(index)
  return {
    path: unquoteGitPath(path),
    status: rawStatus ? normalizeGitStatusLabel(rawStatus) : statusFromGitCodes(index ?? ' ', worktree ?? ' '),
    staged,
    additions,
    deletions,
  }
}

function isGitIndexStaged(index: string | null): boolean {
  if (!index) {
    return false
  }
  const normalized = index.trim()
  return normalized.length > 0 && normalized !== '.' && normalized !== '?'
}

function dedupeGitFiles(files: GitChangedFile[]): GitChangedFile[] {
  const byPath = new Map<string, GitChangedFile>()
  for (const file of files) {
    if (!file.path) {
      continue
    }
    const previous = byPath.get(file.path)
    byPath.set(file.path, previous ? {
      ...previous,
      ...file,
      additions: file.additions ?? previous.additions,
      deletions: file.deletions ?? previous.deletions,
    } : file)
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function splitUnifiedDiff(diff: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = diff.split(/\r?\n/)
  let currentPath: string | null = null
  let current: string[] = []
  const flush = (): void => {
    if (currentPath && current.length > 0) {
      result[currentPath] = current.join('\n').trimEnd()
    }
  }
  for (const line of lines) {
    const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line)
    if (match) {
      flush()
      currentPath = match[2] || match[1]
      current = [line]
      continue
    }
    if (currentPath) {
      current.push(line)
    }
  }
  flush()
  return result
}

function statusFromGitCodes(index: string, worktree: string): string {
  const code = `${index}${worktree}`.trim()
  if (code === '??' || index === '?' || worktree === '?') return 'untracked'
  if (code.includes('U')) return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  if (code.includes('M')) return 'modified'
  return 'modified'
}

function normalizeGitStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'm' || normalized.includes('modif')) return 'modified'
  if (normalized === 'a' || normalized.includes('add') || normalized.includes('new')) return 'added'
  if (normalized === 'd' || normalized.includes('delet') || normalized.includes('remov')) return 'deleted'
  if (normalized === 'r' || normalized.includes('renam')) return 'renamed'
  if (normalized === 'u' || normalized.includes('conflict')) return 'conflicted'
  if (normalized === '?' || normalized === '??' || normalized.includes('?') || normalized.includes('untrack')) return 'untracked'
  return status.trim() || 'modified'
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1')
  }
  return trimmed
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValueForGit(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function numberValueForGit(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return null
}

function sourceBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function validSourceLine(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  const line = Math.trunc(value)
  return line > 0 ? line : null
}

function validSourceColumn(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  const column = Math.trunc(value)
  return column > 0 ? column : null
}

/** Collect unique red markers that belong to the currently open source file. */
export function collectEditorIssues(
  result: TestResult,
  selectedPath: string | null,
): EditorIssue[] {
  if (!selectedPath) {
    return []
  }
  const issues: EditorIssue[] = []
  const seen = new Set<string>()
  const add = (file: string | null | undefined, lineValue: number | null | undefined, columnValue: number | null | undefined, message: string | null | undefined): void => {
    const line = validSourceLine(lineValue)
    if (!file || line === null || !sourcePathsMatch(selectedPath, file)) {
      return
    }
    const column = validSourceColumn(columnValue)
    const key = `${line}:${column ?? ''}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    issues.push({
      file,
      line,
      column,
      message: message?.trim() || null,
    })
  }

  for (const test of result.tests) {
    if (test.status !== 'failed' && test.status !== 'error') {
      continue
    }
    add(test.file, test.line, test.column, test.message ?? test.details ?? `${test.name} failed`)
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity.trim().toLowerCase() !== 'error') {
      continue
    }
    add(diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message)
  }
  return issues
}

function firstUsefulOutputLine(output: string): string | null {
  const lines = output
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return null
  }
  const useful = lines.find((line) => !/^> task .* (executed|failed)$/i.test(line))
  return useful ?? lines[0]
}

function shortenResultMessage(message: string, limit = 220): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

export function summarizeLiveTests(
  tests: TestCaseResult[],
  durationMs: number | null = null,
): TestResult['summary'] {
  return tests.reduce((summary, test) => {
    summary.total += 1
    if (test.status === 'passed') summary.passed += 1
    if (test.status === 'failed' || test.status === 'error') summary.failed += 1
    if (test.status === 'error') summary.errors += 1
    if (test.status === 'skipped') summary.skipped += 1
    return summary
  }, {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    durationMs,
  })
}

export function liveSnapshotResult(run: TestRunSnapshot, now = Date.now()): TestResult {
  return {
    success: false,
    phase: run.phase,
    summary: summarizeLiveTests(run.tests, Math.max(0, now - run.startedAt)),
    tests: run.tests,
    diagnostics: [],
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: null,
  }
}

export function runnerFailureResult(
  run: TestRunSnapshot,
  message: string,
): TestResult {
  const detail = message.trim() || 'The test runner stopped unexpectedly.'
  const tests = run.tests.map((test) => test.status === 'running'
    ? { ...test, status: 'error', message: test.message ?? detail }
    : test)
  return {
    success: false,
    phase: 'runner',
    summary: summarizeLiveTests(tests, Math.max(0, Date.now() - run.startedAt)),
    tests,
    diagnostics: [{ severity: 'error', message: detail }],
    stdout: run.stdout,
    stderr: run.stderr || detail,
    exitCode: null,
  }
}

function sameTest(left: TestCaseResult | null, right: TestCaseResult): boolean {
  if (!left) {
    return false
  }
  return left.name === right.name && (left.className ?? '') === (right.className ?? '')
}

/**
 * Coalesces editor changes into one debounced write and follows an in-flight
 * write with the newest snapshot when the document changes while saving.
 */
export class AutosaveCoordinator {
  private readonly save: (snapshot: AutosaveSnapshot) => Promise<void>
  private readonly delayMs: number
  private readonly onStatusChange?: (status: AutosaveStatus) => void
  private readonly onError?: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: AutosaveSnapshot | null = null
  private running: Promise<void> | null = null
  private currentStatus: AutosaveStatus = 'idle'
  private disposed = false

  constructor(
    save: (snapshot: AutosaveSnapshot) => Promise<void>,
    options: AutosaveCoordinatorOptions = {},
  ) {
    this.save = save
    this.delayMs = options.delayMs ?? 500
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
  }

  get status(): AutosaveStatus {
    return this.currentStatus
  }

  get hasPendingChanges(): boolean {
    return this.pending !== null || this.running !== null
  }

  schedule(snapshot: AutosaveSnapshot): void {
    if (this.disposed) {
      return
    }
    this.pending = snapshot
    this.clearTimer()
    this.setStatus('saving')
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch((error) => this.onError?.(error))
    }, this.delayMs)
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (!this.pending && !this.running) {
      return
    }
    await (this.running ?? this.startRun())
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private startRun(): Promise<void> {
    const run = this.persistPending()
    this.running = run
    void run.then(
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
    )
    return run
  }

  private async persistPending(): Promise<void> {
    while (this.pending) {
      const snapshot = this.pending
      this.pending = null
      this.setStatus('saving')
      try {
        await this.save(snapshot)
      } catch (error) {
        // Keep the failed snapshot available for an explicit retry. If a
        // newer edit already arrived, that newer snapshot is sufficient.
        this.pending ??= snapshot
        this.setStatus('error')
        throw error
      }
    }
    this.setStatus('idle')
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setStatus(status: AutosaveStatus): void {
    this.currentStatus = status
    this.onStatusChange?.(status)
  }
}

export function filterProblemFiles(files: ProblemFileEntry[], query: string): ProblemFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return files
  }
  return files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
}

export function filterProblemFilesByGroup(
  files: ProblemFileEntry[],
  group: ProblemFileEntry['packageSegment'],
  query: string,
): ProblemFileEntry[] {
  return filterProblemFiles(files, query).filter((file) => file.packageSegment === group)
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

export function isCurrentRepositoryRefresh(
  request: RepositoryRefreshRequest,
  state: RepositoryRefreshState,
): boolean {
  return state.projectValid
    && state.repoPath === request.repoPath
    && state.repositoryGeneration === request.repositoryGeneration
    && state.refreshRequestId === request.requestId
}

interface AppState {
  repoPath: string | null
  projectValid: boolean
  files: ProblemFileEntry[]
  selectedPath: string | null
  selectedSource: string
  savedSource: string
  selectedFqcn: string | null
  dirty: boolean
  dailyProblem: DailyProblem | null
  dailyError: string | null
  testResult: TestResult | null
  testRun: TestRunSnapshot | null
  busy: boolean
  fileSearch: string
  saveError: string | null
  bottomPanelTab: 'tests' | 'git'
  git: GitState
  contextMenu: FileContextMenuState | null
}

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly storage: Storage | undefined
  private readonly state: AppState = {
    repoPath: null,
    projectValid: false,
    files: [],
    selectedPath: null,
    selectedSource: '',
    savedSource: '',
    selectedFqcn: null,
    dirty: false,
    dailyProblem: null,
    dailyError: null,
    testResult: null,
    testRun: null,
    busy: false,
    fileSearch: '',
    saveError: null,
    bottomPanelTab: 'tests',
    contextMenu: null,
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
  private suppressEditorChange = false
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private testRunGeneration = 0
  private closePreparation: Promise<void> | null = null
  private destroyed = false
  private renderedTestResult: TestResult | null = null
  private liveRenderFrame: number | null = null
  private liveRenderToken = 0
  private bottomPanelHeight: number
  private panelResizeStartY: number | null = null
  private panelResizeStartHeight: number | null = null
  private gitFileListWidth: number
  private gitSplitterStartX: number | null = null
  private gitSplitterStartWidth: number | null = null
  private gitStatusRequestId = 0
  private gitDiffRequestId = 0
  private gitOperationId = 0
  private gitRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private pendingGitDiffPath: string | null = null
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    FILE_GROUPS.map((group) => group.key),
  )
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) {
      return
    }
    // CodeMirror owns shortcuts while the editor has focus. Handling them
    // again on window would run/save the same document twice.
    if (event.target instanceof Node && this.element('#editor').contains(event.target)) {
      return
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void this.saveCurrentFile()
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault()
      void this.runCurrentTest()
    }
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

  private readonly handleContextMenuOutside = (event: PointerEvent): void => {
    const menu = this.root.querySelector<HTMLElement>('#file-context-menu')
    if (!menu || menu.hidden || event.target instanceof Node && menu.contains(event.target)) {
      return
    }
    this.closeFileContextMenu()
  }

  private readonly handleContextMenuKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.state.contextMenu) {
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
    this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
  }

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.root = root
    this.backend = options.backend ?? createBackendClient()
    this.directoryPicker = options.directoryPicker ?? defaultDirectoryPicker
    this.storage = options.storage ?? safeStorage()
    this.bottomPanelHeight = readBottomPanelHeight(this.storage)
    this.gitFileListWidth = readGitFileListWidth(this.storage)
    this.renderShell()
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
    })
    this.bindEvents()
    this.renderAll()
  }

  async start(): Promise<void> {
    await this.loadDailyProblem()
    const rememberedPath = this.storage?.getItem(LAST_REPOSITORY_KEY) ?? null
    if (rememberedPath) {
      await this.selectRepository(rememberedPath, false)
    } else {
      this.setMessage('Choose a repository to get started.', 'info')
    }
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
    this.clearScheduledGitRefresh()
    this.editor.destroy()
    this.autosave.dispose()
    window.removeEventListener('keydown', this.handleGlobalKeydown)
    window.removeEventListener('pointermove', this.handlePanelPointerMove)
    window.removeEventListener('pointerup', this.handlePanelPointerUp)
    window.removeEventListener('pointercancel', this.handlePanelPointerUp)
    window.removeEventListener('pointermove', this.handleGitSplitterPointerMove)
    window.removeEventListener('pointerup', this.handleGitSplitterPointerUp)
    window.removeEventListener('pointercancel', this.handleGitSplitterPointerUp)
    window.removeEventListener('blur', this.handlePanelWindowBlur)
    window.removeEventListener('resize', this.handleWindowResize)
    window.removeEventListener('pointerdown', this.handleContextMenuOutside)
    window.removeEventListener('keydown', this.handleContextMenuKeydown)
    this.destroyed = true
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <h1>leetcoder</h1>
          <div class="repository-toolbar">
            <strong id="repo-path">Choose a repository</strong>
            <button id="choose-repository" class="secondary-button" type="button">Choose</button>
          </div>
        </header>

        <div class="app-status" id="app-status" role="status" aria-live="polite"></div>

        <main class="workspace">
          <aside class="sidebar" aria-label="Problem files">
            <div class="sidebar-heading">
              <h2>Problems</h2>
              <button id="refresh-files" class="icon-button" type="button" aria-label="Refresh problem files" title="Refresh files"></button>
            </div>
            <div class="file-search">
              <label class="sr-only" for="file-search">Search problems</label>
              <div class="file-search-field">
                <span id="file-search-icon" aria-hidden="true"></span>
                <input id="file-search" type="search" placeholder="Search problems" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div id="file-list" class="file-list"></div>
          </aside>

          <section class="editor-column" aria-label="Code editor">
            <section class="daily-card" aria-label="Today's problem">
              <div id="daily-content" class="daily-content"></div>
              <div class="daily-actions">
                <a id="problem-link" class="problem-link" href="#" target="_blank" rel="noreferrer">Open</a>
                <button id="create-file" class="primary-button" type="button">New file</button>
                <button id="refresh-daily" class="icon-button" type="button" aria-label="Refresh daily problem" title="Refresh daily problem"></button>
              </div>
            </section>

            <section class="code-card">
              <div class="code-toolbar">
                <div class="file-heading">
                  <strong id="selected-file">No file selected</strong>
                  <span id="dirty-indicator" class="dirty-indicator" hidden>Unsaved</span>
                  <span id="save-status" class="save-status" aria-live="polite"></span>
                </div>
                <div class="code-actions">
                  <button id="run-test" class="primary-button" type="button">Run <kbd id="run-shortcut">Ctrl+R</kbd></button>
                </div>
              </div>
              <div class="editor-host" id="editor-host" aria-label="Java source editor">
                <div id="editor" class="editor"></div>
                <div id="editor-empty" class="editor-empty">Choose a file from the left to start coding.</div>
              </div>
            </section>
          </section>
        </main>

        <section id="bottom-panel" class="bottom-panel" aria-label="Run results and Git">
          <div
            id="bottom-panel-resize-handle"
            class="bottom-panel-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize bottom panel"
            aria-valuemin="${MIN_BOTTOM_PANEL_HEIGHT}"
            aria-valuemax="${MAX_BOTTOM_PANEL_HEIGHT}"
            tabindex="0"
          ><span aria-hidden="true"></span></div>
          <div class="bottom-panel-tabs" role="tablist" aria-label="Bottom panel">
            <button id="tests-tab" class="bottom-panel-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="tests-panel" tabindex="0">Tests</button>
            <button id="git-tab" class="bottom-panel-tab" type="button" role="tab" aria-selected="false" aria-controls="git-panel" tabindex="-1">Git</button>
          </div>
          <section id="tests-panel" class="results-card" role="tabpanel" aria-labelledby="tests-tab" aria-busy="false">
          <div class="results-heading-row">
            <div class="results-heading-main">
              <span id="result-badge" class="result-badge" aria-hidden="true">·</span>
              <div class="results-heading-copy">
                <h2 id="results-heading">Tests</h2>
                <span id="result-phase" class="result-phase">No run yet</span>
              </div>
            </div>
            <div class="result-status-stack">
              <span id="result-status" class="result-status" aria-live="polite">No run yet</span>
              <span id="result-elapsed" class="result-elapsed"></span>
            </div>
          </div>
          <div id="test-summary" class="test-summary" aria-live="polite">Run the current class to see results.</div>
          <div id="failure-panel" class="failure-panel" role="alert" hidden>
            <strong id="failure-panel-title"></strong>
            <p id="failure-panel-message"></p>
          </div>
          <div id="test-list" class="test-list"></div>
          <div id="diagnostics" class="diagnostics"></div>
          <details id="raw-logs" class="raw-logs">
            <summary id="raw-logs-summary">Details / debug output</summary>
            <div class="result-columns">
              <div class="result-pane">
                <span class="result-label">stdout</span>
                <pre id="stdout"></pre>
              </div>
              <div class="result-pane">
                <span class="result-label">stderr</span>
                <pre id="stderr"></pre>
              </div>
            </div>
          </details>
          </section>
          <section id="git-panel" class="git-card" role="tabpanel" aria-labelledby="git-tab" hidden>
            <div class="git-toolbar">
              <div class="git-heading">
                <span class="git-branch-icon" aria-hidden="true">⑂</span>
                <strong id="git-branch">Git changes</strong>
                <span id="git-file-count" class="git-file-count"></span>
              </div>
              <div class="git-actions">
                <button id="git-refresh" class="icon-button" type="button" aria-label="Refresh Git changes" title="Refresh Git changes"></button>
                <button id="git-select-all" class="secondary-button" type="button">Select all</button>
                <button id="git-select-none" class="secondary-button" type="button">Clear</button>
              </div>
            </div>
            <div id="git-status" class="git-status" role="status" aria-live="polite"></div>
            <div class="git-workspace">
              <div id="git-file-list" class="git-file-list" aria-label="Changed files"></div>
              <div
                id="git-splitter"
                class="git-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize changed files pane"
                aria-valuemin="${MIN_GIT_FILE_LIST_WIDTH}"
                aria-valuemax="${DEFAULT_GIT_FILE_LIST_WIDTH + MIN_GIT_DIFF_WIDTH}"
                tabindex="0"
              ><span aria-hidden="true"></span></div>
              <div class="git-diff-pane">
                <div class="git-diff-heading">
                  <strong id="git-diff-file">Select a changed file</strong>
                  <span id="git-diff-state" class="git-diff-state"></span>
                </div>
                <div id="git-diff" class="git-diff" aria-label="Unified diff"></div>
              </div>
            </div>
            <div class="git-commit-bar">
              <label class="git-commit-field" for="git-commit-message">
                <span>Commit message</span>
                <input id="git-commit-message" type="text" autocomplete="off" spellcheck="false">
              </label>
              <div class="git-commit-actions">
                <button id="git-commit" class="primary-button" type="button">Commit</button>
                <button id="git-commit-push" class="secondary-button" type="button">Commit &amp; Push</button>
              </div>
            </div>
          </section>
        </section>
        <div id="file-context-menu" class="file-context-menu" role="menu" aria-label="File actions" hidden>
          <button id="delete-file-action" class="file-context-menu-item" type="button" role="menuitem">
            <span id="delete-file-label">Delete</span>
          </button>
        </div>
      </div>
    `
    this.installStaticIcons()
  }

  private installStaticIcons(): void {
    this.element<HTMLButtonElement>('#choose-repository').prepend(iconFor('folderOpen', 'button-icon'))
    this.element<HTMLButtonElement>('#refresh-files').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLElement>('#file-search-icon').append(iconFor('search', 'search-icon'))
    this.element<HTMLAnchorElement>('#problem-link').prepend(iconFor('externalLink', 'button-icon'))
    this.element<HTMLButtonElement>('#create-file').prepend(iconFor('filePlus', 'button-icon'))
    this.element<HTMLButtonElement>('#refresh-daily').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLButtonElement>('#run-test').prepend(iconFor('play', 'button-icon'))
    this.element<HTMLElement>('#raw-logs-summary').prepend(iconFor('terminal', 'button-icon'))
    this.element<HTMLButtonElement>('#git-refresh').append(iconFor('refresh', 'button-icon'))
  }

  private bindEvents(): void {
    this.element<HTMLButtonElement>('#choose-repository').addEventListener('click', () => {
      void this.chooseRepository()
    })
    this.element<HTMLButtonElement>('#refresh-files').addEventListener('click', () => {
      void this.refreshFiles()
    })
    this.element<HTMLButtonElement>('#refresh-daily').addEventListener('click', () => {
      void this.loadDailyProblem()
    })
    this.element<HTMLButtonElement>('#create-file').addEventListener('click', () => {
      void this.createFileForToday()
    })
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
    this.element<HTMLButtonElement>('#git-refresh').addEventListener('click', () => {
      void this.refreshGitStatus(true)
    })
    this.element<HTMLButtonElement>('#git-select-all').addEventListener('click', () => {
      this.selectAllGitFiles()
    })
    this.element<HTMLButtonElement>('#git-select-none').addEventListener('click', () => {
      this.selectNoGitFiles()
    })
    this.element<HTMLInputElement>('#git-commit-message').addEventListener('input', (event) => {
      this.state.git.commitMessage = (event.target as HTMLInputElement).value
      this.state.git.commitMessageEdited = true
      this.renderGitPanel()
    })
    this.element<HTMLButtonElement>('#git-commit').addEventListener('click', () => {
      void this.commitSelectedGitFiles(false)
    })
    this.element<HTMLButtonElement>('#git-commit-push').addEventListener('click', () => {
      void this.commitAndPushGitChanges()
    })
    this.element<HTMLButtonElement>('#delete-file-action').addEventListener('click', () => {
      void this.deleteContextMenuFile()
    })
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
    window.addEventListener('blur', this.handlePanelWindowBlur)
    window.addEventListener('resize', this.handleWindowResize)
    window.addEventListener('pointerdown', this.handleContextMenuOutside)
    window.addEventListener('keydown', this.handleContextMenuKeydown)
    window.addEventListener('keydown', this.handleGlobalKeydown)
  }

  private async chooseRepository(): Promise<void> {
    if (this.state.busy) {
      return
    }
    try {
      const selectedPath = await this.directoryPicker()
      if (selectedPath) {
        await this.selectRepository(selectedPath, true)
      }
    } catch (error) {
      this.setMessage(errorMessage(error), 'error')
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
      this.state.repoPath = null
      this.state.projectValid = false
      this.state.files = []
      this.state.fileSearch = ''
      this.resetGitState()
      this.resetCurrentFile()
    }
    this.setMessage('Checking repository…', 'info')
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
      const filesLoaded = await this.refreshFiles(false)
      if (filesLoaded) {
        this.setMessage('Repository ready.', 'success')
      }
    } catch (error) {
      this.state.projectValid = false
      this.setMessage(errorMessage(error), 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async loadDailyProblem(): Promise<void> {
    if (this.state.busy) {
      return
    }
    this.state.busy = true
    this.renderAll()
    try {
      this.state.dailyProblem = await this.backend.fetchDailyProblem()
      this.state.dailyError = null
      this.setMessage('Daily problem loaded.', 'success')
    } catch (error) {
      this.state.dailyProblem = null
      this.state.dailyError = errorMessage(error)
      this.setMessage(`Could not load today's problem: ${this.state.dailyError}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async refreshFiles(showMessage = true): Promise<boolean> {
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
      const selectedFileRemoved = Boolean(
        this.state.selectedPath && !files.some((file) => file.path === this.state.selectedPath),
      )
      if (selectedFileRemoved && !(await this.flushPendingSave())) {
        return false
      }
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.state.files = files
      this.markGitStale()
      if (selectedFileRemoved) {
        this.resetCurrentFile()
      }
      if (showMessage) {
        const javaFileCount = files.filter((file) => /\.java$/i.test(file.path)).length
        this.setMessage(`${javaFileCount} Java file${javaFileCount === 1 ? '' : 's'} found.`, 'success')
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

  private async openFile(file: ProblemFileEntry): Promise<void> {
    if (!this.state.repoPath) {
      return
    }
    if (file.path === this.state.selectedPath) {
      this.expandedGroups.add(file.packageSegment)
      this.renderFiles()
      this.editor.focus()
      return
    }
    this.state.busy = true
    this.state.testResult = null
    this.state.testRun = null
    this.testRunGeneration += 1
    this.editor.setIssues([])
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const source = await this.backend.readProblemFile(this.state.repoPath, file.path)
      this.state.selectedPath = file.path
      this.state.selectedSource = source
      this.state.savedSource = source
      this.state.selectedFqcn = fqcnFromJavaPath(file.path)
      this.state.dirty = false
      this.state.saveError = null
      this.suppressEditorChange = true
      try {
        this.editor.setValue(source)
      } finally {
        this.suppressEditorChange = false
      }
      this.editor.focus()
      this.setMessage(`Opened ${file.name}.`, 'success')
    } catch (error) {
      this.setMessage(`Could not open ${file.name}: ${errorMessage(error)}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async createFileForToday(): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (!this.state.repoPath || !this.state.projectValid || !this.state.dailyProblem) {
      this.setMessage('Choose a valid repository and load today’s problem first.', 'error')
      return
    }
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const problem = this.state.dailyProblem
      const plan = await createProblemWithRetry(this.backend, this.state.repoPath, {
        number: problem.frontendId,
        title: problem.title,
        difficulty: problem.difficulty,
        javaCodeSnippet: problem.javaSnippet,
      })
      this.markGitStale()
      await this.refreshFiles(false)
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
    this.state.dirty = source !== this.state.savedSource
    this.state.saveError = null
    if (activeRunId !== null) {
      this.discardStaleTestRun(activeRunId)
      this.renderResult()
    }
    this.autosave.schedule({
      repoPath: this.state.repoPath,
      filePath: this.state.selectedPath,
      source,
    })
    this.renderFileHeading()
  }

  private resetCurrentFile(): void {
    this.state.selectedPath = null
    this.state.selectedSource = ''
    this.state.savedSource = ''
    this.state.selectedFqcn = null
    this.state.dirty = false
    this.state.saveError = null
    this.state.testResult = null
    this.state.testRun = null
    this.testRunGeneration += 1
    this.editor.setIssues([])
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
    await this.backend.saveProblemFile(snapshot.repoPath, snapshot.filePath, snapshot.source)
    if (snapshot.repoPath !== this.state.repoPath || snapshot.filePath !== this.state.selectedPath) {
      return
    }
    this.state.savedSource = snapshot.source
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.state.saveError = null
    this.element<HTMLElement>('#editor-host').dataset.savedSource = snapshot.source
    this.markGitStale()
    this.renderFileHeading()
  }

  private handleSaveError(error: unknown): void {
    this.state.saveError = errorMessage(error)
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.setMessage(`Could not save the file: ${this.state.saveError}`, 'error')
    this.renderAll()
  }

  private async runCurrentTest(): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (!this.state.repoPath || !this.state.selectedPath || !this.state.selectedFqcn) {
      this.setMessage('Choose a Java file before running a test.', 'error')
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
    }
    this.state.testRun = run
    this.state.testResult = null
    this.editor.setIssues([])
    this.renderAll()
    this.setMessage(`Running ${this.state.selectedFqcn}…`, 'info')
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
          this.setMessage(`Could not save before running the test: ${run.error}`, 'error')
        }
        return
      }
      const result = await this.backend.runProblemTest(
        runRepoPath,
        runFqcn,
        (progress) => this.applyTestRunProgress(runId, progress),
      )
      if (!this.isCurrentTestRun(runId)) {
        return
      }
      if (!this.isTestRunSourceCurrent(runSnapshot)) {
        this.discardStaleTestRun(runId)
        return
      }
      this.state.testResult = result
      this.editor.setIssues(collectEditorIssues(result, runFilePath))
      run.status = 'completed'
      run.phase = result.phase
      run.tests = result.tests
      run.stdout = result.stdout
      run.stderr = result.stderr
      run.activeTest = null
      run.error = result.success ? null : testFailureMessage(result)
      this.setMessage(
        testResultBannerMessage(result),
        result.success ? 'success' : 'error',
      )
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
        this.setMessage(`Could not run the test: ${run.error}`, 'error')
      }
    } finally {
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
    this.renderedTestResult = null
    this.editor.setIssues([])
    this.setMessage('Test result discarded because the source changed while it was running.', 'info')
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
      && (this.state.git.loadedRepoPath !== this.state.repoPath || this.state.git.stale)
      && !this.state.busy && !this.state.git.loading) {
      void this.refreshGitStatus(false)
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
      || !this.state.git.stale
      || this.state.bottomPanelTab !== 'git'
      || !this.state.repoPath
      || !this.state.projectValid
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
        || this.state.busy
        || this.state.git.busy
        || this.state.git.loading
        || !this.state.git.stale) {
        return
      }
      // Consume this stale marker before attempting the request. If the
      // request fails, leave the error visible without retrying forever.
      this.state.git.stale = false
      void this.refreshGitStatus(false)
    }, GIT_REFRESH_DEBOUNCE_MS)
  }

  private clearScheduledGitRefresh(): void {
    if (this.gitRefreshTimer !== null) {
      clearTimeout(this.gitRefreshTimer)
      this.gitRefreshTimer = null
    }
  }

  private async refreshGitStatus(showMessage: boolean, allowBusy = false): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath || !this.state.projectValid) {
      this.state.git.error = 'Choose a valid repository before viewing Git changes.'
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
      this.state.git.error = 'Git integration is not available in this desktop build.'
      this.state.git.loadedRepoPath = repoPath
      this.renderGitPanel()
      return
    }
    const previousPaths = this.state.git.selectedPaths
    const previousDefault = defaultGitCommitMessage(previousPaths)
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
      if (!this.state.git.commitMessageEdited || this.state.git.commitMessage === previousDefault) {
        this.state.git.commitMessage = defaultGitCommitMessage(selectedPaths)
        this.state.git.commitMessageEdited = false
      }
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
      if (showMessage) {
        this.setMessage(
          snapshot.files.length === 0
            ? 'Working tree is clean.'
            : `${snapshot.files.length} Git change${snapshot.files.length === 1 ? '' : 's'} found.`,
          'success',
        )
      }
    } catch (error) {
      if (!this.isCurrentGitStatusRequest(repoPath, repositoryGeneration, requestId)) {
        return
      }
      this.state.git.error = errorMessage(error)
      if (showMessage) {
        this.setMessage(`Could not load Git changes: ${this.state.git.error}`, 'error')
      }
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
        this.state.git.error = 'Git diff is not available in this desktop build.'
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
    const previousDefault = defaultGitCommitMessage(this.state.git.selectedPaths)
    this.state.git.selectedPaths = paths.filter((path, index) => paths.indexOf(path) === index)
    this.state.git.error = null
    if (!this.state.git.commitMessageEdited || this.state.git.commitMessage === previousDefault) {
      this.state.git.commitMessage = defaultGitCommitMessage(this.state.git.selectedPaths)
      this.state.git.commitMessageEdited = false
    }
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
      this.state.git.error = 'Choose a valid repository before committing.'
      this.renderGitPanel()
      return
    }
    if (paths.length === 0) {
      this.state.git.error = 'Select at least one changed file to commit.'
      this.renderGitPanel()
      return
    }
    const gitBackend = this.backend as unknown as GitBackendClient
    const method = gitBackend.commitGitChanges ?? gitBackend.commitGit
    if (!method) {
      this.state.git.error = 'Git commit is not available in this desktop build.'
      this.renderGitPanel()
      return
    }
    const pushMethod = gitBackend.pushGit
    if (pushAfterCommit && !pushMethod) {
      this.state.git.error = 'Git push is not available in this desktop build.'
      this.renderGitPanel()
      return
    }
    const message = this.state.git.commitMessage.trim() || defaultGitCommitMessage(paths)
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.gitOperationId
    this.state.git.commitMessage = message
    this.state.busy = true
    this.state.git.busy = true
    this.state.git.error = null
    this.renderAll()
    let committed = false
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      await method(repoPath, paths, message)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      committed = true
      if (pushAfterCommit && pushMethod) {
        await pushMethod(repoPath)
      }
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.state.git.commitMessageEdited = false
      await this.refreshGitStatus(false, true)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.setMessage(
        pushAfterCommit
          ? `Committed and pushed ${paths.length} file${paths.length === 1 ? '' : 's'}.`
          : `Committed ${paths.length} file${paths.length === 1 ? '' : 's'}.`,
        'success',
      )
    } catch (error) {
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      const failure = errorMessage(error)
      // Git may have staged paths before a commit failure. Refresh the view so
      // the user can see that mutation while retaining the original error.
      await this.refreshGitStatus(false, true)
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
    const branch = this.element<HTMLElement>('#git-branch')
    branch.textContent = git.branch ? git.branch : 'Git changes'
    this.element<HTMLElement>('#git-file-count').textContent = git.files.length > 0
      ? `${git.files.length} changed`
      : ''
    const status = this.element<HTMLElement>('#git-status')
    status.className = 'git-status'
    if (git.error) {
      status.classList.add('is-error')
      status.textContent = git.error
    } else if (git.loading) {
      status.classList.add('is-loading')
      status.textContent = 'Loading Git changes…'
    } else if (git.diffLoading) {
      status.classList.add('is-loading')
      status.textContent = 'Loading unified diff…'
    } else if (git.stale) {
      status.classList.add('is-loading')
      status.textContent = 'Changes may be out of date. Refresh to update.'
    } else if (git.files.length === 0) {
      status.textContent = git.loadedRepoPath ? 'Working tree is clean.' : 'Open Git to inspect working-tree changes.'
    } else {
      status.textContent = `${git.selectedPaths.length} file${git.selectedPaths.length === 1 ? '' : 's'} selected for commit.`
    }

    const list = this.element<HTMLElement>('#git-file-list')
    list.innerHTML = ''
    if (git.loading) {
      const loading = document.createElement('div')
      loading.className = 'git-empty git-loading'
      loading.textContent = 'Loading changes…'
      list.append(loading)
    } else if (git.files.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'git-empty'
      empty.textContent = git.error ? 'Unable to load changes.' : 'No local changes.'
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
        statusBadge.className = `git-file-status git-file-status-${file.status}`
        statusBadge.textContent = gitStatusGlyph(file.status)
        statusBadge.setAttribute('aria-label', file.status)
        const fileName = document.createElement('span')
        fileName.className = 'git-file-name'
        fileName.textContent = gitFileName(file.path)
        const filePath = document.createElement('span')
        filePath.className = 'git-file-path'
        filePath.textContent = file.path
        const stats = document.createElement('span')
        stats.className = 'git-file-stats'
        stats.textContent = gitFileStats(file)
        fileButton.append(statusBadge, fileName, filePath, stats)
        row.append(checkbox, fileButton)
        list.append(row)
      }
    }

    const activeFile = git.files.find((file) => file.path === git.activePath)
    this.element<HTMLElement>('#git-diff-file').textContent = activeFile?.path ?? 'Select a changed file'
    this.element<HTMLElement>('#git-diff-state').textContent = activeFile ? activeFile.status : ''
    const diff = this.element<HTMLElement>('#git-diff')
    diff.innerHTML = ''
    if (git.diffLoading && activeFile && !git.diffByPath[activeFile.path]) {
      const loading = document.createElement('div')
      loading.className = 'git-empty git-loading'
      loading.textContent = 'Loading diff…'
      diff.append(loading)
    } else if (activeFile) {
      const text = git.diffByPath[activeFile.path] ?? ''
      if (text) {
        diff.append(renderUnifiedDiff(text))
      } else {
        const empty = document.createElement('div')
        empty.className = 'git-empty'
        empty.textContent = 'No diff is available for this file.'
        diff.append(empty)
      }
    } else {
      const empty = document.createElement('div')
      empty.className = 'git-empty'
      empty.textContent = git.files.length === 0 ? 'No changes to show.' : 'Select a changed file to view its diff.'
      diff.append(empty)
    }

    const input = this.element<HTMLInputElement>('#git-commit-message')
    if (input.value !== git.commitMessage) {
      input.value = git.commitMessage
    }
    input.disabled = this.state.busy || git.busy || git.files.length === 0
    this.element<HTMLButtonElement>('#git-commit').disabled = this.state.busy || git.busy || git.loading || git.selectedPaths.length === 0
    this.element<HTMLButtonElement>('#git-commit-push').disabled = this.state.busy || git.busy || git.loading || git.selectedPaths.length === 0
    this.element<HTMLButtonElement>('#git-refresh').disabled = this.state.busy || git.busy || git.loading || !this.state.projectValid
    this.element<HTMLButtonElement>('#git-select-all').disabled = this.state.busy || git.busy || git.loading || git.files.length === 0
    this.element<HTMLButtonElement>('#git-select-none').disabled = this.state.busy || git.busy || git.loading || git.selectedPaths.length === 0
    this.applyGitFileListWidth()
  }

  private renderAll(): void {
    this.cancelScheduledLiveRender()
    this.applyBottomPanelHeight()
    this.element<HTMLElement>('#repo-path').textContent = this.state.repoPath ?? 'Not selected'
    this.renderShortcutLabels()
    this.renderDailyProblem()
    this.renderFiles()
    this.renderFileHeading()
    this.renderResult()
    this.renderBottomPanelTabs()
    this.renderGitPanel()
    this.renderContextMenu()
    this.element<HTMLButtonElement>('#choose-repository').disabled = this.state.busy
    this.element<HTMLButtonElement>('#refresh-files').disabled = this.state.busy || !this.state.projectValid
    this.element<HTMLButtonElement>('#refresh-daily').disabled = this.state.busy
    this.element<HTMLButtonElement>('#create-file').disabled = this.state.busy || !this.state.projectValid || !this.state.dailyProblem
    this.element<HTMLButtonElement>('#run-test').disabled = this.state.busy || !this.state.selectedPath
    this.element<HTMLElement>('#editor-empty').hidden = Boolean(this.state.selectedPath)
    this.element<HTMLElement>('#editor-host').classList.toggle('is-empty', !this.state.selectedPath)
    this.scheduleGitRefreshIfNeeded()
  }

  private renderShortcutLabels(): void {
    const modifier = isMacPlatform() ? '⌘' : 'Ctrl+'
    this.element<HTMLElement>('#run-shortcut').textContent = `${modifier}R`
  }

  private renderDailyProblem(): void {
    const content = this.element<HTMLElement>('#daily-content')
    const link = this.element<HTMLAnchorElement>('#problem-link')
    if (!this.state.dailyProblem) {
      content.innerHTML = ''
      const message = document.createElement('p')
      message.className = this.state.dailyError ? 'error-copy' : 'muted-copy'
      message.textContent = this.state.dailyError
        ? `Could not load today’s problem: ${this.state.dailyError}`
        : 'Loading today’s problem…'
      content.append(message)
      link.hidden = true
      return
    }
    const problem = this.state.dailyProblem
    content.innerHTML = ''
    content.append(iconFor('calendar', 'daily-icon'))
    const number = document.createElement('span')
    number.className = 'problem-number'
    number.textContent = `#${problem.frontendId}`
    const title = document.createElement('strong')
    title.className = 'problem-title'
    title.textContent = problem.title
    const difficulty = document.createElement('span')
    difficulty.className = `difficulty difficulty-${problem.difficulty.toLowerCase()}`
    difficulty.textContent = problem.difficulty
    content.append(number, title, difficulty)
    link.href = problem.url
    link.hidden = false
  }

  private renderFiles(): void {
    const list = this.element<HTMLElement>('#file-list')
    list.innerHTML = ''
    const searchInput = this.element<HTMLInputElement>('#file-search')
    if (searchInput.value !== this.state.fileSearch) {
      searchInput.value = this.state.fileSearch
    }
    if (!this.state.projectValid) {
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'Select the repository folder to see your problems.'
      list.append(empty)
      return
    }

    const selectedGroup = this.state.files.find((file) => file.path === this.state.selectedPath)?.packageSegment
    if (selectedGroup && selectedGroup !== 'other') {
      this.expandedGroups.add(selectedGroup)
    }

    const searchTerm = this.state.fileSearch.trim()
    const javaFiles = this.state.files.filter((file) => /\.java$/i.test(file.path))
    const filteredFiles = filterProblemFiles(javaFiles, searchTerm)
    if (searchTerm && filteredFiles.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'No matches'
      list.append(empty)
      return
    }

    for (const group of FILE_GROUPS) {
      const files = filterProblemFilesByGroup(javaFiles, group.key, searchTerm)
      if (searchTerm && files.length === 0) {
        continue
      }
      const section = document.createElement('section')
      section.className = 'file-group'
      const isCurrentGroup = selectedGroup === group.key
      const expanded = isCurrentGroup || this.expandedGroups.has(group.key)
      section.dataset.expanded = String(expanded)

      const heading = document.createElement('div')
      heading.className = 'file-group-heading'
      const headingButton = document.createElement('button')
      headingButton.type = 'button'
      headingButton.className = 'file-group-toggle'
      headingButton.setAttribute('aria-expanded', String(expanded))
      headingButton.setAttribute('aria-controls', `file-group-${group.key}`)
      if (isCurrentGroup) {
        headingButton.title = 'The current file group stays open'
      }
      const groupLabel = document.createElement('span')
      groupLabel.className = 'file-group-label'
      groupLabel.append(
        iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'),
        document.createTextNode(group.label),
      )
      const count = document.createElement('span')
      count.className = 'file-count'
      count.textContent = String(files.length)
      headingButton.append(groupLabel, count)
      const updateGroupIcon = (nextExpanded: boolean): void => {
        const previous = groupLabel.querySelector('.group-toggle-icon')
        previous?.replaceWith(iconFor(nextExpanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'))
      }
      headingButton.addEventListener('click', () => {
        if (selectedGroup === group.key) {
          this.expandedGroups.add(group.key)
          section.dataset.expanded = 'true'
          headingButton.setAttribute('aria-expanded', 'true')
          groupList.hidden = false
          updateGroupIcon(true)
          return
        }
        const nextExpanded = !this.expandedGroups.has(group.key)
        if (nextExpanded) {
          this.expandedGroups.add(group.key)
        } else {
          this.expandedGroups.delete(group.key)
        }
        section.dataset.expanded = String(nextExpanded)
        headingButton.setAttribute('aria-expanded', String(nextExpanded))
        groupList.hidden = !nextExpanded
        updateGroupIcon(nextExpanded)
      })
      heading.append(headingButton)
      section.append(heading)
      const groupList = document.createElement('div')
      groupList.className = 'file-group-list'
      groupList.id = `file-group-${group.key}`
      groupList.hidden = !expanded
      for (const file of files) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'file-item'
        button.classList.toggle('is-active', file.path === this.state.selectedPath)
        button.disabled = this.state.busy
        button.setAttribute('aria-haspopup', 'menu')
        button.dataset.path = file.path
        button.title = file.path
        const fileName = document.createElement('span')
        fileName.className = 'file-item-name'
        fileName.textContent = file.name.replace(/\.java$/i, '')
        button.append(
          iconFor('fileCode', 'file-item-icon'),
          fileName,
        )
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
    this.state.contextMenu = {
      file,
      x,
      y,
    }
    this.renderContextMenu()
    this.element<HTMLButtonElement>('#delete-file-action').focus()
  }

  private closeFileContextMenu(): void {
    if (!this.state.contextMenu) {
      return
    }
    this.state.contextMenu = null
    this.renderContextMenu()
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
    // Keep the menu action compact. The confirmation dialog below contains
    // the target filename, while the context menu only needs to expose the
    // action itself.
    this.element<HTMLElement>('#delete-file-label').textContent = 'Delete'
    this.element<HTMLButtonElement>('#delete-file-action').disabled = this.state.busy
  }

  private async deleteContextMenuFile(): Promise<void> {
    const context = this.state.contextMenu
    const repoPath = this.state.repoPath
    if (!context || !repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const method = (this.backend as unknown as FileManagementBackend).deleteProblemFile
    if (!method) {
      this.closeFileContextMenu()
      this.setMessage('File deletion is not available in this desktop build.', 'error')
      return
    }
    if (!confirmDeleteFile(context.file.name)) {
      return
    }
    const file = context.file
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.gitOperationId
    this.closeFileContextMenu()
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave()) || !this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      await method(repoPath, file.path)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      if (this.state.selectedPath === file.path) {
        this.resetCurrentFile()
      }
      this.markGitStale()
      await this.refreshFiles(false)
      if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        return
      }
      this.setMessage(`Deleted ${file.name}.`, 'success')
    } catch (error) {
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
        // A backend can report an error after the filesystem mutation has
        // already completed. Re-list files before reporting so the explorer
        // reflects the actual repository state.
        await this.refreshFiles(false)
        if (!this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
          return
        }
        this.setMessage(`Could not delete ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (this.isCurrentGitOperation(repoPath, repositoryGeneration, operationId)) {
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
      active.scrollIntoView?.({ block: 'nearest' })
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scroll)
    } else {
      queueMicrotask(scroll)
    }
  }

  private renderFileHeading(): void {
    const selectedFile = this.element<HTMLElement>('#selected-file')
    const file = this.state.files.find((entry) => entry.path === this.state.selectedPath)
    selectedFile.textContent = file?.name ?? 'No file selected'
    const dirty = this.element<HTMLElement>('#dirty-indicator')
    dirty.hidden = !this.state.dirty || this.autosave.status === 'saving'
    const saveStatus = this.element<HTMLElement>('#save-status')
    saveStatus.className = 'save-status'
    if (this.state.saveError) {
      saveStatus.classList.add('is-error')
      saveStatus.textContent = 'Save failed'
      saveStatus.title = this.state.saveError
    } else if (this.autosave.status === 'saving') {
      saveStatus.classList.add('is-saving')
      saveStatus.textContent = 'Saving…'
      saveStatus.removeAttribute('title')
    } else {
      saveStatus.textContent = ''
      saveStatus.removeAttribute('title')
    }
    this.element<HTMLElement>('#editor-host').dataset.savedSource = this.state.savedSource
  }

  private renderResult(): void {
    const resultsCard = this.element<HTMLElement>('.results-card')
    const status = this.element<HTMLElement>('#result-status')
    const badge = this.element<HTMLElement>('#result-badge')
    const phaseElement = this.element<HTMLElement>('#result-phase')
    const elapsedElement = this.element<HTMLElement>('#result-elapsed')
    const summaryElement = this.element<HTMLElement>('#test-summary')
    const failurePanel = this.element<HTMLElement>('#failure-panel')
    const failurePanelTitle = this.element<HTMLElement>('#failure-panel-title')
    const failurePanelMessage = this.element<HTMLElement>('#failure-panel-message')
    const testList = this.element<HTMLElement>('#test-list')
    const diagnosticsElement = this.element<HTMLElement>('#diagnostics')
    const stdout = this.element<HTMLElement>('#stdout')
    const stderr = this.element<HTMLElement>('#stderr')
    const rawLogs = this.element<HTMLDetailsElement>('#raw-logs')
    const liveRun = this.state.testRun?.status === 'running' ? this.state.testRun : null
    const result = this.state.testResult ?? (liveRun ? liveSnapshotResult(liveRun) : null)
    status.className = 'result-status'
    status.removeAttribute('title')
    badge.className = 'result-badge'
    badge.textContent = '·'
    phaseElement.textContent = 'No run yet'
    elapsedElement.textContent = ''
    summaryElement.textContent = ''
    failurePanel.hidden = true
    failurePanelTitle.textContent = ''
    failurePanelMessage.textContent = ''
    testList.innerHTML = ''
    diagnosticsElement.innerHTML = ''
    resultsCard.setAttribute('aria-busy', liveRun ? 'true' : 'false')
    if (!result) {
      status.textContent = 'No run yet'
      summaryElement.textContent = 'Run the current class to see results.'
      stdout.textContent = ''
      stderr.textContent = ''
      rawLogs.open = false
      this.renderedTestResult = null
      return
    }
    const presentation = presentTestResult(result)
    const isRunning = liveRun !== null
    const isRunnerError = this.state.testRun?.status === 'error'
      || normalizeTestPhase(result.phase) === 'runner'
    const hasFailure = !result.success || isRunnerError
    const statusClass = isRunning ? 'is-running' : hasFailure ? 'is-failure' : 'is-success'
    status.classList.add(statusClass)
    badge.classList.add(statusClass)
    badge.textContent = isRunning ? '◌' : !hasFailure ? '✓' : isRunnerError || result.summary.errors > 0 ? '!' : '×'
    status.textContent = isRunning
      ? 'Running'
      : isRunnerError
        ? 'Error'
        : hasFailure
          ? 'Failed'
          : 'Passed'
    phaseElement.textContent = isRunning
      ? `· ${testPhaseLabel(result.phase)}`
      : testPhaseLabel(result.phase) === 'Tests' ? '' : testPhaseLabel(result.phase)
    if (isRunning) {
      elapsedElement.textContent = formatDuration(result.summary.durationMs ?? 0)
    } else if (result.summary.durationMs !== null && result.summary.durationMs !== undefined) {
      elapsedElement.textContent = formatDuration(result.summary.durationMs)
    }
    const isAssertionFailure = normalizeTestPhase(result.phase) === 'test'
    const hasFailedTests = result.tests.some((test) => test.status === 'failed' || test.status === 'error')
    if (!isRunning && !result.success && presentation.failureMessage) {
      status.title = presentation.failureMessage
    }
    // Keep Details / debug output closed by default and preserve any manual
    // open state while live progress updates replace its contents.
    this.renderedTestResult = result
    const summary = result.summary
    this.renderSummaryBadges(summaryElement, summary, isRunning)

    if (!isRunning && !result.success && (!isAssertionFailure || !hasFailedTests) && presentation.failureMessage) {
      failurePanel.hidden = false
      failurePanelTitle.textContent = normalizeTestPhase(result.phase) === 'noTests'
        ? 'No tests found'
        : `${presentation.phaseLabel} failed`
      failurePanelMessage.textContent = presentation.failureMessage
    }

    const visibleTests = defaultVisibleTests(result.tests, isRunning)
    this.renderTestGroups(testList, visibleTests.tests)
    if (visibleTests.hiddenCount > 0) {
      const hidden = document.createElement('div')
      hidden.className = 'test-filter-note'
      hidden.textContent = `${visibleTests.hiddenCount} non-failing test${visibleTests.hiddenCount === 1 ? '' : 's'} hidden`
      testList.append(hidden)
    }
    if (isRunning && result.tests.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'test-empty test-empty-running'
      empty.textContent = `Running · ${testPhaseLabel(result.phase)}…`
      testList.append(empty)
    } else if (!isRunning && result.tests.length === 0 && result.phase !== 'compile') {
      const empty = document.createElement('div')
      empty.className = 'test-empty'
      empty.textContent = 'No tests were reported.'
      testList.append(empty)
    }
    const diagnostics = filterTestDiagnostics(result.diagnostics)
    if (diagnostics.length > 0) {
      const details = document.createElement('details')
      details.className = 'diagnostics-details'
      const heading = document.createElement('summary')
      heading.textContent = `Diagnostics (${diagnostics.length})`
      details.append(heading)
      for (const diagnostic of diagnostics) {
        details.append(this.renderDiagnostic(diagnostic))
      }
      diagnosticsElement.append(details)
    }
    stdout.textContent = result.stdout || '(no stdout)'
    stderr.textContent = result.stderr || '(no stderr)'
  }

  private renderSummaryBadges(
    container: HTMLElement,
    summary: TestResult['summary'],
    isRunning: boolean,
  ): void {
    const parts: Array<{ label: string; value: number; className: string }> = [
      { label: 'total', value: summary.total, className: 'summary-total' },
      { label: 'passed', value: summary.passed, className: 'summary-passed' },
      { label: 'failed', value: summary.failed, className: 'summary-failed' },
      { label: 'errors', value: summary.errors, className: 'summary-errors' },
      { label: 'skipped', value: summary.skipped, className: 'summary-skipped' },
    ]
    const visibleParts = parts.filter((part) => part.value > 0)
    for (const part of visibleParts) {
      const badge = document.createElement('span')
      badge.className = `summary-badge ${part.className}`
      badge.textContent = `${part.value} ${part.label}`
      container.append(badge)
    }
    if (summary.durationMs !== null && summary.durationMs !== undefined) {
      const duration = document.createElement('span')
      duration.className = 'summary-duration'
      duration.textContent = isRunning ? `· ${formatDuration(summary.durationMs)}` : formatDuration(summary.durationMs)
      container.append(duration)
    }
    if (visibleParts.length === 0 && (summary.durationMs === null || summary.durationMs === undefined)) {
      const empty = document.createElement('span')
      empty.className = 'summary-empty'
      empty.textContent = isRunning ? 'Waiting for test results…' : 'No tests reported.'
      container.append(empty)
    }
  }

  private renderTestGroups(container: HTMLElement, tests: TestCaseResult[]): void {
    const groups = new Map<string, TestCaseResult[]>()
    for (const test of tests) {
      const className = test.className || this.state.selectedFqcn || 'Tests'
      const group = groups.get(className) ?? []
      group.push(test)
      groups.set(className, group)
    }
    for (const [className, group] of groups) {
      const suite = document.createElement('details')
      suite.className = 'test-suite'
      suite.open = true
      const heading = document.createElement('summary')
      heading.className = 'test-suite-summary'
      const suiteIcon = document.createElement('span')
      suiteIcon.className = 'test-suite-icon'
      suiteIcon.textContent = '▾'
      suiteIcon.setAttribute('aria-hidden', 'true')
      const suiteName = document.createElement('span')
      suiteName.className = 'test-suite-name'
      suiteName.textContent = className
      const suiteCount = document.createElement('span')
      suiteCount.className = 'test-suite-count'
      suiteCount.textContent = `${group.length} test${group.length === 1 ? '' : 's'}`
      heading.append(suiteIcon, suiteName, suiteCount)
      suite.append(heading)
      const children = document.createElement('div')
      children.className = 'test-suite-children'
      for (const test of group) {
        children.append(this.renderTestCase(test))
      }
      suite.append(children)
      container.append(suite)
    }
  }

  private renderTestCase(test: TestCaseResult): HTMLElement {
    const failed = test.status === 'failed' || test.status === 'error'
    const hasOutput = testCaseHasOutput(test)
    const hasDetail = failed || Boolean(
      test.message || test.details || test.expected || test.actual || (test.file && test.line),
    ) || hasOutput
    const row = hasDetail ? document.createElement('details') : document.createElement('div')
    row.className = `test-row test-row-${test.status}`

    const summary = document.createElement(hasDetail ? 'summary' : 'div')
    summary.className = 'test-row-summary'
    summary.append(this.statusIcon(test.status))
    const name = document.createElement('span')
    name.className = 'test-name'
    name.textContent = test.displayName || test.name
    summary.append(name)
    if (test.durationMs !== null && test.durationMs !== undefined) {
      const duration = document.createElement('span')
      duration.className = 'test-duration'
      duration.textContent = formatDuration(test.durationMs)
      summary.append(duration)
    }
    row.append(summary)

    if (failed && row instanceof HTMLDetailsElement) {
      row.open = true
    }
    if (hasDetail && row instanceof HTMLDetailsElement) {
      const detail = document.createElement('div')
      detail.className = 'test-failure-detail'
      const failureSummary = conciseTestFailureMessage(test)
      if (failureSummary) {
        const message = document.createElement('p')
        message.className = 'failure-message'
        message.textContent = failureSummary
        detail.append(message)
      }
      if (test.expected !== null && test.expected !== undefined) {
        detail.append(this.renderValue('Expected', test.expected, 'expected-value'))
      }
      if (test.actual !== null && test.actual !== undefined) {
        detail.append(this.renderValue('Actual', test.actual, 'actual-value'))
      }
      if (test.details) {
        const relevantFrames = relevantTestStackFrames(test.details)
        if (relevantFrames.length > 0) {
          const userFrames = document.createElement('pre')
          userFrames.className = 'test-user-frames'
          userFrames.textContent = relevantFrames.join('\n')
          detail.append(userFrames)
        }
        const fullStack = document.createElement('details')
        fullStack.className = 'test-full-stack'
        const fullStackSummary = document.createElement('summary')
        fullStackSummary.textContent = 'Full stack trace'
        const stacktrace = document.createElement('pre')
        stacktrace.className = 'test-stacktrace'
        stacktrace.textContent = test.details
        fullStack.append(fullStackSummary, stacktrace)
        detail.append(fullStack)
      }
      if (hasOutput) {
        const outputGrid = document.createElement('div')
        outputGrid.className = 'test-output'
        for (const [label, value] of [['stdout', test.stdout], ['stderr', test.stderr]] as const) {
          if (!value) {
            continue
          }
          const pane = document.createElement('div')
          pane.className = `test-output-pane test-output-${label}`
          const outputLabel = document.createElement('span')
          outputLabel.className = 'test-output-label'
          outputLabel.textContent = label
          const output = document.createElement('pre')
          output.className = 'test-output-content'
          output.textContent = value
          pane.append(outputLabel, output)
          outputGrid.append(pane)
        }
        detail.append(outputGrid)
      }
      if (test.file && validSourceLine(test.line) !== null) {
        detail.append(this.renderLocation(test.file, validSourceLine(test.line)!, test.column))
      }
      row.append(detail)
    }
    return row
  }

  private renderValue(label: string, value: string, className: string): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = `failure-value ${className}`
    const title = document.createElement('span')
    title.className = 'failure-value-label'
    title.textContent = `${label}:`
    const content = document.createElement('code')
    content.textContent = value
    wrapper.append(title, content)
    return wrapper
  }

  private renderDiagnostic(diagnostic: TestDiagnostic): HTMLElement {
    const row = document.createElement('div')
    row.className = `diagnostic diagnostic-${diagnostic.severity}`
    const icon = document.createElement('span')
    icon.className = 'diagnostic-icon'
    icon.textContent = diagnostic.severity === 'warning' ? '!' : '×'
    icon.setAttribute('aria-hidden', 'true')
    const message = document.createElement('span')
    message.className = 'diagnostic-message'
    message.textContent = diagnostic.message
    row.append(icon, message)
    if (diagnostic.file && validSourceLine(diagnostic.line) !== null) {
      row.append(this.renderLocation(diagnostic.file, validSourceLine(diagnostic.line)!, diagnostic.column))
    }
    return row
  }

  private renderLocation(file: string, line: number, column?: number | null): HTMLElement {
    const location = document.createElement('button')
    location.type = 'button'
    location.className = 'result-location'
    const matchesCurrentFile = Boolean(this.state.selectedPath && sourcePathsMatch(this.state.selectedPath, file))
    location.append(
      iconFor('locate', 'result-location-icon'),
      document.createTextNode(`${file}:${line}${column ? `:${column}` : ''}`),
    )
    if (matchesCurrentFile) {
      location.title = 'Reveal this line in the editor'
      location.addEventListener('click', () => {
        this.editor.revealLine(line, column)
      })
    } else {
      location.disabled = true
      location.title = 'This location belongs to another source file'
    }
    return location
  }

  private statusIcon(status: string): HTMLElement {
    const icon = document.createElement('span')
    icon.className = `test-status-icon test-status-${status}`
    icon.textContent = status === 'passed'
      ? '✓'
      : status === 'failed'
        ? '×'
        : status === 'error'
          ? '!'
          : status === 'skipped'
            ? '–'
            : status === 'running'
              ? '◌'
              : '·'
    icon.setAttribute('aria-label', status)
    return icon
  }

  private setMessage(message: string, tone: 'info' | 'success' | 'error'): void {
    const status = this.element<HTMLElement>('#app-status')
    status.textContent = message
    status.dataset.tone = tone
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`Missing editor element: ${selector}`)
    }
    return element
  }
}

function fqcnFromJavaPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const root = 'src/main/java/'
  const rootIndex = normalized.indexOf(root)
  if (rootIndex < 0 || !normalized.toLowerCase().endsWith('.java')) {
    return null
  }
  return normalized
    .slice(rootIndex + root.length, -'.java'.length)
    .split('/')
    .filter(Boolean)
    .join('.')
}

async function defaultDirectoryPicker(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select your leetcoder repository',
  })
  if (Array.isArray(selected)) {
    return selected[0] ?? null
  }
  return selected
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }
  return `${(durationMs / 1000).toFixed(2)}s`
}

function gitStatusGlyph(status: string): string {
  switch (normalizeGitStatusLabel(status)) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'conflicted':
      return 'U'
    case 'untracked':
      return '?'
    default:
      return 'M'
  }
}

function gitFileStats(file: GitChangedFile): string {
  const parts: string[] = []
  if (file.additions !== null) parts.push(`+${file.additions}`)
  if (file.deletions !== null) parts.push(`-${file.deletions}`)
  return parts.join(' ')
}

export function deleteFileConfirmationMessage(fileName: string): string {
  return `Delete ${fileName}?\n\nThis cannot be undone.`
}

function confirmDeleteFile(fileName: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false
  }
  return window.confirm(deleteFileConfirmationMessage(fileName))
}

function renderUnifiedDiff(diff: string): HTMLElement {
  const fragment = document.createDocumentFragment()
  let oldLine = 0
  let newLine = 0
  for (const line of diff.split(/\r?\n/)) {
    const row = document.createElement('div')
    row.className = `git-diff-line ${gitDiffLineClass(line)}`
    const oldNumber = document.createElement('span')
    oldNumber.className = 'git-diff-line-number git-diff-old-line'
    const newNumber = document.createElement('span')
    newNumber.className = 'git-diff-line-number git-diff-new-line'
    const content = document.createElement('code')
    content.className = 'git-diff-line-content'
    content.textContent = line || ' '

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    const noNewlineMarker = line === '\\ No newline at end of file'
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
    } else if (noNewlineMarker) {
      // This metadata line belongs to the preceding file line and does not
      // consume a source line in either side of the hunk.
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      newNumber.textContent = String(newLine++)
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      oldNumber.textContent = String(oldLine++)
    } else if (!line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++')) {
      if (line.length > 0) {
        oldNumber.textContent = String(oldLine++)
        newNumber.textContent = String(newLine++)
      }
    }
    row.append(oldNumber, newNumber, content)
    fragment.append(row)
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'git-diff-lines'
  wrapper.append(fragment)
  return wrapper
}

function gitDiffLineClass(line: string): string {
  if (line === '\\ No newline at end of file') return 'is-no-newline'
  if (line.startsWith('@@')) return 'is-hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-file-header'
  if (line.startsWith('+')) return 'is-addition'
  if (line.startsWith('-')) return 'is-deletion'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ')) {
    return 'is-metadata'
  }
  return 'is-context'
}

export function clampBottomPanelHeight(value: number, viewportHeight = windowHeight()): number {
  const usableViewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800
  const maximum = Math.max(MIN_BOTTOM_PANEL_HEIGHT, Math.min(MAX_BOTTOM_PANEL_HEIGHT, Math.round(usableViewport * .8)))
  const candidate = Number.isNaN(value) ? DEFAULT_BOTTOM_PANEL_HEIGHT : value
  return Math.round(Math.min(maximum, Math.max(MIN_BOTTOM_PANEL_HEIGHT, candidate)))
}

export function clampGitFileListWidth(value: number, availableWidth = 900): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  const maximum = maxGitFileListWidth(usableWidth)
  const candidate = Number.isNaN(value) ? DEFAULT_GIT_FILE_LIST_WIDTH : value
  return Math.round(Math.min(maximum, Math.max(MIN_GIT_FILE_LIST_WIDTH, candidate)))
}

function maxGitFileListWidth(availableWidth: number): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  return Math.max(MIN_GIT_FILE_LIST_WIDTH, Math.round(usableWidth - MIN_GIT_DIFF_WIDTH - GIT_SPLITTER_WIDTH - GIT_WORKSPACE_GAP))
}

function maxBottomPanelHeight(): number {
  return clampBottomPanelHeight(MAX_BOTTOM_PANEL_HEIGHT)
}

function readBottomPanelHeight(storage: Storage | undefined): number {
  const value = storage?.getItem(BOTTOM_PANEL_HEIGHT_KEY)
  const parsed = value ? Number(value) : DEFAULT_BOTTOM_PANEL_HEIGHT
  return clampBottomPanelHeight(Number.isFinite(parsed) ? parsed : DEFAULT_BOTTOM_PANEL_HEIGHT)
}

function readGitFileListWidth(storage: Storage | undefined): number {
  const value = storage?.getItem(GIT_FILE_LIST_WIDTH_KEY)
  const parsed = value ? Number(value) : DEFAULT_GIT_FILE_LIST_WIDTH
  return clampGitFileListWidth(Number.isFinite(parsed) ? parsed : DEFAULT_GIT_FILE_LIST_WIDTH)
}

function windowHeight(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight) || window.innerHeight <= 0) {
    return 800
  }
  return window.innerHeight
}

export { fqcnFromJavaPath }

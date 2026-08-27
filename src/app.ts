import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import {
  createBackendClient,
  errorMessage,
  normalizeGitCommitResult,
  normalizeGitPushResult,
  type BackendClient,
  type DailyProblem,
  type GitCommitResult,
  type GitPushResult,
  type ProblemFileEntry,
  type TestResult,
  type TestCaseResult,
  type TestDiagnostic,
  type TestPhase,
  type TestRunProgress,
  type RepositoryFilesChanged,
} from './backend'
import { classNameFromProblem } from './domain'
import { JavaEditor, isShortcutHelpAltShortcut, type EditorIssue } from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'
import { sanitizeProblemHtml } from './sanitize'
import {
  SHORTCUT_SECTIONS,
  formatShortcut,
  platformBindings,
  shortcutHints,
  shortcutLabel,
} from './shortcuts'

const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const BOTTOM_PANEL_HEIGHT_KEY = 'leetcoder.bottom-panel-height'
const GIT_FILE_LIST_WIDTH_KEY = 'leetcoder.git-file-list-width'
const SIDEBAR_WIDTH_KEY = 'leetcoder.sidebar-width'
const DAILY_DESCRIPTION_KEY = 'leetcoder.daily-description'
const DAILY_DESCRIPTION_HEIGHT_KEY = 'leetcoder.daily-description-height'
const DEFAULT_BOTTOM_PANEL_HEIGHT = 280
const MIN_BOTTOM_PANEL_HEIGHT = 180
const MAX_BOTTOM_PANEL_HEIGHT = 640
const DEFAULT_GIT_FILE_LIST_WIDTH = 300
const MIN_GIT_FILE_LIST_WIDTH = 180
const MIN_GIT_DIFF_WIDTH = 260
const GIT_SPLITTER_WIDTH = 7
const GIT_WORKSPACE_GAP = 16
const DEFAULT_SIDEBAR_WIDTH = 248
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 520
const MIN_EDITOR_WIDTH = 360
const SIDEBAR_SPLITTER_WIDTH = 7
const DEFAULT_DAILY_DESCRIPTION_HEIGHT = 220
const MIN_DAILY_DESCRIPTION_HEIGHT = 120
const MAX_DAILY_DESCRIPTION_HEIGHT = 560
const MIN_CODE_CARD_HEIGHT = 180
const DAILY_DESCRIPTION_LAYOUT_OVERHEAD = 86
const DAILY_DESCRIPTION_SPLITTER_HEIGHT = 7
const TEST_RUN_ROOT_KEY = '__leetcoder_test_run__'
const GIT_REFRESH_DEBOUNCE_MS = 250
const GIT_POLL_INTERVAL_MS = 4000
const DAILY_RETRY_INTERVAL_MS = 60_000
const FILE_CONTEXT_MENU_WIDTH = 156
const FILE_CONTEXT_MENU_HEIGHT = 108
const GIT_CONTEXT_MENU_WIDTH = 190
const GIT_CONTEXT_MENU_HEIGHT = 76
const VIEWPORT_MARGIN = 8
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

/**
 * Return the only group allowed to stay open in the file explorer accordion.
 * Keeping this transition pure makes the one-open-group rule easy to reuse
 * when the UI is rendered after a file open or refresh.
 */
export function accordionGroupKeys(
  group: ProblemFileEntry['packageSegment'],
  expanded: boolean,
): ProblemFileEntry['packageSegment'][] {
  return expanded ? [group] : []
}

/**
 * Pick the tab that should replace a closed tab. The index is from the tab
 * list before removal; after removal that index points at the tab on the
 * right, or the final remaining tab on the left when the closed tab was last.
 */
export function replacementTabIndex(remainingCount: number, closedIndex: number): number | null {
  if (remainingCount <= 0 || closedIndex < 0 || closedIndex > remainingCount) {
    return null
  }
  return closedIndex < remainingCount ? closedIndex : remainingCount - 1
}

/** The keyboard fields needed to recognize the platform-specific tab-close shortcut. */
export interface TabCloseShortcutEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/**
 * Match only Cmd+W on Apple platforms and Alt+W everywhere else. Keeping the
 * platform and event data as arguments makes the shortcut behavior testable
 * without depending on the host browser's navigator or KeyboardEvent.
 */
export function isCloseTabShortcut(
  event: TabCloseShortcutEvent,
  macPlatform: boolean,
): boolean {
  if (event.key.toLowerCase() !== 'w' || event.shiftKey) {
    return false
  }
  return macPlatform
    ? event.metaKey && !event.altKey && !event.ctrlKey
    : event.altKey && !event.metaKey && !event.ctrlKey
}

/** Match the platform-specific close-all-tabs shortcut without reading browser globals. */
export function isCloseAllTabsShortcut(
  event: TabCloseShortcutEvent,
  macPlatform: boolean,
): boolean {
  if (event.key.toLowerCase() !== 'w' || !event.shiftKey) {
    return false
  }
  return macPlatform
    ? event.metaKey && !event.altKey && !event.ctrlKey
    : event.altKey && !event.metaKey && !event.ctrlKey
}

/** Whether a wheel event should move the open-file tab strip horizontally. */
export function isFileTabsShiftWheel(
  event: Pick<WheelEvent, 'deltaY' | 'shiftKey'>,
): boolean {
  return event.shiftKey && event.deltaY !== 0
}

export type DirectoryPicker = () => Promise<string | null>

/**
 * Allows only one native repository picker at a time. Native pickers can be
 * hidden by another window on some Linux desktops, so repeated clicks must
 * not create an unbounded stack of dialogs while the first request is open.
 */
export class RepositoryPickerCoordinator {
  private pending = false

  get isOpen(): boolean {
    return this.pending
  }

  open(picker: DirectoryPicker): Promise<string | null> | null {
    if (this.pending) {
      return null
    }
    this.pending = true
    return (async (): Promise<string | null> => {
      try {
        return await picker()
      } finally {
        this.pending = false
      }
    })()
  }
}

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
  discardGitChanges?: (projectRoot: string, path: string) => Promise<void>
  showInFileManager?: (projectRoot: string, path: string) => Promise<void>
  commitGitChanges?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  commitGit?: (projectRoot: string, paths: string[], message: string) => Promise<unknown>
  pushGit?: (projectRoot: string) => Promise<unknown>
}

interface TestRunnerBackend {
  runProblemTest: (
    projectRoot: string,
    fullyQualifiedClassName: string,
    onProgress?: (progress: TestRunProgress) => void,
    testMethod?: string,
  ) => Promise<TestResult>
}

interface FileManagementBackend {
  deleteProblemFile?: (projectRoot: string, path: string) => Promise<unknown>
  duplicateProblemFile?: (projectRoot: string, path: string) => Promise<unknown>
  renameProblemFile?: (projectRoot: string, path: string, newName: string) => Promise<unknown>
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

interface GitContextMenuState {
  file: GitChangedFile
  x: number
  y: number
}

/** Metadata for a file that is open in the editor tab strip. */
interface OpenFileTab {
  id: number
  path: string
  name: string
  packageSegment: ProblemFileEntry['packageSegment']
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
 * the selectable test tree. The full process output remains available from
 * the Test run item in that tree.
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
    return 'All tests passed'
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

function testStatusLabel(status: string): string {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'error':
      return 'error'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    default:
      return status || 'unknown'
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

export type TestOutputStream = 'stdout' | 'stderr'

export interface TestOutputSegment {
  stream: TestOutputStream
  text: string
}

/**
 * Return the non-empty output streams in the order used by the test console.
 * ANSI-only and whitespace-only values are omitted, while meaningful output
 * stays byte-for-byte intact except for a needed separator at the stream
 * boundary.
 */
export function testOutputSegments(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
): TestOutputSegment[] {
  const segments: TestOutputSegment[] = []
  for (const [stream, value] of [
    ['stdout', stdout],
    ['stderr', stderr],
  ] as const) {
    const text = stripAnsi(value ?? '')
    if (text.trim().length === 0) {
      continue
    }
    segments.push({ stream, text })
  }
  if (segments.length > 1 && !/[\r\n]$/.test(segments[0].text)) {
    segments[0] = { ...segments[0], text: `${segments[0].text}\n` }
  }
  return segments
}

/** Whether a testcase has output worth showing in its detail console. */
export function testCaseHasOutput(test: TestCaseResult): boolean {
  return testOutputSegments(test.stdout, test.stderr).length > 0
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

/**
 * Every test stays visible. For a finished run the list is bucketed so the
 * actionable rows come first (failed, then errors, then passed, then
 * skipped/other) while report order is preserved within each bucket. A live
 * run keeps arrival order so rows do not jump while results stream in.
 */
export function defaultVisibleTests(
  tests: TestCaseResult[],
  isRunning = false,
): TestCaseResult[] {
  if (isRunning) {
    return tests
  }
  const bucket = (test: TestCaseResult): number => {
    switch (test.status) {
      case 'failed':
        return 0
      case 'error':
        return 1
      case 'skipped':
        return 3
      default:
        return 2
    }
  }
  return tests
    .map((test, index) => ({ test, index }))
    .sort((left, right) => bucket(left.test) - bucket(right.test) || left.index - right.index)
    .map((entry) => entry.test)
}

/**
 * Character-level diff for single-line Expected/Actual values: the common
 * prefix and suffix stay plain while the differing middle of each value is
 * highlighted. Returns null when a character diff would not help (multi-line
 * values or equal strings).
 */
export function charDiffSegments(
  expected: string,
  actual: string,
): { prefix: string; expectedMid: string; actualMid: string; suffix: string } | null {
  if (expected === actual || expected.includes('\n') || actual.includes('\n')) {
    return null
  }
  let prefix = 0
  const maxPrefix = Math.min(expected.length, actual.length)
  while (prefix < maxPrefix && expected[prefix] === actual[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < maxPrefix - prefix
    && expected[expected.length - 1 - suffix] === actual[actual.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    prefix: expected.slice(0, prefix),
    expectedMid: expected.slice(prefix, expected.length - suffix),
    actualMid: actual.slice(prefix, actual.length - suffix),
    suffix: expected.slice(expected.length - suffix),
  }
}

/**
 * Find the sidebar entry that already solves today's problem: the class name
 * must be the problem's base class name or the base name plus a numeric
 * collision suffix (the repository convention for repeat solves).
 */
export function findTodayProblemFile(
  files: ProblemFileEntry[],
  problem: Pick<DailyProblem, 'frontendId' | 'title'>,
): ProblemFileEntry | null {
  let base: string
  try {
    base = classNameFromProblem(problem.frontendId, problem.title)
  } catch {
    return null
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}\\d*$`)
  return files.find((file) => /\.java$/i.test(file.path)
    && pattern.test(file.name.replace(/\.java$/i, ''))) ?? null
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

function sameFilePath(left: string, right: string): boolean {
  return normalizeSourcePath(left) === normalizeSourcePath(right)
}

export function gitFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

/** Directory portion of a repo-relative path, or '' for a root-level file. */
export function gitDirectoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : ''
}

/**
 * Auto commit message chosen by change kind: brand-new files read `Add …`,
 * anything touching an existing file reads `Update …`.
 */
export function defaultGitCommitMessage(files: Array<Pick<GitChangedFile, 'path' | 'status'>>): string {
  const normalized = files.filter((file) => file.path.trim().length > 0)
  if (normalized.length === 0) {
    return 'Update files'
  }
  const isNew = (status: string): boolean => status === 'added' || status === 'untracked'
  const allNew = normalized.every((file) => isNew(file.status))
  if (normalized.length === 1) {
    return `${allNew ? 'Add' : 'Update'} ${gitFileName(normalized[0].path)}`
  }
  return `${allNew ? 'Add' : 'Update'} ${normalized.length} files`
}

/** Best-effort commit-result parse; older backends may return anything. */
function asGitCommitResult(value: unknown): GitCommitResult | null {
  try {
    return normalizeGitCommitResult(value)
  } catch {
    return null
  }
}

/** Best-effort push-result parse; older backends may return anything. */
function asGitPushResult(value: unknown): GitPushResult | null {
  try {
    return normalizeGitPushResult(value)
  } catch {
    return null
  }
}

/**
 * Success toast for commit / commit-and-push, e.g. `Committed a1b2c3d · 2 files`
 * or `Committed a1b2c3d · Pushed to origin/main`. Falls back gracefully when a
 * backend response could not be parsed.
 */
export function gitResultToastMessage(
  fileCount: number,
  pushed: boolean,
  commit: GitCommitResult | null,
  push: GitPushResult | null,
): string {
  const files = `${fileCount} file${fileCount === 1 ? '' : 's'}`
  const committed = commit?.commitHash
    ? `Committed ${commit.commitHash.slice(0, 7)}`
    : 'Committed'
  if (!pushed) {
    return `${committed} · ${files}`
  }
  const pushedLabel = push?.branch ? `Pushed to origin/${push.branch}` : 'Pushed'
  return `${committed} · ${pushedLabel}`
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
    originalPath: null,
  }
}

function normalizeGitFile(value: unknown): GitChangedFile | null {
  if (typeof value === 'string') {
    return { path: value, status: 'modified', staged: false, additions: null, deletions: null, originalPath: null }
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
  const originalPath = stringValueForGit(value.originalPath)
    ?? stringValueForGit(value.original_path)
  const staged = typeof value.staged === 'boolean'
    ? value.staged
    : isGitIndexStaged(index)
  return {
    path: unquoteGitPath(path),
    status: rawStatus ? normalizeGitStatusLabel(rawStatus) : statusFromGitCodes(index ?? ' ', worktree ?? ' '),
    staged,
    additions,
    deletions,
    originalPath: originalPath ? unquoteGitPath(originalPath) : null,
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
      originalPath: file.originalPath ?? previous.originalPath,
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
 * Test names are stable across the progress events and the final JUnit
 * report, so use the class/name pair as the selection identity. Keeping this
 * outside the DOM also means a live result refresh does not lose the user's
 * selected test while its output is still arriving.
 */
function testResultKey(test: TestCaseResult): string {
  // Encode both fields so the identity is safe to carry in a data attribute;
  // class/name values can otherwise contain separators or control characters.
  return `${encodeURIComponent(test.className ?? '')}:${encodeURIComponent(test.name)}`
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

  /**
   * Drop work that has not started yet. Callers should flush first when the
   * pending source must be written before an external filesystem operation.
   */
  cancelPending(): void {
    this.clearTimer()
    this.pending = null
    if (!this.running) {
      this.setStatus('idle')
    }
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

/** Returns the calendar day used by the daily-problem service (UTC). */
export function utcDateKey(value: Date | number = new Date()): string {
  const date = typeof value === 'number' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return date.toISOString().slice(0, 10)
}

/**
 * Delay until just after the next UTC midnight. The small one-second cushion
 * avoids racing the provider while its daily cache rolls over.
 */
export function nextUtcMidnightDelayMs(value: Date | number = new Date(), paddingMs = 1000): number {
  const date = typeof value === 'number' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) {
    return 24 * 60 * 60 * 1000 + Math.max(0, paddingMs)
  }
  const nextMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return Math.max(1, nextMidnight - date.getTime() + Math.max(0, paddingMs))
}

/** Accept only a real calendar date in the provider's UTC YYYY-MM-DD format. */
export function normalizeDailyProblemDateKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(2000, 0, 1))
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  return value
}

interface AppState {
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
  dailyProblemDateKey: string | null
  dailyRetryPending: boolean
  dailyError: string | null
  dailyLoading: boolean
  testResult: TestResult | null
  testRun: TestRunSnapshot | null
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

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly repositoryPicker = new RepositoryPickerCoordinator()
  private readonly storage: Storage | undefined
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
    dailyProblemDateKey: null,
    dailyRetryPending: false,
    dailyError: null,
    dailyLoading: false,
    testResult: null,
    testRun: null,
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
  private suppressEditorChange = false
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private externalReloadInFlight = false
  private stopWatchingFiles: (() => void) | null = null
  private shortcutsDialogOpen = false
  private shortcutsDialogFocusTarget: HTMLElement | null = null
  private testRunGeneration = 0
  private nextOpenTabId = 1
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
  private pendingGitDiffPath: string | null = null
  private saveWriteInFlight = false
  private savedFlash = false
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null
  private dailyDescriptionOpen = false
  private gitDiscardInProgress = false
  private gitDiscardDialogFile: GitChangedFile | null = null
  private gitDiscardDialogFocusTarget: HTMLElement | null = null
  private renderedFileTabsActiveId: number | null = null
  private renameTargetFile: ProblemFileEntry | null = null
  private errorToastElement: HTMLElement | null = null
  private sanitizedDescriptionSource: string | null = null
  private sanitizedDescriptionElement: HTMLElement | null = null
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    accordionGroupKeys('easy', true),
  )
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (isShortcutHelpAltShortcut(event)) {
      // The shortcut list has to be reachable from anywhere, including the
      // file explorer and the run panel.
      event.preventDefault()
      this.toggleShortcutsDialog()
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
    if (event.key !== 'Escape') {
      return
    }
    if (this.shortcutsDialogOpen) {
      event.preventDefault()
      this.closeShortcutsDialog()
    } else if (this.gitDiscardDialogFile) {
      event.preventDefault()
      this.closeDiscardGitDialog()
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
    this.bottomPanelHeight = readBottomPanelHeight(this.storage)
    this.gitFileListWidth = readGitFileListWidth(this.storage)
    this.sidebarWidth = readSidebarWidth(this.storage)
    this.dailyDescriptionHeight = readDailyDescriptionHeight(this.storage)
    this.dailyDescriptionOpen = this.storage?.getItem(DAILY_DESCRIPTION_KEY) === 'open'
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
      onShowShortcuts: () => {
        this.openShortcutsDialog()
      },
      onRunTestAtCursor: (methodName) => {
        if (!methodName) {
          this.setMessage('Place the cursor inside an @Test method to run only that test.', 'info')
          return true
        }
        void this.runCurrentTest(methodName)
        return true
      },
    })
    this.bindEvents()
    this.renderAll()
  }

  async start(): Promise<void> {
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
    this.clearSavedFlash()
    this.stopWatchingFiles?.()
    this.stopWatchingFiles = null
    void this.backend.stopWatchingRepository().catch(() => {})
    this.destroyed = true
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <span class="wordmark">leetcoder</span>
          <button id="choose-repository" class="repo-chip" type="button">
            <span id="repo-path" class="repo-chip-label">Choose repository</span>
          </button>
        </header>

        <main class="workspace">
          <aside class="sidebar" aria-label="Problem files">
            <div class="sidebar-heading">
              <span class="micro-label">Problems</span>
              <span id="file-count" class="sidebar-count"></span>
              <button id="refresh-files" class="icon-button" type="button" aria-label="Refresh problem files" title="Refresh"></button>
            </div>
            <div class="file-search">
              <label class="sr-only" for="file-search">Search problems</label>
              <div class="file-search-field">
                <span id="file-search-icon" aria-hidden="true"></span>
                <input id="file-search" type="search" placeholder="Search" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div id="file-list" class="file-list"></div>
          </aside>

          <div
            id="sidebar-splitter"
            class="sidebar-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize problem files pane"
            aria-valuemin="${MIN_SIDEBAR_WIDTH}"
            aria-valuemax="${MAX_SIDEBAR_WIDTH}"
            tabindex="0"
          ><span aria-hidden="true"></span></div>

          <section class="editor-column" aria-label="Code editor">
            <section class="daily-card" aria-label="Today's problem">
              <div id="daily-header" class="daily-header"></div>
              <div id="daily-description" class="daily-description" hidden></div>
              <div
                id="daily-description-resize-handle"
                class="daily-description-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize problem description"
                aria-valuemin="${MIN_DAILY_DESCRIPTION_HEIGHT}"
                aria-valuemax="${MAX_DAILY_DESCRIPTION_HEIGHT}"
                tabindex="0"
                hidden
              ><span aria-hidden="true"></span></div>
            </section>

            <section class="code-card">
              <div class="file-tabs-shell">
                <nav id="file-tabs" class="file-tabs" role="tablist" aria-label="Open files"></nav>
              </div>
              <div class="code-toolbar">
                <div class="file-heading">
                  <span id="selected-file" class="selected-file"></span>
                  <span id="save-status" class="save-status" aria-live="polite"></span>
                </div>
              </div>
              <div class="editor-host" id="editor-host" aria-label="Java source editor">
                <div id="editor" class="editor"></div>
                <div id="editor-empty" class="editor-empty"></div>
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
          <div class="bottom-panel-tabs">
            <div class="bottom-panel-tab-list" role="tablist" aria-label="Bottom panel">
              <button id="tests-tab" class="bottom-panel-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="tests-panel" tabindex="0">Tests</button>
              <button id="git-tab" class="bottom-panel-tab" type="button" role="tab" aria-selected="false" aria-controls="git-panel" tabindex="-1">Git</button>
            </div>
            <div class="bottom-panel-actions" role="group" aria-label="Test actions">
              <span class="selected-test-shortcut-hint">Selected test <kbd id="run-selected-shortcut">Alt+Shift+R</kbd></span>
              <button id="run-test" class="primary-button" type="button">Run <kbd id="run-shortcut">Alt+R</kbd></button>
            </div>
          </div>
          <section id="tests-panel" class="tests-panel" role="tabpanel" aria-labelledby="tests-tab" aria-busy="false">
            <div id="test-status-row" class="test-status-row"></div>
            <div id="test-body" class="test-body"></div>
          </section>
          <section id="git-panel" class="git-panel" role="tabpanel" aria-labelledby="git-tab" hidden>
            <div class="git-toolbar">
              <div class="git-heading">
                <span id="git-branch-icon" class="git-branch-icon" aria-hidden="true"></span>
                <span class="git-heading-label">Changes</span>
                <span id="git-file-count" class="git-count"></span>
                <span id="git-branch" class="git-branch-name"></span>
              </div>
              <div class="git-actions">
                <button id="git-select-all" class="text-button" type="button">Select all</button>
                <button id="git-select-none" class="text-button" type="button">Clear</button>
              </div>
            </div>
            <div id="git-status" class="git-status" role="status" aria-live="polite" hidden></div>
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
                  <span id="git-diff-file" class="git-diff-file">Select a file</span>
                  <span id="git-diff-state" class="git-diff-state"></span>
                </div>
                <div id="git-diff" class="git-diff" aria-label="Unified diff"></div>
              </div>
            </div>
            <div class="git-commit-bar">
              <label class="sr-only" for="git-commit-message">Commit message</label>
              <input id="git-commit-message" type="text" autocomplete="off" spellcheck="false">
              <button id="git-commit" class="secondary-button" type="button">Commit</button>
              <button id="git-commit-push" class="primary-button" type="button">Commit &amp; Push</button>
            </div>
          </section>
        </section>
        <div id="toast-stack" class="toast-stack" role="status" aria-live="polite"></div>
        <div id="file-context-menu" class="file-context-menu" role="menu" aria-label="File actions" hidden>
          <button id="duplicate-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
            <span id="duplicate-file-label">Duplicate</span>
          </button>
          <button id="rename-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
            <span id="rename-file-label">Rename</span>
          </button>
          <button id="delete-file-action" class="file-context-menu-item" type="button" role="menuitem">
            <span id="delete-file-label">Delete</span>
          </button>
        </div>
        <div id="git-context-menu" class="file-context-menu git-context-menu" role="menu" aria-label="Git file actions" hidden>
          <button id="git-discard-action" class="file-context-menu-item" type="button" role="menuitem">
            Discard Changes
          </button>
          <button id="git-show-file-action" class="file-context-menu-item file-context-menu-item-neutral" type="button" role="menuitem">
            Show in File Manager
          </button>
        </div>
        <div id="rename-file-dialog" class="dialog-backdrop" hidden>
          <form id="rename-file-form" class="rename-file-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-file-title">
            <h2 id="rename-file-title" class="rename-file-title">Rename file</h2>
            <label class="rename-file-label" for="rename-file-input">New filename</label>
            <input id="rename-file-input" class="rename-file-input" type="text" autocomplete="off" spellcheck="false">
            <div class="rename-file-actions">
              <button id="cancel-rename-file" class="text-button" type="button">Cancel</button>
              <button id="confirm-rename-file" class="primary-button" type="submit">Rename</button>
            </div>
          </form>
        </div>
        <div id="shortcuts-dialog" class="dialog-backdrop" hidden>
          <div class="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
            <h2 id="shortcuts-title" class="shortcuts-title">Keyboard shortcuts</h2>
            <div id="shortcuts-body" class="shortcuts-body"></div>
            <p class="shortcuts-note">macOS and Linux use the same physical keys. Where macOS has Cmd, Linux has Alt, so Alt is the primary modifier here; the Ctrl forms stay bound as well.</p>
            <div class="shortcuts-actions">
              <button id="close-shortcuts" class="text-button" type="button">Close</button>
            </div>
          </div>
        </div>
        <div id="discard-git-dialog" class="dialog-backdrop" hidden>
          <form id="discard-git-form" class="discard-git-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-git-title" aria-describedby="discard-git-message">
            <h2 id="discard-git-title" class="discard-git-title">Discard changes?</h2>
            <code id="discard-git-path" class="discard-git-path"></code>
            <p id="discard-git-message" class="discard-git-message"></p>
            <div class="discard-git-actions">
              <button id="cancel-discard-git" class="text-button" type="button">Cancel</button>
              <button id="confirm-discard-git" class="primary-button discard-git-confirm" type="submit">Discard Changes</button>
            </div>
          </form>
        </div>
      </div>
    `
    this.installStaticIcons()
    this.renderEditorEmptyState()
  }

  private installStaticIcons(): void {
    this.element<HTMLButtonElement>('#choose-repository').prepend(iconFor('folderOpen', 'button-icon'))
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
      void this.deleteContextMenuFile()
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
    this.element<HTMLButtonElement>('#close-shortcuts').addEventListener('click', () => {
      this.closeShortcutsDialog()
    })
    this.element<HTMLElement>('#shortcuts-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeShortcutsDialog()
      }
    })
    this.element<HTMLElement>('#discard-git-dialog').addEventListener('pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDiscardGitDialog()
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

  private async loadDailyProblem(): Promise<void> {
    if (this.state.dailyLoading) {
      return
    }
    const requestId = ++this.dailyRequestId
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
      } else if (problemDateKey !== currentDateKey) {
        // The provider still serves yesterday's problem. Not an error: the
        // card shows a waiting state and the retry timer keeps polling.
        this.state.dailyRetryPending = true
        this.state.dailyProblemDateKey = problemDateKey
        this.state.dailyError = null
      } else {
        this.state.dailyProblem = problem
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
    } finally {
      if (!this.destroyed && requestId === this.dailyRequestId) {
        this.state.dailyLoading = false
        this.scheduleDailyProblemRefresh(this.state.dailyRetryPending ? DAILY_RETRY_INTERVAL_MS : nextUtcMidnightDelayMs())
        this.renderAll()
      }
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

  private resetTestState(): void {
    this.state.testResult = null
    this.state.testRun = null
    this.state.selectedTestKey = null
    this.testRunGeneration += 1
    this.editor.setIssues([])
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
    if (!this.state.repoPath || !this.state.projectValid || !this.state.dailyProblem) {
      this.setMessage('Choose a repository first', 'error')
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

  private async runCurrentTest(testMethod?: string | null): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (testMethod === null) {
      this.setMessage('Place the cursor inside an @Test method to run only that test.', 'info')
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
    this.state.selectedTestKey = null
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
    this.state.selectedTestKey = null
    this.renderedTestResult = null
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
    if (this.destroyed || this.state.dailyLoading || !this.isWindowVisible()) {
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
    if (this.state.dailyLoading) {
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
      this.markGitStale()
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
    header.innerHTML = ''
    const problem = this.state.dailyProblem

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

    const micro = document.createElement('span')
    micro.className = 'micro-label'
    micro.textContent = 'Today'
    const number = document.createElement('span')
    number.className = 'problem-number'
    number.textContent = `#${problem.frontendId}`
    const title = document.createElement('strong')
    title.className = 'problem-title'
    title.textContent = problem.title
    title.title = problem.title
    const difficulty = document.createElement('span')
    difficulty.className = `difficulty difficulty-${problem.difficulty.toLowerCase()}`
    difficulty.textContent = problem.difficulty
    header.append(micro, number, title, difficulty)

    const actions = document.createElement('div')
    actions.className = 'daily-actions'

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'icon-button'
    refresh.setAttribute('aria-label', 'Refresh today’s problem')
    refresh.title = 'Refresh'
    refresh.append(iconFor('refresh', 'button-icon'))
    refresh.disabled = this.state.busy || this.state.dailyLoading
    refresh.classList.toggle('is-spinning', this.state.dailyLoading)
    refresh.addEventListener('click', () => {
      void this.loadDailyProblem()
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
    header.append(actions)

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
    message.textContent = 'Couldn’t load today’s problem'
    if (this.state.dailyError) {
      message.title = this.state.dailyError
    }
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'text-button'
    retry.textContent = 'Retry'
    retry.disabled = this.state.dailyLoading
    retry.addEventListener('click', () => {
      void this.loadDailyProblem()
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

  private toggleShortcutsDialog(): void {
    if (this.shortcutsDialogOpen) {
      this.closeShortcutsDialog()
    } else {
      this.openShortcutsDialog()
    }
  }

  private openShortcutsDialog(): void {
    if (this.shortcutsDialogOpen) {
      return
    }
    const active = document.activeElement
    this.shortcutsDialogFocusTarget = active instanceof HTMLElement ? active : null
    this.shortcutsDialogOpen = true
    this.renderShortcutsDialog()
    queueMicrotask(() => {
      if (this.shortcutsDialogOpen) {
        this.element<HTMLButtonElement>('#close-shortcuts').focus()
      }
    })
  }

  private closeShortcutsDialog(): void {
    if (!this.shortcutsDialogOpen) {
      return
    }
    this.shortcutsDialogOpen = false
    const target = this.shortcutsDialogFocusTarget
    this.shortcutsDialogFocusTarget = null
    this.renderShortcutsDialog()
    if (target && target.isConnected && !target.closest('[hidden]')) {
      target.focus()
    } else {
      this.editor.focus()
    }
  }

  private renderShortcutsDialog(): void {
    const dialog = this.element<HTMLElement>('#shortcuts-dialog')
    dialog.hidden = !this.shortcutsDialogOpen
    const body = this.element<HTMLElement>('#shortcuts-body')
    body.innerHTML = ''
    if (!this.shortcutsDialogOpen) {
      return
    }
    const mac = currentIsMacPlatform()
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
          key.textContent = formatShortcut(binding, mac)
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

  private async deleteContextMenuFile(): Promise<void> {
    const context = this.state.contextMenu
    const repoPath = this.state.repoPath
    if (!context || !repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const method = (this.backend as unknown as FileManagementBackend).deleteProblemFile
    if (!method) {
      this.closeFileContextMenu()
      this.setMessage('Not available in this build', 'error')
      return
    }
    if (!confirmDeleteFile(context.file.name)) {
      return
    }
    const file = context.file
    const repositoryGeneration = this.repositoryGeneration
    const operationId = ++this.fileOperationId
    this.closeFileContextMenu()
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
    const panel = this.element<HTMLElement>('#tests-panel')
    const statusRow = this.element<HTMLElement>('#test-status-row')
    const body = this.element<HTMLElement>('#test-body')
    const liveRun = this.state.testRun?.status === 'running' ? this.state.testRun : null
    const result = this.state.testResult ?? (liveRun ? liveSnapshotResult(liveRun) : null)
    statusRow.className = 'test-status-row'
    statusRow.removeAttribute('title')
    statusRow.innerHTML = ''
    body.innerHTML = ''
    panel.setAttribute('aria-busy', liveRun ? 'true' : 'false')

    if (!result) {
      statusRow.classList.add('is-idle')
      const idle = document.createElement('span')
      idle.className = 'test-idle-copy'
      const kbd = document.createElement('kbd')
      const selectedKbd = document.createElement('kbd')
      const mac = currentIsMacPlatform()
      kbd.textContent = shortcutLabel('run-test', mac)
      selectedKbd.textContent = shortcutLabel('run-test-at-cursor', mac)
      idle.append(
        document.createTextNode('Run '),
        kbd,
        document.createTextNode(' to test the current file · '),
        selectedKbd,
        document.createTextNode(' for the selected test'),
      )
      statusRow.append(idle)
      this.renderedTestResult = null
      return
    }

    const presentation = presentTestResult(result)
    const isRunning = liveRun !== null
    const phase = normalizeTestPhase(result.phase)
    const isRunnerError = this.state.testRun?.status === 'error' || phase === 'runner'
    const hasFailure = !result.success || isRunnerError
    const diagnostics = filterTestDiagnostics(result.diagnostics)
    const errorDiagnostics = diagnostics.filter((entry) => entry.severity.trim().toLowerCase() === 'error')
    const warningDiagnostics = diagnostics.filter((entry) => entry.severity.trim().toLowerCase() === 'warning')
    this.renderedTestResult = result

    if (isRunning) {
      statusRow.classList.add('is-running')
      statusRow.append(iconFor('loader', 'test-status-svg is-spinning'))
      const label = document.createElement('span')
      label.className = 'test-verdict'
      label.textContent = liveRunPhaseLabel(result.phase)
      statusRow.append(label)
      const factParts = testRunFacts(result.summary)
      if (factParts.length > 0) {
        const facts = document.createElement('span')
        facts.className = 'test-facts'
        facts.textContent = factParts.join(' · ')
        statusRow.append(facts)
      }
    } else {
      const verdict = document.createElement('span')
      verdict.className = 'test-verdict'
      const factParts: string[] = []
      if (!hasFailure) {
        statusRow.classList.add('is-success')
        statusRow.append(iconFor('check', 'test-status-svg'))
        verdict.textContent = 'Passed'
        if (result.summary.total > 0) {
          factParts.push(`${result.summary.total} test${result.summary.total === 1 ? '' : 's'}`)
        }
      } else if (phase === 'compile') {
        statusRow.classList.add('is-failure')
        statusRow.append(iconFor('close', 'test-status-svg'))
        verdict.textContent = 'Compile error'
        if (errorDiagnostics.length > 0) {
          factParts.push(`${errorDiagnostics.length} error${errorDiagnostics.length === 1 ? '' : 's'}`)
        }
      } else if (phase === 'noTests') {
        statusRow.classList.add('is-warning')
        statusRow.append(iconFor('alert', 'test-status-svg'))
        verdict.textContent = 'No tests ran'
      } else if (isRunnerError) {
        statusRow.classList.add('is-error')
        statusRow.append(iconFor('alert', 'test-status-svg'))
        verdict.textContent = 'Runner error'
      } else {
        statusRow.classList.add('is-failure')
        statusRow.append(iconFor('close', 'test-status-svg'))
        verdict.textContent = 'Failed'
        const failedCount = result.summary.failed + result.summary.errors
        if (failedCount > 0 && result.summary.total > 0) {
          factParts.push(`${failedCount} of ${result.summary.total} failed`)
        }
      }
      statusRow.append(verdict)
      if (result.summary.durationMs !== null && result.summary.durationMs !== undefined && phase !== 'compile') {
        factParts.push(formatDuration(result.summary.durationMs))
      }
      if (factParts.length > 0) {
        const facts = document.createElement('span')
        facts.className = 'test-facts'
        facts.textContent = factParts.join(' · ')
        statusRow.append(facts)
      }
      if (hasFailure && presentation.failureMessage) {
        statusRow.title = presentation.failureMessage
      }
    }
    const targetedMethod = this.state.testRun?.testMethod
    if (targetedMethod) {
      const target = document.createElement('span')
      target.className = 'test-run-target'
      target.textContent = `Only ${targetedMethod}()`
      statusRow.append(target)
    }

    // Diagnostic cards: errors inline (compile and runner failures alike —
    // the runner message carries JDK guidance), warnings behind a disclosure.
    if (!isRunning) {
      for (const diagnostic of errorDiagnostics) {
        body.append(this.renderDiagnostic(diagnostic))
      }
      if (warningDiagnostics.length > 0) {
        const details = document.createElement('details')
        details.className = 'diagnostics-warnings'
        const heading = document.createElement('summary')
        heading.textContent = `${warningDiagnostics.length} warning${warningDiagnostics.length === 1 ? '' : 's'}`
        details.append(heading)
        for (const diagnostic of warningDiagnostics) {
          details.append(this.renderDiagnostic(diagnostic))
        }
        body.append(details)
      }
    }

    // A phase without per-test rows explains itself in a full-width note.
    const hasFailedTestRows = result.tests.some((test) => test.status === 'failed' || test.status === 'error')
    if (!isRunning && hasFailure) {
      if (phase === 'noTests') {
        const note = document.createElement('div')
        note.className = 'run-note run-note-no-tests'
        const hint = document.createElement('p')
        hint.className = 'run-note-message'
        hint.textContent = 'No tests were found in this class. Add an @Test method with an assertion.'
        note.append(hint)
        body.append(note)
      } else if (
        phase !== 'compile'
        && errorDiagnostics.length === 0
        && (phase !== 'test' || !hasFailedTestRows)
        && presentation.failureMessage
      ) {
        const note = document.createElement('div')
        note.className = 'run-note run-note-runner'
        const message = document.createElement('p')
        message.className = 'run-note-message'
        message.textContent = presentation.failureMessage
        note.append(message)
        body.append(note)
      }
    }

    const visibleTests = defaultVisibleTests(result.tests, isRunning)
    const selectedTest = visibleTests.find((test) => testResultKey(test) === this.state.selectedTestKey) ?? null
    // A refreshed JUnit report can legitimately omit a test that was visible
    // during live progress. Fall back to the run item rather than leaving an
    // option marked selected with an empty detail pane.
    if (this.state.selectedTestKey !== null && selectedTest === null) {
      this.state.selectedTestKey = null
    }

    const workspace = document.createElement('div')
    workspace.className = 'test-results-workspace'

    const list = document.createElement('div')
    list.className = 'test-list test-results-tree'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Tests')
    list.setAttribute('aria-controls', 'test-detail-pane')
    list.append(this.renderTestTreeItem(null, result, isRunning))
    for (const test of visibleTests) {
      list.append(this.renderTestTreeItem(test, result, isRunning))
    }
    if (isRunning && result.tests.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'test-empty test-empty-running'
      empty.textContent = liveRunPhaseLabel(result.phase)
      list.append(empty)
    } else if (!isRunning && result.tests.length === 0 && phase !== 'compile' && phase !== 'noTests' && !isRunnerError) {
      const empty = document.createElement('div')
      empty.className = 'test-empty'
      empty.textContent = 'No tests were reported.'
      list.append(empty)
    }

    const detailPane = document.createElement('section')
    detailPane.id = 'test-detail-pane'
    detailPane.className = 'test-detail-pane'
    detailPane.setAttribute('role', 'region')
    detailPane.setAttribute('aria-live', 'polite')
    if (selectedTest) {
      detailPane.setAttribute('aria-label', `Details for ${selectedTest.displayName || selectedTest.name}`)
      const heading = document.createElement('div')
      heading.className = 'test-detail-heading'
      const title = document.createElement('h3')
      title.className = 'test-detail-title'
      title.textContent = selectedTest.displayName || selectedTest.name
      heading.append(this.statusIcon(selectedTest.status), title)
      if (selectedTest.durationMs !== null && selectedTest.durationMs !== undefined) {
        const duration = document.createElement('span')
        duration.className = 'test-duration'
        duration.textContent = formatDuration(selectedTest.durationMs)
        heading.append(duration)
      }
      detailPane.append(heading)
      if (selectedTest.className) {
        const className = document.createElement('p')
        className.className = 'test-detail-class'
        className.textContent = selectedTest.className
        detailPane.append(className)
      }
      detailPane.append(this.renderTestCase(selectedTest))
    } else {
      detailPane.setAttribute('aria-label', 'Test run output')
      const heading = document.createElement('div')
      heading.className = 'test-detail-heading'
      const rootStatus = isRunning ? 'running' : result.success ? 'passed' : phase === 'noTests' ? 'skipped' : 'failed'
      heading.append(this.statusIcon(rootStatus))
      const title = document.createElement('h3')
      title.className = 'test-detail-title'
      title.textContent = isRunning ? 'Test run' : 'Test run output'
      heading.append(title)
      detailPane.append(heading)
      const summary = document.createElement('p')
      summary.className = 'test-detail-class'
      summary.textContent = testRunFacts(result.summary).join(' · ') || liveRunPhaseLabel(result.phase)
      detailPane.append(summary)
      const output = this.renderOutputConsole(result.stdout, result.stderr)
      if (output) {
        detailPane.append(output)
      }
    }
    workspace.append(list, detailPane)
    body.append(workspace)
  }

  /** Render one selectable row in the left-hand IntelliJ-style test tree. */
  private renderTestTreeItem(
    test: TestCaseResult | null,
    result: TestResult,
    isRunning: boolean,
  ): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = test
      ? `test-tree-item test-row-${test.status}`
      : 'test-tree-item test-tree-root'
    item.setAttribute('role', 'option')
    const key = test ? testResultKey(test) : TEST_RUN_ROOT_KEY
    const selected = test
      ? this.state.selectedTestKey === key
      : this.state.selectedTestKey === null
    item.dataset.testKey = key
    item.setAttribute('aria-selected', String(selected))
    // Roving tab stop keeps keyboard navigation inside the test list while
    // allowing arrow keys to move through every result.
    item.tabIndex = selected ? 0 : -1
    const status = test
      ? test.status
      : isRunning
        ? 'running'
        : result.success
          ? 'passed'
          : normalizeTestPhase(result.phase) === 'noTests'
            ? 'skipped'
            : 'failed'
    item.append(this.statusIcon(status))
    const name = document.createElement('span')
    name.className = 'test-name'
    name.textContent = test ? (test.displayName || test.name) : 'Test run'
    item.append(name)
    const facts = document.createElement('span')
    facts.className = 'test-tree-facts'
    if (test) {
      if (test.durationMs !== null && test.durationMs !== undefined) {
        facts.textContent = formatDuration(test.durationMs)
      }
      item.setAttribute('aria-label', `${test.displayName || test.name}, ${testStatusLabel(test.status)}${facts.textContent ? `, ${facts.textContent}` : ''}`)
      if (test.className) {
        item.title = test.className
      }
    } else {
      facts.textContent = testRunFacts(result.summary).join(' · ')
      item.setAttribute('aria-label', `Test run, ${testStatusLabel(status)}${facts.textContent ? `, ${facts.textContent}` : ''}`)
    }
    item.append(facts)
    item.addEventListener('click', () => {
      this.selectTestResult(key, true)
    })
    item.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return
      }
      const options = Array.from(item.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
      const currentIndex = options.indexOf(item)
      if (currentIndex < 0 || options.length === 0) {
        return
      }
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : Math.max(0, Math.min(
            options.length - 1,
            currentIndex + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1),
          ))
      event.preventDefault()
      const nextKey = options[nextIndex].dataset.testKey ?? TEST_RUN_ROOT_KEY
      this.selectTestResult(nextKey, true)
    })
    return item
  }

  private selectTestResult(key: string, focus = false): void {
    const nextKey = key === TEST_RUN_ROOT_KEY ? null : key
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

  /** Render assertion metadata, stack details, and the selected test console. */
  private renderTestCase(test: TestCaseResult): HTMLElement {
    const failed = test.status === 'failed' || test.status === 'error'
    const detail = document.createElement('div')
    detail.className = `test-detail-content test-row-${test.status}`
    const failureSummary = conciseTestFailureMessage(test)
    if (failureSummary) {
      const message = document.createElement('p')
      message.className = 'failure-message'
      message.textContent = failureSummary
      detail.append(message)
    }
    const hasExpected = test.expected !== null && test.expected !== undefined
    const hasActual = test.actual !== null && test.actual !== undefined
    const diff = hasExpected && hasActual ? charDiffSegments(test.expected!, test.actual!) : null
    if (hasExpected) {
      detail.append(renderComparisonValue(
        'Expected',
        test.expected!,
        'expected-value',
        diff ? { prefix: diff.prefix, mid: diff.expectedMid, suffix: diff.suffix } : null,
      ))
    }
    if (hasActual) {
      detail.append(renderComparisonValue(
        'Actual',
        test.actual!,
        'actual-value',
        diff ? { prefix: diff.prefix, mid: diff.actualMid, suffix: diff.suffix } : null,
      ))
    }
    if (test.file && validSourceLine(test.line) !== null) {
      detail.append(this.renderLocation(test.file, validSourceLine(test.line)!, test.column))
    }
    if (test.details) {
      const stack = document.createElement('details')
      stack.className = 'test-full-stack'
      stack.open = failed
      const stackSummary = document.createElement('summary')
      stackSummary.textContent = 'Stack trace'
      stack.append(stackSummary)
      const relevantFrames = relevantTestStackFrames(test.details)
      if (relevantFrames.length > 0) {
        const userFrames = document.createElement('pre')
        userFrames.className = 'test-user-frames'
        userFrames.textContent = relevantFrames.join('\n')
        stack.append(userFrames)
      }
      const stacktrace = document.createElement('pre')
      stacktrace.className = 'test-stacktrace'
      stacktrace.textContent = test.details
      stack.append(stacktrace)
      detail.append(stack)
    }
    const output = this.renderOutputConsole(test.stdout, test.stderr)
    if (output) {
      detail.append(output)
    }
    return detail
  }

  private renderOutputConsole(
    stdout: string | null | undefined,
    stderr: string | null | undefined,
  ): HTMLElement | null {
    const segments = testOutputSegments(stdout, stderr)
    if (segments.length === 0) {
      return null
    }

    const output = document.createElement('section')
    output.className = 'test-console'
    output.setAttribute('aria-label', 'Console output')
    const content = document.createElement('pre')
    content.className = 'test-output-content'
    for (const segment of segments) {
      const stream = document.createElement('span')
      stream.className = `test-output-stream test-output-${segment.stream}`
      stream.textContent = segment.text
      content.append(stream)
    }
    output.append(content)
    return output
  }

  private renderDiagnostic(diagnostic: TestDiagnostic): HTMLElement {
    const card = document.createElement('div')
    card.className = `diagnostic diagnostic-${diagnostic.severity}`
    const header = document.createElement('div')
    header.className = 'diagnostic-header'
    header.append(iconFor(diagnostic.severity === 'warning' ? 'alert' : 'close', 'diagnostic-icon'))
    const message = document.createElement('span')
    message.className = 'diagnostic-message'
    message.textContent = diagnostic.message
    header.append(message)
    card.append(header)
    if (diagnostic.sourceLine) {
      const snippet = document.createElement('pre')
      snippet.className = 'diagnostic-snippet'
      snippet.textContent = diagnostic.caret
        ? `${diagnostic.sourceLine}\n${diagnostic.caret}`
        : diagnostic.sourceLine
      card.append(snippet)
    }
    if (diagnostic.file && validSourceLine(diagnostic.line) !== null) {
      card.append(this.renderLocation(diagnostic.file, validSourceLine(diagnostic.line)!, diagnostic.column))
    }
    return card
  }

  private renderLocation(file: string, line: number, column?: number | null): HTMLElement {
    const location = document.createElement('button')
    location.type = 'button'
    location.className = 'result-location'
    const matchesCurrentFile = Boolean(this.state.selectedPath && sourcePathsMatch(this.state.selectedPath, file))
    location.append(
      iconFor('locate', 'result-location-icon'),
      document.createTextNode(`${sourceBasename(file)}:${line}${column ? `:${column}` : ''}`),
    )
    if (matchesCurrentFile) {
      location.title = 'Reveal this line in the editor'
      location.addEventListener('click', () => {
        this.editor.revealLine(line, column)
      })
    } else {
      location.disabled = true
      location.title = `${file} — this location belongs to another source file`
    }
    return location
  }

  private statusIcon(status: string): HTMLElement {
    const icon = document.createElement('span')
    icon.className = `test-status-icon test-status-${status}`
    icon.setAttribute('aria-label', status)
    switch (status) {
      case 'passed':
        icon.append(iconFor('check', 'test-status-svg'))
        break
      case 'failed':
        icon.append(iconFor('close', 'test-status-svg'))
        break
      case 'error':
        icon.append(iconFor('alert', 'test-status-svg'))
        break
      case 'running':
        icon.append(iconFor('loader', 'test-status-svg is-spinning'))
        break
      case 'skipped':
        icon.textContent = '–'
        break
      default:
        icon.textContent = '·'
    }
    return icon
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
  dot.className = `group-dot group-dot-${groupKey}`
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

/** Detect Apple platforms from explicit navigator values without reading globals. */
export function isMacPlatform(platform: string, userAgent = ''): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`)
}

function currentIsMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return isMacPlatform(navigator.platform, navigator.userAgent)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }
  return `${(durationMs / 1000).toFixed(2)}s`
}

/** Live status-row copy: early phases read as compiling, later as running. */
function liveRunPhaseLabel(phase: TestPhase): string {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (
    normalized === 'starting'
    || normalized === 'compiling'
    || normalized === 'compile'
    || normalized === 'compilation'
  ) {
    return 'Compiling…'
  }
  return 'Running tests…'
}

/** Non-zero result counts for the finished status row, actionable first. */
function testRunFacts(summary: TestResult['summary']): string[] {
  const parts: string[] = []
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`)
  }
  if (summary.errors > 0) {
    parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`)
  }
  if (summary.passed > 0) {
    parts.push(`${summary.passed} passed`)
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} skipped`)
  }
  return parts
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
}

/**
 * Expected/Actual row. When a char-level diff is available the differing
 * middle is wrapped in a <mark> so the mismatch reads at a glance.
 */
function renderComparisonValue(
  label: string,
  value: string,
  className: string,
  diff: { prefix: string; mid: string; suffix: string } | null,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `failure-value ${className}`
  const title = document.createElement('span')
  title.className = 'failure-value-label'
  title.textContent = label
  const content = document.createElement('code')
  content.className = 'failure-value-content'
  if (diff) {
    content.append(document.createTextNode(diff.prefix))
    const mark = document.createElement('mark')
    mark.className = 'diff-mark'
    mark.textContent = diff.mid
    content.append(mark, document.createTextNode(diff.suffix))
  } else {
    content.textContent = value
  }
  wrapper.append(title, content)
  return wrapper
}

export type UnifiedDiffLineKind = 'context' | 'addition' | 'deletion' | 'hunk' | 'no-newline'

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind
  oldLine: number | null
  newLine: number | null
  marker: '' | '+' | '-'
  content: string
}

/**
 * Converts a raw Git unified diff into only the lines useful in the file
 * viewer. Git's file headers and index/mode metadata are already represented
 * by the file heading and status badge, so showing them again makes the code
 * harder to scan. The returned line numbers are the source line numbers from
 * each side of every hunk.
 */
export function parseUnifiedDiffLines(diff: string): UnifiedDiffLine[] {
  const lines: UnifiedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let hasHunk = false

  const rawLines = diff.split(/\r\n|\n|\r/)
  for (const [lineIndex, line] of rawLines.entries()) {
    // A final line ending is not an additional blank source line. Actual
    // blank context lines retain their required unified-diff space prefix.
    if (lineIndex === rawLines.length - 1 && line.length === 0) {
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      hasHunk = true
      lines.push({
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        marker: '',
        content: line,
      })
      continue
    }

    // Everything before the first hunk is a file header or a diff metadata
    // line. A metadata line after a hunk can occur for binary/rename diffs;
    // it is intentionally omitted as well.
    if (isUnifiedDiffMetadataLine(line, hasHunk) || !hasHunk) {
      continue
    }

    if (line === '\\ No newline at end of file') {
      lines.push({
        kind: 'no-newline',
        oldLine: null,
        newLine: null,
        marker: '',
        content: line,
      })
      continue
    }

    if (line.startsWith('+')) {
      lines.push({
        kind: 'addition',
        oldLine: null,
        newLine: newLine++,
        marker: '+',
        content: line.slice(1),
      })
      continue
    }

    if (line.startsWith('-')) {
      lines.push({
        kind: 'deletion',
        oldLine: oldLine++,
        newLine: null,
        marker: '-',
        content: line.slice(1),
      })
      continue
    }

    // A normal unified-diff context line starts with one space. Keeping the
    // fallback makes the renderer tolerant of backend payloads that omit the
    // prefix while still preserving an actually blank context line (" ").
    const content = line.startsWith(' ') ? line.slice(1) : line
    lines.push({
      kind: 'context',
      oldLine: oldLine++,
      newLine: newLine++,
      marker: '',
      content,
    })
  }

  return lines
}

function isUnifiedDiffMetadataLine(line: string, hasHunk = false): boolean {
  return line.startsWith('diff --git ')
    || /^(?:new|deleted|old) file mode\s/.test(line)
    || /^(?:old|new) mode\s/.test(line)
    || /^(?:similarity|dissimilarity) index\s/.test(line)
    || /^(?:rename|copy) (?:from|to)\s/.test(line)
    || line.startsWith('index ')
    || (!hasHunk && /^(?:---|\+\+\+)(?:\s|$)/.test(line))
    || line === 'GIT binary patch'
    || /^(?:literal|delta) \d+$/.test(line)
    || line.startsWith('Binary files ')
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

export function deleteFileConfirmationMessage(fileName: string): string {
  return `Delete ${fileName}?\n\nThis cannot be undone.`
}

/**
 * Produces the next collision-free duplicate name used by the file explorer.
 * Numeric suffixes are appended immediately before the extension, matching
 * the repository's `Q123Problem2.java`, `Q123Problem3.java` convention.
 */
export function duplicateFileName(fileName: string, existingNames: Iterable<string> = []): string {
  const extensionMatch = fileName.match(/(\.[^.]+)$/)
  const extension = extensionMatch?.[1] ?? ''
  const stem = extension ? fileName.slice(0, -extension.length) : fileName
  const occupied = new Set([...existingNames].map((name) => name.toLocaleLowerCase()))
  let suffix = 2
  let candidate = `${stem}${suffix}${extension}`
  while (occupied.has(candidate.toLocaleLowerCase())) {
    suffix += 1
    candidate = `${stem}${suffix}${extension}`
  }
  return candidate
}

/** Return a safe Java basename, adding `.java` when the user omits it. */
export function normalizeJavaFileName(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) {
    return null
  }
  const withExtension = /\.java$/i.test(trimmed) ? trimmed : `${trimmed}.java`
  if (!/^[^<>:"|?*\u0000-\u001f]+\.java$/i.test(withExtension)) {
    return null
  }
  return withExtension
}

function joinFilePath(directory: string, name: string): string {
  return directory ? `${directory.replace(/[\\/]$/, '')}/${name}` : name
}

/**
 * Backends can return a path, a file DTO, or a wrapper around either. Keep the
 * UI tolerant while the native bridge rolls out the file-operation commands.
 */
function fileMutationResultPath(value: unknown, originalPath: string): string | null {
  const candidate = fileMutationResultString(value, ['path', 'newPath', 'new_path', 'filePath', 'file_path', 'relativePath', 'relative_path'])
    ?? fileMutationResultString(value, ['name', 'fileName', 'file_name', 'newName', 'new_name'])
  if (!candidate) {
    return null
  }
  if (/[\\/]/.test(candidate)) {
    return candidate.replace(/\\/g, '/').replace(/^\.\//, '')
  }
  return joinFilePath(gitDirectoryPath(originalPath), candidate)
}

function fileMutationResultContent(value: unknown): string | null {
  if (!isRecordValue(value)) {
    return null
  }
  for (const key of ['content', 'source']) {
    if (typeof value[key] === 'string') {
      return value[key]
    }
  }
  for (const key of ['file', 'entry', 'result', 'renamed']) {
    const content = fileMutationResultContent(value[key])
    if (content !== null) {
      return content
    }
  }
  return null
}

function fileMutationResultString(value: unknown, keys: string[]): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    // A duplicate response may be the source text. Only treat strings that
    // look like paths or Java basenames as operation results.
    return /\.java$/i.test(value.trim()) || /[\\/]/.test(value.trim()) ? value.trim() : null
  }
  if (!isRecordValue(value)) {
    return null
  }
  for (const key of keys) {
    const result = fileMutationResultString(value[key], keys)
    if (result) {
      return result
    }
  }
  for (const nestedKey of ['file', 'entry', 'result', 'created', 'renamed', 'duplicate']) {
    const result = fileMutationResultString(value[nestedKey], keys)
    if (result) {
      return result
    }
  }
  return null
}

export function findFileAfterDuplicate(
  files: ProblemFileEntry[],
  existingPaths: Set<string>,
  original: ProblemFileEntry,
  result: unknown,
): ProblemFileEntry | null {
  const resultPath = fileMutationResultPath(result, original.path)
  const exact = resultPath
    ? files.find((file) => normalizeSourcePath(file.path) === normalizeSourcePath(resultPath))
    : null
  if (exact && exact.path !== original.path) {
    return exact
  }
  const siblingNames = files
    .filter((file) => gitDirectoryPath(file.path) === gitDirectoryPath(original.path))
    .map((file) => file.name)
  const fallbackName = duplicateFileName(original.name, siblingNames)
  const fallbackPath = joinFilePath(gitDirectoryPath(original.path), fallbackName)
  return files.find((file) => !existingPaths.has(file.path) && file.path === fallbackPath)
    ?? files.find((file) => !existingPaths.has(file.path)
      && gitDirectoryPath(file.path) === gitDirectoryPath(original.path)
      && file.name !== original.name
      && file.name.toLocaleLowerCase().startsWith(original.name.replace(/\.java$/i, '').toLocaleLowerCase()))
    ?? null
}

export function findRestoredFileAfterGitRename(
  files: ProblemFileEntry[],
  change: Pick<GitChangedFile, 'path' | 'originalPath'>,
): ProblemFileEntry | null {
  const originalPath = change.originalPath?.trim()
  if (!originalPath || sameFilePath(originalPath, change.path)) {
    return null
  }
  return files.find((file) => sameFilePath(file.path, originalPath)) ?? null
}

function findFileAfterRename(
  files: ProblemFileEntry[],
  original: ProblemFileEntry,
  newName: string,
  result: unknown,
): ProblemFileEntry | null {
  const resultPath = fileMutationResultPath(result, original.path)
  const requestedPath = joinFilePath(gitDirectoryPath(original.path), newName)
  return files.find((file) => resultPath && normalizeSourcePath(file.path) === normalizeSourcePath(resultPath))
    ?? files.find((file) => normalizeSourcePath(file.path) === normalizeSourcePath(requestedPath))
    ?? files.find((file) => file.path !== original.path
      && gitDirectoryPath(file.path) === gitDirectoryPath(original.path)
      && file.name.toLocaleLowerCase() === newName.toLocaleLowerCase())
    ?? null
}

function confirmDeleteFile(fileName: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false
  }
  return window.confirm(deleteFileConfirmationMessage(fileName))
}

export function discardGitChangesConfirmationMessage(filePath: string): string {
  return `Discard changes to ${filePath}?\n\n${discardGitChangesWarningMessage()}`
}

export function discardGitChangesWarningMessage(): string {
  return 'This permanently discards all staged and unstaged changes. Untracked/new files will be deleted. This cannot be undone.'
}

function isGitNewFile(status: string): boolean {
  const normalized = normalizeGitStatusLabel(status)
  return normalized === 'added' || normalized === 'untracked'
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

export function clampBottomPanelHeight(value: number, viewportHeight = windowHeight()): number {
  const usableViewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800
  const maximum = Math.max(MIN_BOTTOM_PANEL_HEIGHT, Math.min(MAX_BOTTOM_PANEL_HEIGHT, Math.round(usableViewport * .8)))
  const candidate = Number.isNaN(value) ? DEFAULT_BOTTOM_PANEL_HEIGHT : value
  return Math.round(Math.min(maximum, Math.max(MIN_BOTTOM_PANEL_HEIGHT, candidate)))
}

export function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1000,
  viewportHeight = windowHeight(),
  margin = VIEWPORT_MARGIN,
): { x: number; y: number } {
  const safeX = Number.isFinite(x) ? x : margin
  const safeY = Number.isFinite(y) ? y : margin
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1000
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800
  return {
    x: Math.max(margin, Math.min(safeX, safeViewportWidth - safeWidth - margin)),
    y: Math.max(margin, Math.min(safeY, safeViewportHeight - safeHeight - margin)),
  }
}

export function clampGitFileListWidth(value: number, availableWidth = 900): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  const maximum = maxGitFileListWidth(usableWidth)
  const candidate = Number.isNaN(value) ? DEFAULT_GIT_FILE_LIST_WIDTH : value
  return Math.round(Math.min(maximum, Math.max(MIN_GIT_FILE_LIST_WIDTH, candidate)))
}

/** Keep the resizable problem-file pane usable alongside the editor. */
export function clampSidebarWidth(value: number, availableWidth = 1000): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 1000
  const maximum = maxSidebarWidth(usableWidth)
  const candidate = Number.isNaN(value) ? DEFAULT_SIDEBAR_WIDTH : value
  return Math.round(Math.min(maximum, Math.max(MIN_SIDEBAR_WIDTH, candidate)))
}

/** Keep a visible editor area while resizing the open problem description. */
export function clampDailyDescriptionHeight(value: number, availableHeight = 800): number {
  const usableHeight = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 800
  const maximum = maxDailyDescriptionHeight(usableHeight)
  const candidate = Number.isNaN(value) ? DEFAULT_DAILY_DESCRIPTION_HEIGHT : value
  return Math.round(Math.min(maximum, Math.max(MIN_DAILY_DESCRIPTION_HEIGHT, candidate)))
}

function maxGitFileListWidth(availableWidth: number): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  return Math.max(MIN_GIT_FILE_LIST_WIDTH, Math.round(usableWidth - MIN_GIT_DIFF_WIDTH - GIT_SPLITTER_WIDTH - GIT_WORKSPACE_GAP))
}

function maxSidebarWidth(availableWidth: number): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 1000
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(usableWidth - MIN_EDITOR_WIDTH - SIDEBAR_SPLITTER_WIDTH)),
  )
}

function maxDailyDescriptionHeight(availableHeight: number): number {
  const usableHeight = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 800
  return Math.max(
    MIN_DAILY_DESCRIPTION_HEIGHT,
    Math.min(
      MAX_DAILY_DESCRIPTION_HEIGHT,
      Math.round(usableHeight - MIN_CODE_CARD_HEIGHT - DAILY_DESCRIPTION_LAYOUT_OVERHEAD),
    ),
  )
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

function readSidebarWidth(storage: Storage | undefined): number {
  const value = storage?.getItem(SIDEBAR_WIDTH_KEY)
  const parsed = value ? Number(value) : DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH)
}

function readDailyDescriptionHeight(storage: Storage | undefined): number {
  const value = storage?.getItem(DAILY_DESCRIPTION_HEIGHT_KEY)
  const parsed = value ? Number(value) : DEFAULT_DAILY_DESCRIPTION_HEIGHT
  return clampDailyDescriptionHeight(
    Number.isFinite(parsed) ? parsed : DEFAULT_DAILY_DESCRIPTION_HEIGHT,
  )
}

function windowHeight(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight) || window.innerHeight <= 0) {
    return 800
  }
  return window.innerHeight
}

export { fqcnFromJavaPath }

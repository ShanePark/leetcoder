import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import type { ProblemFilePlan } from './domain'

/** The metadata returned by the daily-problem command. */
export interface DailyProblem {
  date: string
  frontendId: string
  title: string
  titleSlug: string
  difficulty: string
  url: string
  javaSnippet?: string | null
}

/** A Java source file returned by the repository file-list command. */
export interface ProblemFileEntry {
  path: string
  name: string
  packageSegment: 'easy' | 'medium' | 'xhard' | 'other'
}

export interface ProjectValidation {
  valid: boolean
  message?: string
}

export type TestPhase = 'compile' | 'test' | 'unknown' | string

export type TestCaseStatus = 'passed' | 'failed' | 'skipped' | 'unknown' | string

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
  displayName?: string
  status: TestCaseStatus
  durationMs?: number | null
  message?: string | null
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
}

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

export interface BackendClient {
  validateProject(repoPath: string): Promise<ProjectValidation>
  fetchDailyProblem(): Promise<DailyProblem>
  listProblemFiles(repoPath: string): Promise<ProblemFileEntry[]>
  readProblemFile(repoPath: string, path: string): Promise<string>
  createProblemFile(repoPath: string, plan: ProblemFilePlan): Promise<void>
  saveProblemFile(repoPath: string, path: string, content: string): Promise<void>
  runProblemTest(repoPath: string, fullyQualifiedClassName: string): Promise<TestResult>
}

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/**
 * Keep the Tauri bridge in one place.  The optional invoker makes this module
 * usable in unit tests without booting a desktop webview.
 */
export function createBackendClient(invoke: Invoke = tauriInvoke): BackendClient {
  return {
    async validateProject(repoPath) {
      const response = await invoke<unknown>('validate_project', { repoPath })
      return normalizeValidation(response)
    },

    async fetchDailyProblem() {
      const response = await invoke<unknown>('fetch_daily_problem')
      return normalizeDailyProblem(response)
    },

    async listProblemFiles(repoPath) {
      const response = await invoke<unknown>('list_problem_files', { repoPath })
      return normalizeProblemFiles(response)
    },

    async readProblemFile(repoPath, path) {
      const response = await invoke<unknown>('read_problem_file', { repoPath, path })
      if (typeof response === 'string') {
        return response
      }
      if (isRecord(response)) {
        const content = response.content ?? response.source
        if (typeof content === 'string') {
          return content
        }
      }
      throw new Error('The selected file did not contain readable source text.')
    },

    async createProblemFile(repoPath, plan) {
      const response = await invoke<unknown>('create_problem_file', {
        repoPath,
        path: plan.path,
        source: plan.source,
      })
      if (isRecord(response) && response.created === false) {
        throw new BackendError(
          stringValue(response.message) ?? 'The problem file was not created.',
          response.conflict === true,
        )
      }
    },

    async saveProblemFile(repoPath, path, content) {
      await invoke<unknown>('save_problem_file', { repoPath, path, content })
    },

    async runProblemTest(repoPath, fullyQualifiedClassName) {
      const response = await invoke<unknown>('run_problem_test', {
        repoPath,
        fullyQualifiedClassName,
      })
      return normalizeTestResult(response)
    },
  }
}

/** An error raised for a create race that can safely be retried. */
export class BackendError extends Error {
  readonly conflict: boolean

  constructor(message: string, conflict = false) {
    super(message)
    this.name = 'BackendError'
    this.conflict = conflict
  }
}

export function isConflictError(error: unknown): boolean {
  if (error instanceof BackendError) {
    return error.conflict
  }

  const message = errorMessage(error).toLowerCase()
  return /(already exists|file exists|path exists|collision|duplicate|conflict)/.test(message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  if (isRecord(error)) {
    for (const key of ['message', 'error', 'reason']) {
      const value = error[key]
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
    }
  }
  return 'An unexpected leetcoder error occurred.'
}

function normalizeValidation(value: unknown): ProjectValidation {
  if (typeof value === 'boolean') {
    return { valid: value }
  }
  if (isRecord(value)) {
    const valid = value.valid ?? value.isValid ?? value.ok
    if (typeof valid === 'boolean') {
      return {
        valid,
        message: stringValue(value.message) ?? stringValue(value.reason),
      }
    }
  }
  throw new Error('The project validation response was invalid.')
}

function normalizeDailyProblem(value: unknown): DailyProblem {
  if (!isRecord(value)) {
    throw new Error('The daily problem response was invalid.')
  }

  const frontendId = value.frontendId ?? value.frontend_id ?? value.number ?? value.id
  const title = stringValue(value.title)
  const difficulty = stringValue(value.difficulty)
  const url = stringValue(value.url)
  if (frontendId === undefined || !title || !difficulty || !url) {
    throw new Error('The daily problem response was missing required fields.')
  }

  return {
    date: stringValue(value.date) ?? '',
    frontendId: String(frontendId),
    title,
    titleSlug: stringValue(value.titleSlug) ?? stringValue(value.title_slug) ?? '',
    difficulty,
    url,
    javaSnippet: stringValue(value.javaSnippet) ?? stringValue(value.java_snippet),
  }
}

function normalizeProblemFiles(value: unknown): ProblemFileEntry[] {
  const rawFiles = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.files ?? value.paths ?? value.entries
      : undefined

  if (!Array.isArray(rawFiles)) {
    throw new Error('The repository file-list response was invalid.')
  }

  return rawFiles
    .map((file) => {
      if (typeof file === 'string') {
        return createFileEntry(file)
      }
      if (!isRecord(file)) {
        return null
      }
      const path = stringValue(file.path) ?? stringValue(file.relativePath) ?? stringValue(file.relative_path)
      return path ? createFileEntry(path) : null
    })
    .filter((file): file is ProblemFileEntry => file !== null)
    // Keep Kotlin entries in the result: the domain uses both Java and Kotlin
    // source names when choosing a collision-free suffix. The sidebar filters
    // this list to Java files at render time.
    .filter((file) => /\.(?:java|kt)$/i.test(file.path))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function createFileEntry(path: string): ProblemFileEntry {
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  const packageMatch = /(?:^|\/)(easy|medium|xhard)(?:\/|$)/i.exec(normalized)
  const packageSegment = packageMatch
    ? (packageMatch[1].toLowerCase() as ProblemFileEntry['packageSegment'])
    : 'other'
  return { path, name, packageSegment }
}

export function normalizeTestResult(value: unknown): TestResult {
  if (typeof value === 'string') {
    return createTestResult({ success: true, stdout: value, stderr: '' })
  }
  if (!isRecord(value)) {
    throw new Error('The test result response was invalid.')
  }

  const stdout = stringValue(value.stdout) ?? stringValue(value.output) ?? ''
  const stderr = stringValue(value.stderr) ?? stringValue(value.error) ?? ''
  const exitCodeValue = numberValue(value.exitCode ?? value.exit_code)
  const exitCode = exitCodeValue ?? null
  const nestedStructured = firstRecord(value.structuredResults, value.structured_results, value.results)
  // New Rust builds return ProblemTestResult with these fields directly on the
  // response. Older builds wrapped them in structuredResults, while the first
  // MVP only returned stdout/stderr. Keep all three shapes readable.
  const structured = nestedStructured ?? (hasStructuredFields(value) ? value : undefined)
  const success = typeof value.success === 'boolean'
    ? value.success
    : typeof value.ok === 'boolean'
      ? value.ok
      : structured
        ? inferSuccess(structured)
        : stderr.length === 0 && (exitCodeValue === undefined || exitCodeValue === 0)
  return createTestResult({ success, stdout, stderr, exitCode, structured })
}

interface RawTestResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode?: number | null
  structured?: Record<string, unknown>
}

function createTestResult(raw: RawTestResult): TestResult {
  const structured = raw.structured
  const tests = normalizeTests(structured?.tests ?? structured?.testResults ?? structured?.test_results)
  const summary = normalizeSummary(structured?.summary, tests)
  const diagnostics = normalizeDiagnostics(
    structured?.diagnostics ?? structured?.errors ?? structured?.compilationDiagnostics,
  )
  return {
    success: raw.success,
    phase: normalizePhase(structured?.phase ?? (diagnostics.length > 0 && tests.length === 0 ? 'compile' : 'test')),
    summary,
    tests,
    diagnostics,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode ?? null,
  }
}

function normalizePhase(value: unknown): TestPhase {
  const phase = stringValue(value)?.trim().toLowerCase()
  const compact = phase?.replace(/[\s_-]/g, '')
  if (compact === 'compile' || compact === 'compilation') {
    return 'compile'
  }
  if (compact === 'runner' || compact === 'run' || compact === 'execution') {
    return 'runner'
  }
  if (compact === 'notest' || compact === 'notests') {
    return 'noTests'
  }
  if (compact === 'test' || compact === 'tests') {
    return 'test'
  }
  return phase || 'unknown'
}

function normalizeSummary(value: unknown, tests: TestCaseResult[]): TestSummary {
  const summary = isRecord(value) ? value : {}
  const counts = deriveCounts(tests)
  const errors = countValue(summary.errors) ?? 0
  const failed = numberValue(summary.failed ?? summary.failing ?? summary.failures) ?? counts.failed
  return {
    total: numberValue(summary.total ?? summary.count ?? summary.testCount) ?? counts.total,
    passed: numberValue(summary.passed ?? summary.passing ?? summary.successful) ?? counts.passed,
    // Runtime errors are failures from the user's perspective. Preserve the
    // separate count while ensuring the existing UI cannot render "0 failed"
    // for an errored run.
    failed: Math.max(failed, errors),
    skipped: numberValue(summary.skipped ?? summary.ignored) ?? counts.skipped,
    errors,
    durationMs: numberValue(
      summary.durationMs ?? summary.duration_ms ?? summary.duration,
    ) ?? null,
  }
}

function normalizeTests(value: unknown): TestCaseResult[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry, index) => normalizeTestCase(entry, index))
}

function normalizeTestCase(value: unknown, index: number): TestCaseResult {
  if (typeof value === 'string') {
    return { name: value, status: 'unknown' }
  }
  const entry = isRecord(value) ? value : {}
  const failure = firstRecord(entry.failure, entry.error)
  const status = normalizeStatus(entry.status ?? entry.outcome ?? entry.result)
  const line = numberValue(
    entry.line
      ?? entry.lineNumber
      ?? entry.line_number
      ?? entry.sourceLine
      ?? entry.source_line
      ?? failure?.line,
  )
  return {
    name: stringValue(entry.name) ?? stringValue(entry.id) ?? `Test ${index + 1}`,
    displayName: stringValue(entry.displayName) ?? stringValue(entry.display_name) ?? stringValue(entry.name),
    status,
    durationMs: numberValue(entry.durationMs ?? entry.duration_ms ?? entry.duration),
    message: stringValue(entry.message) ?? stringValue(entry.errorMessage) ?? stringValue(failure?.message),
    expected: stringValue(entry.expected) ?? stringValue(failure?.expected),
    actual: stringValue(entry.actual) ?? stringValue(failure?.actual),
    file: stringValue(entry.file)
      ?? stringValue(entry.filePath)
      ?? stringValue(entry.file_path)
      ?? stringValue(entry.sourceFile)
      ?? stringValue(entry.source_file)
      ?? stringValue(failure?.file),
    line,
    column: numberValue(
      entry.column
        ?? entry.columnNumber
        ?? entry.column_number
        ?? entry.sourceColumn
        ?? entry.source_column
        ?? failure?.column,
    ),
  }
}

function normalizeStatus(value: unknown): TestCaseStatus {
  const status = stringValue(value)?.trim().toLowerCase()
  if (!status) {
    return 'unknown'
  }
  if (['pass', 'passed', 'success', 'successful', 'ok'].includes(status)) {
    return 'passed'
  }
  if (['fail', 'failed', 'failure', 'error'].includes(status)) {
    return 'failed'
  }
  if (['skip', 'skipped', 'ignored', 'pending'].includes(status)) {
    return 'skipped'
  }
  return status
}

function normalizeDiagnostics(value: unknown): TestDiagnostic[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry) => {
    const diagnostic = isRecord(entry) ? entry : {}
    const severity = stringValue(diagnostic.severity) ?? stringValue(diagnostic.level) ?? 'error'
    return {
      message: typeof entry === 'string'
        ? entry
        : stringValue(diagnostic.message) ?? stringValue(diagnostic.text) ?? 'Compilation error',
      severity: severity.toLowerCase(),
      file: stringValue(diagnostic.file)
        ?? stringValue(diagnostic.filePath)
        ?? stringValue(diagnostic.file_path)
        ?? stringValue(diagnostic.sourceFile)
        ?? stringValue(diagnostic.source_file),
      line: numberValue(
        diagnostic.line
          ?? diagnostic.lineNumber
          ?? diagnostic.line_number
          ?? diagnostic.sourceLine
          ?? diagnostic.source_line,
      ),
      column: numberValue(
        diagnostic.column
          ?? diagnostic.columnNumber
          ?? diagnostic.column_number
          ?? diagnostic.sourceColumn
          ?? diagnostic.source_column,
      ),
    }
  })
}

function deriveCounts(tests: TestCaseResult[]): Pick<TestSummary, 'total' | 'passed' | 'failed' | 'skipped'> {
  return tests.reduce((counts, test) => {
    counts.total += 1
    if (test.status === 'passed') counts.passed += 1
    if (test.status === 'failed') counts.failed += 1
    if (test.status === 'skipped') counts.skipped += 1
    return counts
  }, { total: 0, passed: 0, failed: 0, skipped: 0 })
}

function inferSuccess(value: Record<string, unknown>): boolean {
  const phase = normalizePhase(value.phase)
  if (phase === 'compile' || phase === 'runner' || phase === 'noTests') {
    return false
  }
  const tests = normalizeTests(value.tests ?? value.testResults ?? value.test_results)
  const summary = normalizeSummary(value.summary, tests)
  return summary.failed === 0 && summary.errors === 0
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord)
}

function hasStructuredFields(value: Record<string, unknown>): boolean {
  return [
    'phase',
    'summary',
    'tests',
    'testResults',
    'test_results',
    'diagnostics',
    'errors',
    'compilationDiagnostics',
  ].some((key) => key in value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function countValue(value: unknown): number | undefined {
  const number = numberValue(value)
  if (number !== undefined) {
    return number
  }
  return Array.isArray(value) ? value.length : undefined
}

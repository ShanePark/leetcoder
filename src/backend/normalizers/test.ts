import type {
  ProblemDiagnostic,
  TestCaseResult,
  TestCaseStatus,
  TestDiagnostic,
  TestPhase,
  TestResult,
  TestRunProgress,
  TestSummary,
} from '../contracts'
import { countValue, firstRecord, isRecord, numberValue, stringValue } from './common'

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

export function normalizePhase(value: unknown): TestPhase {
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
  const errors = Math.max(countValue(summary.errors) ?? 0, counts.errors)
  const failed = Math.max(
    numberValue(summary.failed ?? summary.failing ?? summary.failures) ?? 0,
    counts.failed,
    errors,
  )
  return {
    total: Math.max(
      numberValue(summary.total ?? summary.count ?? summary.testCount) ?? 0,
      counts.total,
    ),
    passed: Math.max(
      numberValue(summary.passed ?? summary.passing ?? summary.successful) ?? 0,
      counts.passed,
    ),
    // Runtime errors are failures from the user's perspective. Preserve the
    // separate count while ensuring the existing UI cannot render "0 failed"
    // for an errored run.
    failed,
    skipped: Math.max(
      numberValue(summary.skipped ?? summary.ignored) ?? 0,
      counts.skipped,
    ),
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

export function normalizeTestCase(value: unknown, index: number): TestCaseResult {
  if (typeof value === 'string') {
    return { name: value, status: 'unknown' }
  }
  const entry = isRecord(value) ? value : {}
  const failure = firstRecord(entry.failure, entry.error)
  const output = firstRecord(entry.output, entry.testOutput, entry.test_output)
  const outputText = stringValue(entry.output)
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
    className: stringValue(entry.className)
      ?? stringValue(entry.class_name)
      ?? stringValue(entry.testClass)
      ?? stringValue(entry.test_class)
      ?? stringValue(failure?.className)
      ?? stringValue(failure?.class_name),
    displayName: stringValue(entry.displayName) ?? stringValue(entry.display_name) ?? stringValue(entry.name),
    status,
    durationMs: numberValue(entry.durationMs ?? entry.duration_ms ?? entry.duration),
    message: stringValue(entry.message) ?? stringValue(entry.errorMessage) ?? stringValue(failure?.message),
    details: stringValue(entry.details)
      ?? stringValue(entry.stackTrace)
      ?? stringValue(entry.stack_trace)
      ?? stringValue(entry.trace)
      ?? stringValue(failure?.details)
      ?? stringValue(failure?.stackTrace)
      ?? stringValue(failure?.stack_trace),
    stdout: stringValue(entry.stdout)
      ?? stringValue(entry.systemOut)
      ?? stringValue(entry.system_out)
      ?? stringValue(output?.stdout)
      ?? stringValue(output?.systemOut)
      ?? stringValue(output?.system_out)
      ?? stringValue(failure?.stdout)
      ?? stringValue(failure?.systemOut)
      ?? stringValue(failure?.system_out)
      ?? outputText,
    stderr: stringValue(entry.stderr)
      ?? stringValue(entry.systemErr)
      ?? stringValue(entry.system_err)
      ?? stringValue(output?.stderr)
      ?? stringValue(output?.systemErr)
      ?? stringValue(output?.system_err)
      ?? stringValue(failure?.stderr)
      ?? stringValue(failure?.systemErr)
      ?? stringValue(failure?.system_err),
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

/**
 * Normalizes the small, tagged event stream emitted while a test run is in
 * progress. Unknown or malformed events are ignored so a newer Rust build
 * cannot take down an otherwise valid final result.
 */
export function normalizeTestRunProgress(value: unknown): TestRunProgress | null {
  if (!isRecord(value)) {
    return null
  }
  const rawKind = stringValue(value.kind) ?? stringValue(value.type)
  const kind = rawKind?.trim().toLowerCase().replace(/[\s_-]/g, '')
  switch (kind) {
    case 'started':
      return { kind: 'started' }
    case 'phase': {
      const phase = stringValue(value.phase)
      return phase ? { kind: 'phase', phase: normalizePhase(phase) } : null
    }
    case 'log': {
      const stream = stringValue(value.stream)?.trim().toLowerCase()
      const text = stringValue(value.text)
      if ((stream !== 'stdout' && stream !== 'stderr') || text === undefined) {
        return null
      }
      return { kind: 'log', stream, text }
    }
    case 'teststarted':
    case 'testfinished': {
      const rawTest = value.test
      if (!isRecord(rawTest)) {
        return null
      }
      const name = stringValue(rawTest.name) ?? stringValue(rawTest.id)
      if (!name) {
        return null
      }
      const test = normalizeTestCase(rawTest, 0)
      if (kind === 'teststarted' && test.status === 'unknown') {
        test.status = 'running'
      }
      return kind === 'teststarted'
        ? { kind: 'testStarted', test }
        : { kind: 'testFinished', test }
    }
    default:
      return null
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
  if (['error', 'errored', 'exception'].includes(status)) {
    return 'error'
  }
  if (['fail', 'failed', 'failure'].includes(status)) {
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
    // Rust reuses `source` both for the offending javac source line and for
    // the "runner"/"junit" sentinels marking runner/report-level failures.
    const rawSource = stringValue(diagnostic.source)
    const sentinel = rawSource === 'runner' || rawSource === 'junit' ? rawSource : undefined
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
      origin: sentinel ?? 'javac',
      sourceLine: sentinel === undefined && rawSource !== undefined && rawSource.trim().length > 0
        ? rawSource
        : null,
      caret: sentinel === undefined ? stringValue(diagnostic.caret) ?? null : null,
    }
  })
}

/** Normalize the dedicated editor diagnostics response without hiding a bad payload. */
export function normalizeProblemDiagnostics(value: unknown): ProblemDiagnostic[] {
  if (Array.isArray(value)) {
    return normalizeDiagnostics(value)
  }
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) {
    throw new Error('The problem diagnostics response was invalid.')
  }
  return normalizeDiagnostics(value.diagnostics)
}

function deriveCounts(tests: TestCaseResult[]): Pick<TestSummary, 'total' | 'passed' | 'failed' | 'skipped' | 'errors'> {
  return tests.reduce((counts, test) => {
    counts.total += 1
    if (test.status === 'passed') counts.passed += 1
    if (test.status === 'failed' || test.status === 'error') counts.failed += 1
    if (test.status === 'error') counts.errors += 1
    if (test.status === 'skipped') counts.skipped += 1
    return counts
  }, { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 })
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

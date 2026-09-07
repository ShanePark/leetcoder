import type {
  ProblemDiagnostic,
  TestCaseResult,
  TestDiagnostic,
  TestPhase,
  TestResult,
} from '../backend'
import type { EditorIssue } from '../editor'

import type {
  CurrentTestSource,
  TestResultPresentation,
  TestRunSnapshot,
  TestRunSourceSnapshot,
} from './types'
import {
  sourceBasename,
  sourcePathsMatch,
  validSourceColumn,
  validSourceLine,
} from './path-helpers'

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

export function testPhaseLabel(phase: TestPhase): string {
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

export function testStatusLabel(status: string): string {
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

export function normalizeTestPhase(phase: TestPhase): 'compile' | 'runner' | 'noTests' | 'test' | 'unknown' {
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
  const failedTest = result.tests.find((test) => {
    if (test.status !== 'failed' && test.status !== 'error') {
      return false
    }
    return Boolean(
      test.message?.trim().length
      || test.details?.trim().length
      || test.expected !== null && test.expected !== undefined
      || test.actual !== null && test.actual !== undefined,
    )
  })
  if (phase === 'compile' && diagnostic) {
    return shortenResultMessage(diagnostic.message)
  }
  if (phase === 'test' && failedTest) {
    const conciseFailure = conciseTestFailureMessage(failedTest)
    if (conciseFailure) {
      return conciseFailure
    }
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
  const expected = test.expected !== null && test.expected !== undefined
    ? test.expected.trim()
    : null
  const actual = test.actual !== null && test.actual !== undefined
    ? test.actual.trim()
    : null
  if (expected !== null && actual !== null) {
    return shortenResultMessage(`Expected ${expected}, but was ${actual}`)
  }
  const message = test.message?.trim()
  if (message) {
    return shortenResultMessage(stripTestFailureExceptionPrefix(message))
  }
  const details = test.details?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^at\s+/.test(line) && !/^caused by:\s*$/i.test(line))
  return details ? shortenResultMessage(stripTestFailureExceptionPrefix(details)) : null
}

function stripTestFailureExceptionPrefix(message: string): string {
  const prefix = 'org.opentest4j.AssertionFailedError:'
  return message.startsWith(prefix)
    ? message.slice(prefix.length).trim()
    : message.trim()
}

export type TestCaseDetailSection = 'console' | 'failure' | 'comparison' | 'location' | 'stack'

/**
 * Keep the selected-test detail order testable without requiring a DOM in
 * frontend unit tests. Console output intentionally leads all failure data.
 */
export function testCaseDetailSectionOrder(test: TestCaseResult): TestCaseDetailSection[] {
  const sections: TestCaseDetailSection[] = []
  if (testCaseHasOutput(test)) {
    sections.push('console')
  }
  const hasExpected = test.expected !== null && test.expected !== undefined
  const hasActual = test.actual !== null && test.actual !== undefined
  // Expected/Actual rows already explain a structured assertion failure, so
  // don't spend vertical space on the same message a second time.
  if ((!hasExpected || !hasActual) && conciseTestFailureMessage(test)) {
    sections.push('failure')
  }
  if (hasExpected || hasActual) {
    sections.push('comparison')
  }
  if (test.file && validSourceLine(test.line) !== null) {
    sections.push('location')
  }
  if (test.details) {
    sections.push('stack')
  }
  return sections
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
 * values, equal strings, or values with no shared context).
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
  // A full replacement such as `true` → `false` has no useful context for an
  // inline mark. Leave both values as plain text in their Expected/Actual
  // rows so the row-level colors carry the comparison without a redundant
  // block around the entire value.
  if (prefix < 2 && suffix < 2) {
    return null
  }
  return {
    prefix: expected.slice(0, prefix),
    expectedMid: expected.slice(prefix, expected.length - suffix),
    actualMid: actual.slice(prefix, actual.length - suffix),
    suffix: expected.slice(expected.length - suffix),
  }
}

/** Collect unique red markers that belong to the currently open source file. */
export function collectEditorIssues(
  result: TestResult,
  selectedPath: string | null,
): EditorIssue[] {
  return collectDiagnosticEditorIssues(
    result.diagnostics,
    selectedPath,
    result.tests,
  )
}

/** Collect compiler markers without constructing a synthetic test result. */
export function collectDiagnosticEditorIssues(
  diagnostics: readonly ProblemDiagnostic[],
  selectedPath: string | null,
  tests: readonly TestCaseResult[] = [],
): EditorIssue[] {
  if (!selectedPath) {
    return []
  }
  const issues: EditorIssue[] = []
  const seen = new Set<string>()
  const add = (
    file: string | null | undefined,
    lineValue: number | null | undefined,
    columnValue: number | null | undefined,
    message: string | null | undefined,
  ): void => {
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

  for (const test of tests) {
    if (test.status !== 'failed' && test.status !== 'error') {
      continue
    }
    add(test.file, test.line, test.column, test.message ?? test.details ?? `${test.name} failed`)
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity.trim().toLowerCase() !== 'error') {
      continue
    }
    add(diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.message)
  }
  return issues
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

/**
 * Test names are stable across the progress events and the final JUnit
 * report, so use the class/name pair as the selection identity. Keeping this
 * outside the DOM also means a live result refresh does not lose the user's
 * selected test while its output is still arriving.
 */
export function testResultKey(test: TestCaseResult): string {
  // Encode both fields so the identity is safe to carry in a data attribute;
  // class/name values can otherwise contain separators or control characters.
  return `${encodeURIComponent(test.className ?? '')}:${encodeURIComponent(test.name)}`
}

/**
 * Return the first actionable test in the runner's source/order-preserved
 * result list. The result tree may sort rows for readability, but automatic
 * selection should follow the order in which the runner reported tests.
 */
export function firstFailedTestKey(tests: TestCaseResult[]): string | null {
  const failed = tests.find((test) => test.status === 'failed' || test.status === 'error')
  return failed ? testResultKey(failed) : null
}

/**
 * Choose a failed test for automatic live-result selection while preserving
 * an existing selection. A root or row selected by the user is represented by
 * `selectionExplicit`; an automatically selected row is retained so later
 * failures cannot make the detail pane jump to a different test.
 */
export function autoSelectedTestKey(
  tests: TestCaseResult[],
  selectedTestKey: string | null,
  selectionExplicit: boolean,
): string | null {
  if (selectionExplicit || selectedTestKey !== null) {
    return selectedTestKey
  }
  return firstFailedTestKey(tests)
}

export function sameTest(left: TestCaseResult | null, right: TestCaseResult): boolean {
  if (!left) {
    return false
  }
  return left.name === right.name && (left.className ?? '') === (right.className ?? '')
}

function isInternalTestFrame(line: string): boolean {
  return /^at\s+(?:java\.|javax\.|jdk\.|sun\.|com\.sun\.|org\.junit\.|org\.gradle\.|org\.hamcrest\.|kotlin\.|worker\.)/i.test(line)
}

function firstUsefulOutputLine(output: string): string | null {
  const lines = stripAnsi(output)
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

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
}

export { sourceBasename, sourcePathsMatch, validSourceColumn, validSourceLine }

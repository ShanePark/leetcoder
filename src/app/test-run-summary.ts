import type { TestDiagnostic, TestResult } from '../backend'
import type { AppIcon } from '../icons'
import { formatDuration, liveRunPhaseLabel, testRunFacts } from './layout'
import { normalizeTestPhase } from './test-results'

export type TestRunTone = 'success' | 'failure' | 'error' | 'warning' | 'running'

/** The outcome line shown at the top of the test list. */
export interface TestRunVerdict {
  tone: TestRunTone
  icon: AppIcon
  label: string
  facts: string[]
}

/**
 * Summarize a finished or live run: verdict, its icon and tone, and the facts
 * that matter for that verdict (counts, error totals, duration).
 */
export function testRunVerdict(
  result: TestResult,
  isRunning: boolean,
  isRunnerError: boolean,
  errorDiagnostics: readonly TestDiagnostic[],
): TestRunVerdict {
  if (isRunning) {
    return {
      tone: 'running',
      icon: 'loader',
      label: liveRunPhaseLabel(result.phase),
      facts: testRunFacts(result.summary),
    }
  }
  const phase = normalizeTestPhase(result.phase)
  const hasFailure = !result.success || isRunnerError
  const facts: string[] = []
  let verdict: Omit<TestRunVerdict, 'facts'>
  if (phase === 'cancelled') {
    verdict = { tone: 'warning', icon: 'alert', label: 'Stopped' }
  } else if (phase === 'timedOut') {
    verdict = { tone: 'failure', icon: 'close', label: 'Timed out after 5 seconds' }
  } else if (!hasFailure) {
    verdict = { tone: 'success', icon: 'check', label: 'Passed' }
    if (result.summary.total > 0) {
      facts.push(`${result.summary.total} test${result.summary.total === 1 ? '' : 's'}`)
    }
  } else if (phase === 'compile') {
    verdict = { tone: 'failure', icon: 'close', label: 'Compile error' }
    if (errorDiagnostics.length > 0) {
      facts.push(`${errorDiagnostics.length} error${errorDiagnostics.length === 1 ? '' : 's'}`)
    }
  } else if (phase === 'noTests') {
    verdict = { tone: 'warning', icon: 'alert', label: 'No tests ran' }
  } else if (isRunnerError) {
    verdict = { tone: 'error', icon: 'alert', label: 'Runner error' }
  } else {
    verdict = { tone: 'failure', icon: 'close', label: 'Failed' }
    const failedCount = result.summary.failed + result.summary.errors
    if (failedCount > 0 && result.summary.total > 0) {
      facts.push(`${failedCount} of ${result.summary.total} failed`)
    }
  }
  if (
    result.summary.durationMs !== null
    && result.summary.durationMs !== undefined
    && phase !== 'compile'
    && phase !== 'timedOut'
  ) {
    facts.push(formatDuration(result.summary.durationMs))
  }
  return { ...verdict, facts }
}

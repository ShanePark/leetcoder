import { describe, expect, it } from 'vitest'

import {
  presentTestResult,
  summarizeLiveTests,
  testResultBannerMessage,
} from '../../src/app'
import type { TestResult } from '../../src/backend'

function result(overrides: Partial<TestResult>): TestResult {
  return {
    success: false,
    phase: 'runner',
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      durationMs: 12,
    },
    tests: [],
    diagnostics: [],
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

describe('test result failure presentation', () => {
  it('shows the runner stderr when no tests or diagnostics were produced', () => {
    const run = result({ stderr: 'Gradle daemon disappeared unexpectedly' })

    expect(presentTestResult(run)).toMatchObject({
      phaseLabel: 'Test runner',
      statusLabel: 'Failed · Test runner',
      failureMessage: 'Gradle daemon disappeared unexpectedly',
      rawLogsOpen: true,
    })
    expect(testResultBannerMessage(run)).toBe(
      'Test runner failed: Gradle daemon disappeared unexpectedly',
    )
  })

  it('falls back to stdout when stderr is empty', () => {
    const run = result({
      phase: 'runner',
      stdout: 'Execution failed for task :test.',
    })

    expect(presentTestResult(run).failureMessage).toBe('Execution failed for task :test.')
    expect(testResultBannerMessage(run)).toContain('Execution failed for task :test.')
  })

  it('uses a compile diagnostic as the concise failure message', () => {
    const run = result({
      phase: 'compilation',
      diagnostics: [{
        severity: 'error',
        message: 'cannot find symbol',
        file: 'Q3622.java',
        line: 17,
      }],
      stderr: '',
    })

    expect(presentTestResult(run)).toMatchObject({
      phaseLabel: 'Compilation',
      failureMessage: 'cannot find symbol',
      rawLogsOpen: true,
    })
    expect(testResultBannerMessage(run)).toBe('Compilation failed: cannot find symbol')
  })

  it('keeps successful run output collapsed', () => {
    const run = result({
      success: true,
      phase: 'tests',
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, errors: 0, durationMs: 8 },
      tests: [{ name: 'test()', status: 'passed' }],
      stdout: 'BUILD SUCCESSFUL',
    })

    expect(presentTestResult(run)).toMatchObject({
      phaseLabel: 'Tests',
      statusLabel: 'Passed',
      failureMessage: null,
      rawLogsOpen: false,
    })
  })

  it('prefers an error diagnostic over an earlier warning', () => {
    const run = result({
      phase: 'compile',
      diagnostics: [
        { severity: 'warning', message: 'unused import' },
        { severity: 'error', message: 'cannot find symbol' },
      ],
    })

    expect(presentTestResult(run).failureMessage).toBe('cannot find symbol')
    expect(testResultBannerMessage(run)).toBe('Compilation failed: cannot find symbol')
  })

  it('counts live error tests separately while keeping them failed', () => {
    expect(summarizeLiveTests([
      { name: 'pass()', status: 'passed' },
      { name: 'error()', status: 'error' },
      { name: 'skip()', status: 'skipped' },
    ], 42)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      errors: 1,
      durationMs: 42,
    })
  })
})

import { describe, expect, it } from 'vitest'

import {
  collectEditorIssues,
  isTestRunSourceCurrent,
  presentTestResult,
  sourcePathsMatch,
  summarizeLiveTests,
  testCaseHasOutput,
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
      rawLogsOpen: false,
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
      rawLogsOpen: false,
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
    expect(testResultBannerMessage(run)).toBe('All tests passed')
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

  it('recognizes non-empty per-test output for automatic row expansion', () => {
    expect(testCaseHasOutput({ name: 'prints()', status: 'passed', stdout: 'hi\n' })).toBe(true)
    expect(testCaseHasOutput({ name: 'warns()', status: 'passed', stderr: 'warning' })).toBe(true)
    expect(testCaseHasOutput({ name: 'quiet()', status: 'passed', stdout: '', stderr: null })).toBe(false)
  })
})

describe('editor failure locations', () => {
  it('matches absolute, repository-suffix, and basename source paths', () => {
    expect(sourcePathsMatch(
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      '/tmp/leetcoder/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
    )).toBe(true)
    expect(sourcePathsMatch(
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      'Q1TwoSum.java',
    )).toBe(true)
    expect(sourcePathsMatch(
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      'src/test/java/Q1TwoSum.java',
    )).toBe(false)
    expect(sourcePathsMatch('src/main/java/Q1TwoSum.java', 'Q2TwoSum.java')).toBe(false)
  })

  it('collects matching failed tests and error diagnostics once per position', () => {
    const run = result({
      phase: 'test',
      tests: [
        {
          name: 'fails()',
          status: 'failed',
          file: 'Q1TwoSum.java',
          line: 12,
          column: 8,
          message: 'expected 2 but was 3',
        },
        {
          name: 'same-failure()',
          status: 'error',
          file: '/repo/src/main/java/Q1TwoSum.java',
          line: 12,
          column: 8,
          message: 'duplicate position',
        },
        {
          name: 'passes()',
          status: 'passed',
          file: 'Q1TwoSum.java',
          line: 15,
        },
        {
          name: 'other-file()',
          status: 'failed',
          file: 'Q2TwoSum.java',
          line: 4,
        },
      ],
      diagnostics: [
        {
          severity: 'warning',
          message: 'unused import',
          file: 'Q1TwoSum.java',
          line: 2,
        },
        {
          severity: 'error',
          message: 'cannot find symbol',
          file: 'src/main/java/Q1TwoSum.java',
          line: 20,
          column: 3,
        },
      ],
    })

    expect(collectEditorIssues(run, 'src/main/java/Q1TwoSum.java')).toEqual([
      {
        file: 'Q1TwoSum.java',
        line: 12,
        column: 8,
        message: 'expected 2 but was 3',
      },
      {
        file: 'src/main/java/Q1TwoSum.java',
        line: 20,
        column: 3,
        message: 'cannot find symbol',
      },
    ])
  })

  it('ignores locations with invalid coordinates or no selected file', () => {
    const run = result({
      tests: [{ name: 'bad()', status: 'failed', file: 'Q.java', line: 0 }],
      diagnostics: [{ severity: 'error', message: 'bad', file: 'Q.java', line: -1 }],
    })
    expect(collectEditorIssues(run, 'Q.java')).toEqual([])
    expect(collectEditorIssues(run, null)).toEqual([])
  })
})

describe('test run source snapshots', () => {
  const snapshot = {
    repoPath: '/repo',
    filePath: 'src/main/java/Q1TwoSum.java',
    source: 'class Q1TwoSum {}',
  }

  it('accepts the exact repository path, file path, and source', () => {
    expect(isTestRunSourceCurrent(snapshot, snapshot)).toBe(true)
  })

  it('rejects a result after the file or source changes', () => {
    expect(isTestRunSourceCurrent(snapshot, {
      ...snapshot,
      filePath: 'src/main/java/Q2Add.java',
    })).toBe(false)
    expect(isTestRunSourceCurrent(snapshot, {
      ...snapshot,
      source: 'class Q1TwoSum { int changed; }',
    })).toBe(false)
    expect(isTestRunSourceCurrent(snapshot, {
      ...snapshot,
      repoPath: '/other-repo',
    })).toBe(false)
  })
})

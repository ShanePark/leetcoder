import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TestRunProgress } from '../../../src/backend'
import { createDevMockBackend } from '../../../src/dev-mock'

const repo = '/preview'
const className = 'shane.leetcode.problems.easy.Q1TwoSum'
const sourceFile = 'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { location: { search: '?mock' } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function scenario(value: string): void {
  vi.stubGlobal('window', { location: { search: `?mock=${value}` } })
}

async function runScenario(value: string, testMethod?: string) {
  scenario(value)
  const backend = createDevMockBackend()
  const progress: TestRunProgress[] = []
  const pending = backend.runProblemTest(repo, className, 7, (event) => progress.push(event), testMethod)
  await vi.runAllTimersAsync()
  return { backend, result: await pending, progress }
}

describe('browser preview test scenarios', () => {
  it('retains compile, test, and final-log delays and ordered progress', async () => {
    scenario('pass')
    const backend = createDevMockBackend()
    const progress: TestRunProgress[] = []
    let settled = false
    const pending = backend.runProblemTest(repo, className, 1, (event) => progress.push(event))
      .then((result) => { settled = true; return result })
    expect(progress).toEqual([{ kind: 'started' }, { kind: 'phase', phase: 'compiling' }])
    await vi.advanceTimersByTimeAsync(599)
    expect(progress).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(progress.slice(2)).toEqual([
      { kind: 'phase', phase: 'runningTests' },
      { kind: 'testStarted', test: { name: 'test()', className, displayName: 'test()', status: 'running', durationMs: 18 } },
    ])
    await vi.advanceTimersByTimeAsync(139)
    expect(progress).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(progress[4]).toMatchObject({ kind: 'testFinished', test: { name: 'test()', status: 'passed' } })
    await vi.advanceTimersByTimeAsync(560)
    expect(progress.at(-1)).toEqual({ kind: 'log', stream: 'stdout', text: '> Task :test\nBUILD SUCCESSFUL in 1s\n' })
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(119)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result).toMatchObject({
      success: true, phase: 'test', exitCode: 0,
      summary: { total: 5, passed: 5, failed: 0, skipped: 0, errors: 0, durationMs: 1460 },
      diagnostics: [], stderr: '',
    })
    expect(progress.map((event) => event.kind)).toEqual([
      'started', 'phase', 'phase',
      'testStarted', 'testFinished', 'testStarted', 'testFinished', 'testStarted', 'testFinished',
      'testStarted', 'testFinished', 'testStarted', 'testFinished', 'log',
    ])
    expect(await backend.stopProblemTest(1)).toBe(false)
  })

  it.each(['', 'fail', 'unknown'])('defaults %j to the failing assertion fixture', async (value) => {
    const { result } = await runScenario(value)
    expect(result).toMatchObject({
      success: false, phase: 'test', exitCode: 1,
      summary: { total: 5, passed: 4, failed: 1 },
      stdout: '> Task :test\nBUILD FAILED in 1s\n', stderr: '5 tests completed, 1 failed\n',
    })
    expect(result.tests[2]).toMatchObject({
      name: 'testSortedOutput()', status: 'failed', expected: '[1, 2, 3]', actual: '[1, 2, 4]',
      file: sourceFile, line: 31, column: 9, stdout: 'sorting input [3, 1, 2]\ncomparing result…\n',
    })
    expect(result.tests[2].details).toContain(`at ${className}.testSortedOutput(Q1TwoSum.java:31)`)
  })

  it('reports compiler diagnostics without starting tests', async () => {
    const { result, progress } = await runScenario('compile')
    expect(result).toEqual({
      success: false, phase: 'compile',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 640 },
      tests: [],
      diagnostics: [
        {
          severity: 'error',
          message: 'cannot find symbol\n  symbol:   method checkDivisibilty(int)\n  location: class Solution',
          file: sourceFile, line: 24, column: 27, origin: 'javac',
          sourceLine: '        assertThat(checkDivisibilty(99)).isTrue();', caret: '                          ^',
        },
        {
          severity: 'error', message: "';' expected", file: sourceFile, line: 25, column: 48, origin: 'javac',
          sourceLine: '        assertThat(checkDivisibility(23)).isFalse()', caret: '                                               ^',
        },
      ],
      stdout: '', stderr: `${sourceFile}:24: error: cannot find symbol\n2 errors\n`, exitCode: 1,
    })
    expect(progress).toEqual([
      { kind: 'started' }, { kind: 'phase', phase: 'compiling' },
      { kind: 'log', stream: 'stderr', text: `${sourceFile}:24: error: cannot find symbol\n` },
    ])
  })

  it('returns the no-tests result only after its additional delay', async () => {
    scenario('notests')
    const backend = createDevMockBackend()
    let settled = false
    const pending = backend.runProblemTest(repo, className, 1)
      .then((result) => { settled = true; return result })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({
      success: false, phase: 'noTests',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 1040 },
      tests: [], diagnostics: [], stdout: '> Task :test\n', stderr: '', exitCode: 0,
    })
  })

  it('filters method names with or without parentheses and reports unmatched methods', async () => {
    for (const name of ['testSortedOutput', 'testSortedOutput()']) {
      const { result, progress } = await runScenario('pass', name)
      expect(result.tests.map((test) => test.name)).toEqual(['testSortedOutput()'])
      expect(result.summary).toMatchObject({ total: 1, passed: 1, failed: 0 })
      expect(progress.filter((event) => event.kind === 'testStarted')).toHaveLength(1)
    }
    const { result, progress } = await runScenario('pass', 'missing()')
    expect(result).toMatchObject({
      phase: 'noTests', success: false, tests: [], exitCode: 0,
      summary: { total: 0, durationMs: 600 }, stdout: `No tests found for ${className}.missing\n`,
    })
    expect(progress.map((event) => event.kind)).toEqual(['started', 'phase', 'phase'])
  })
})

describe('browser preview cancellation', () => {
  it('cancels compilation and removes the completed run', async () => {
    const backend = createDevMockBackend()
    const pending = backend.runProblemTest(repo, className, 8)
    expect(await backend.stopProblemTest(9)).toBe(false)
    expect(await backend.stopProblemTest(8)).toBe(true)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      success: false, phase: 'cancelled', tests: [], exitCode: null, stdout: '',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
      diagnostics: [{ severity: 'error', message: 'Test run stopped by user.', origin: 'runner' }],
      stderr: 'Test run stopped by user.',
    })
    expect(await backend.stopProblemTest(8)).toBe(false)
  })

  it('keeps only completed test cases when stopped during the next case', async () => {
    scenario('pass')
    const backend = createDevMockBackend()
    const progress: TestRunProgress[] = []
    const pending = backend.runProblemTest(repo, className, 8, (event) => progress.push(event))
    await vi.advanceTimersByTimeAsync(740)
    expect(await backend.stopProblemTest(8)).toBe(true)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.phase).toBe('cancelled')
    expect(result.tests.map((test) => test.name)).toEqual(['test()'])
    expect(result.summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 })
    expect(progress.filter((event) => event.kind === 'testFinished')).toHaveLength(1)
  })

  it('keeps cancellation local to each backend and captures the scenario at run start', async () => {
    const first = createDevMockBackend()
    const second = createDevMockBackend()
    scenario('compile')
    const firstRun = first.runProblemTest(repo, className, 8)
    scenario('pass')
    const secondRun = second.runProblemTest(repo, className, 8)
    expect(await first.stopProblemTest(8)).toBe(true)
    await vi.runAllTimersAsync()
    expect((await firstRun).phase).toBe('cancelled')
    expect((await secondRun).success).toBe(true)
  })

  it('does not remove a newer run using the same run ID when an older run finishes', async () => {
    const backend = createDevMockBackend()
    scenario('compile')
    const older = backend.runProblemTest(repo, className, 8)
    await vi.advanceTimersByTimeAsync(100)
    scenario('pass')
    const newer = backend.runProblemTest(repo, className, 8)
    await vi.advanceTimersByTimeAsync(500)
    expect((await older).phase).toBe('compile')
    expect(await backend.stopProblemTest(8)).toBe(true)
    await vi.runAllTimersAsync()
    expect((await newer).phase).toBe('cancelled')
    expect(await backend.stopProblemTest(8)).toBe(false)
  })
})

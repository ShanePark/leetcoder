import { describe, expect, it } from 'vitest'
import {
  autoSelectedTestKey,
  charDiffSegments,
  conciseTestFailureMessage,
  defaultVisibleTests,
  filterTestDiagnostics,
  firstFailedTestKey,
  relevantTestStackFrames,
  testCaseDetailSectionOrder,
  testOutputSegments,
} from '../../../src/app'
import type { TestCaseResult, TestDiagnostic } from '../../../src/backend'

describe('test failure and diagnostic presentation helpers', () => {
  it('creates continuous output segments without empty stream placeholders', () => {
    expect(testOutputSegments('hello\n', '')).toEqual([
      { stream: 'stdout', text: 'hello\n' },
    ])
    expect(testOutputSegments('', 'warning\n')).toEqual([
      { stream: 'stderr', text: 'warning\n' },
    ])
    expect(testOutputSegments('out\n', 'err\n')).toEqual([
      { stream: 'stdout', text: 'out\n' },
      { stream: 'stderr', text: 'err\n' },
    ])
    expect(testOutputSegments('out', 'err')).toEqual([
      { stream: 'stdout', text: 'out\n' },
      { stream: 'stderr', text: 'err' },
    ])
    expect(testOutputSegments('\u001b[31m \u001b[0m', '\n\t')).toEqual([])
  })

  it('formats expected and actual values and strips the assertion exception prefix', () => {
    expect(conciseTestFailureMessage({
      name: 'asserts',
      status: 'failed',
      message: 'org.opentest4j.AssertionFailedError: ignored message',
      expected: '3',
      actual: '2',
    })).toBe('Expected 3, but was 2')

    const test: TestCaseResult = {
      name: 'asserts',
      status: 'failed',
      details: 'org.opentest4j.AssertionFailedError: expected 3 but was 2\n'
        + '    at shane.leetcode.Q1Test.asserts(Q1Test.java:12)\n'
        + '    at org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:100)\n'
        + '    at java.base/java.lang.reflect.Method.invoke(Method.java:1)',
    }
    expect(conciseTestFailureMessage(test)).toBe('expected 3 but was 2')
    expect(relevantTestStackFrames(test.details)).toEqual([
      'at shane.leetcode.Q1Test.asserts(Q1Test.java:12)',
    ])
  })

  it('puts selected-test console output before structured comparison details', () => {
    expect(testCaseDetailSectionOrder({
      name: 'printsAndFails',
      status: 'failed',
      stdout: 'debug output\n',
      stderr: 'warning\n',
      expected: '3',
      actual: '2',
      details: 'at shane.leetcode.Q1Test.printsAndFails(Q1Test.java:12)',
    })).toEqual(['console', 'comparison', 'stack'])
  })

  it('keeps a failure message for unstructured failures', () => {
    expect(testCaseDetailSectionOrder({
      name: 'throws',
      status: 'failed',
      message: 'Expected an exception to be thrown',
      details: 'at shane.leetcode.Q1Test.throws(Q1Test.java:12)',
    })).toEqual(['failure', 'stack'])
  })

  it('hides only the noisy unknown-enum Status warnings', () => {
    const diagnostics: TestDiagnostic[] = [
      { severity: 'warning', message: 'warning: unknown enum constant Status.REQUIRED' },
      { severity: 'warning', message: 'unchecked conversion' },
      { severity: 'error', message: 'unknown enum constant Status.REQUIRED' },
    ]
    expect(filterTestDiagnostics(diagnostics)).toEqual([diagnostics[1]])
    expect(filterTestDiagnostics([
      { severity: '', message: 'unknown enum constant Foo.BAR' },
    ])).toEqual([])
  })

  it('keeps every test visible, ordered failed → errors → passed → skipped', () => {
    const tests: TestCaseResult[] = [
      { name: 'pass', status: 'passed' },
      { name: 'err', status: 'error' },
      { name: 'fail', status: 'failed' },
      { name: 'skip', status: 'skipped' },
      { name: 'fail2', status: 'failed' },
    ]
    expect(defaultVisibleTests(tests).map((test) => test.name))
      .toEqual(['fail', 'fail2', 'err', 'pass', 'skip'])
    // A live run keeps arrival order so rows do not jump while streaming.
    expect(defaultVisibleTests(tests, true)).toEqual(tests)
  })

  it('produces a character-level diff only for differing single-line values', () => {
    expect(charDiffSegments('[1, 2, 3]', '[1, 4, 3]')).toEqual({
      prefix: '[1, ',
      expectedMid: '2',
      actualMid: '4',
      suffix: ', 3]',
    })
    expect(charDiffSegments('abc', 'abcdef')).toEqual({
      prefix: 'abc',
      expectedMid: '',
      actualMid: 'def',
      suffix: '',
    })
    expect(charDiffSegments('same', 'same')).toBeNull()
    expect(charDiffSegments('multi\nline', 'multi line')).toBeNull()
    expect(charDiffSegments('true', 'false')).toBeNull()
    expect(charDiffSegments('left', 'right')).toBeNull()
    expect(charDiffSegments('foo1', 'bar1')).toBeNull()
  })
})

describe('test result selection', () => {
  it('auto-selects the first live failure while retaining automatic selection', () => {
    const firstFailure = [
      { name: 'passesFirst', status: 'passed' as const },
      { name: 'failsFirst', status: 'failed' as const, className: 'Suite' },
    ]
    const selected = autoSelectedTestKey(firstFailure, null, false)
    expect(selected).toBe('Suite:failsFirst')
    expect(autoSelectedTestKey([
      ...firstFailure,
      { name: 'errorsLater', status: 'error' as const, className: 'Suite' },
    ], selected, false)).toBe(selected)
  })

  it('does not replace an explicit root or row selection', () => {
    const tests: TestCaseResult[] = [
      { name: 'fails', status: 'failed', className: 'Suite' },
    ]
    expect(autoSelectedTestKey(tests, null, true)).toBeNull()
    expect(autoSelectedTestKey(tests, 'Suite:chosen', true)).toBe('Suite:chosen')
  })

  it('selects the first failed or errored test in runner order', () => {
    expect(firstFailedTestKey([
      { name: 'passesFirst', status: 'passed' },
      { name: 'failsFirst', status: 'failed', className: 'Suite' },
      { name: 'errorsLater', status: 'error', className: 'Suite' },
    ])).toBe('Suite:failsFirst')
  })

  it('leaves the run root selected when no test case failed', () => {
    expect(firstFailedTestKey([
      { name: 'passes', status: 'passed' },
      { name: 'skips', status: 'skipped' },
    ])).toBeNull()
    expect(firstFailedTestKey([])).toBeNull()
  })
})

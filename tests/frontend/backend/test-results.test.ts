import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  normalizeTestResult,
  normalizeTestRunProgress,
  type Invoke,
} from '../../../src/backend'

describe('backend client', () => {
  it('normalizes structured test results for the result panel', () => {
    const result = normalizeTestResult({
      success: false,
      structured_results: {
        phase: 'test',
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, duration_ms: 18 },
        tests: [
          { name: 'test()', status: 'passed', duration_ms: 4 },
          {
            name: 'testSecond()',
            status: 'failed',
            duration_ms: 14,
            message: 'expected 3 but was 2',
            expected: '3',
            actual: '2',
            file: 'src/main/java/Solution.java',
            line: 12,
          },
        ],
        diagnostics: [],
      },
      stdout: 'output',
      stderr: '',
    })

    expect(result.phase).toBe('test')
    expect(result.summary).toMatchObject({ total: 2, passed: 1, failed: 1, durationMs: 18 })
    expect(result.tests[1]).toMatchObject({
      status: 'failed',
      expected: '3',
      actual: '2',
      line: 12,
    })
  })

  it('derives compile phase and diagnostics when the structured payload omits a summary', () => {
    const result = normalizeTestResult({
      success: false,
      structuredResults: {
        diagnostics: [{ message: 'cannot find symbol', filePath: 'Solution.java', lineNumber: 8 }],
        tests: [],
      },
    })

    expect(result.phase).toBe('compile')
    expect(result.summary).toMatchObject({ total: 0, failed: 0 })
    expect(result.diagnostics[0]).toMatchObject({ message: 'cannot find symbol', file: 'Solution.java', line: 8 })
  })

  it('keeps javac source lines and caret markers on diagnostics', () => {
    const result = normalizeTestResult({
      success: false,
      phase: 'compile',
      summary: {},
      tests: [],
      diagnostics: [{
        severity: 'error',
        file: 'Solution.java',
        line: 8,
        column: 23,
        message: 'cannot find symbol',
        source: '        return valuee + 1;',
        caret: '                      ^',
      }],
      stdout: '',
      stderr: 'compile failed',
    })

    expect(result.diagnostics[0]).toMatchObject({
      origin: 'javac',
      sourceLine: '        return valuee + 1;',
      caret: '                      ^',
    })
  })

  it('maps runner and junit sentinel sources to diagnostic origins', () => {
    const result = normalizeTestResult({
      success: false,
      phase: 'runner',
      summary: {},
      tests: [],
      diagnostics: [
        { severity: 'error', message: 'runner crashed', source: 'runner', caret: null },
        { severity: 'error', message: 'report unreadable', source: 'junit', caret: 'stale caret' },
      ],
      stdout: '',
      stderr: '',
    })

    expect(result.diagnostics[0]).toMatchObject({ origin: 'runner', sourceLine: null, caret: null })
    expect(result.diagnostics[1]).toMatchObject({ origin: 'junit', sourceLine: null, caret: null })
  })

  it('defaults diagnostics without a source field to a javac origin', () => {
    const result = normalizeTestResult({
      success: false,
      structuredResults: {
        diagnostics: [{ message: 'cannot find symbol', filePath: 'Solution.java', lineNumber: 8 }],
        tests: [],
      },
    })

    expect(result.diagnostics[0]).toMatchObject({ origin: 'javac', sourceLine: null, caret: null })
  })

  it('normalizes no-tests and runner phases from the Rust result enum', () => {
    expect(normalizeTestResult({
      success: false,
      phase: 'noTests',
      summary: {},
      tests: [],
      diagnostics: [],
      stdout: 'BUILD SUCCESSFUL',
      stderr: '',
    }).phase).toBe('noTests')
    expect(normalizeTestResult({
      success: false,
      phase: 'runner',
      summary: {},
      tests: [],
      diagnostics: [],
      stdout: '',
      stderr: 'runner stopped',
    }).phase).toBe('runner')
  })

  it('reads direct Rust ProblemTestResult fields and source locations', () => {
    const result = normalizeTestResult({
      success: false,
      phase: 'compilation',
      summary: { total: 1, passed: 0, errors: 1, skipped: 0 },
      tests: [{
        name: 'test()',
        status: 'failed',
        sourceFile: 'src/main/java/Solution.java',
        sourceLine: 17,
      }],
      diagnostics: [],
      stdout: '',
      stderr: 'compile failed',
    })

    expect(result.phase).toBe('compile')
    expect(result.summary.failed).toBe(1)
    expect(result.tests[0]).toMatchObject({
      file: 'src/main/java/Solution.java',
      line: 17,
    })
  })

  it('keeps testcase suite names and failure stack details', () => {
    const result = normalizeTestResult({
      success: false,
      phase: 'test',
      summary: { total: 1, passed: 0, failed: 0, errors: 1, skipped: 0 },
      tests: [{
        className: 'shane.leetcode.Q1Test',
        name: 'fails()',
        status: 'error',
        details: 'java.lang.IllegalStateException\n  at Q1Test.fails(Q1Test.java:12)',
      }],
      diagnostics: [],
      stdout: '',
      stderr: '',
    })

    expect(result.tests[0]).toMatchObject({
      className: 'shane.leetcode.Q1Test',
      status: 'error',
      details: expect.stringContaining('IllegalStateException'),
    })
    expect(result.summary).toMatchObject({ failed: 1, errors: 1 })
  })

  it('normalizes per-test stdout and stderr from Rust and legacy JUnit shapes', () => {
    const result = normalizeTestResult({
      success: true,
      phase: 'test',
      summary: { total: 2, passed: 2 },
      tests: [
        {
          name: 'prints()',
          status: 'passed',
          stdout: 'hello\n',
          stderr: 'warning\n',
        },
        {
          name: 'legacy()',
          status: 'passed',
          output: {
            system_out: 'legacy stdout',
            system_err: 'legacy stderr',
          },
        },
      ],
      diagnostics: [],
      stdout: '',
      stderr: '',
    })

    expect(result.tests[0]).toMatchObject({ stdout: 'hello\n', stderr: 'warning\n' })
    expect(result.tests[1]).toMatchObject({ stdout: 'legacy stdout', stderr: 'legacy stderr' })
  })

  it('normalizes tagged progress events and ignores malformed payloads', () => {
    expect(normalizeTestRunProgress({ kind: 'phase', phase: 'compilation' })).toEqual({
      kind: 'phase',
      phase: 'compile',
    })
    expect(normalizeTestRunProgress({ kind: 'log', stream: 'stderr', text: 'warning' })).toEqual({
      kind: 'log',
      stream: 'stderr',
      text: 'warning',
    })
    expect(normalizeTestRunProgress({
      kind: 'testStarted',
      test: { className: 'Q1Test', name: 'fails()', status: 'unknown' },
    })).toMatchObject({
      kind: 'testStarted',
      test: { className: 'Q1Test', name: 'fails()', status: 'running' },
    })
    expect(normalizeTestRunProgress({ kind: 'log', stream: 'console', text: 'ignored' })).toBeNull()
    expect(normalizeTestRunProgress({ kind: 'testFinished', test: {} })).toBeNull()
  })

  it('passes a progress channel to the test command while keeping callback optional', async () => {
    const events: unknown[] = []
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('run_problem_test')
      const channel = args?.onEvent as { onmessage?: (event: unknown) => void }
      channel.onmessage?.({ kind: 'started' })
      channel.onmessage?.({ kind: 'log', stream: 'stdout', text: 'Gradle\n' })
      return {
        success: true,
        phase: 'test',
        summary: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
        tests: [],
        diagnostics: [],
        stdout: 'Gradle\n',
        stderr: '',
      }
    }

    const result = await createBackendClient(invoke).runProblemTest(
      '/repo',
      'shane.Q1',
      (event) => events.push(event),
    )

    expect(result.success).toBe(true)
    expect(events).toEqual([
      { kind: 'started' },
      { kind: 'log', stream: 'stdout', text: 'Gradle\n' },
    ])
  })

  it('passes an optional Java test method to the targeted test command', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('run_problem_test')
      expect(args).toMatchObject({
        repoPath: '/repo',
        fullyQualifiedClassName: 'shane.Q1',
        testMethod: 'test2',
      })
      return {
        success: true,
        phase: 'test',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 },
        tests: [{ name: 'test2()', className: 'shane.Q1', status: 'passed' }],
        diagnostics: [],
        stdout: '',
        stderr: '',
      }
    }

    const result = await createBackendClient(invoke).runProblemTest(
      '/repo',
      'shane.Q1',
      undefined,
      'test2',
    )

    expect(result.tests).toHaveLength(1)
    expect(result.tests[0].name).toBe('test2()')
  })

  it('checks an editor snapshot without saving it or starting a test run', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('check_problem_diagnostics')
      expect(args).toEqual({
        repoPath: '/repo',
        fullyQualifiedClassName: 'shane.Q1',
        source: 'class Q1 { void test() { missing(); } }',
      })
      return {
        diagnostics: [{
          severity: 'error',
          file: 'src/main/java/shane/Q1.java',
          line: 1,
          column: 30,
          message: 'cannot find symbol',
          source: 'class Q1 { void test() { missing(); } }',
          caret: '                             ^',
        }],
      }
    }

    await expect(createBackendClient(invoke).checkProblemDiagnostics?.(
      '/repo',
      'shane.Q1',
      'class Q1 { void test() { missing(); } }',
    )).resolves.toMatchObject([{
      severity: 'error',
      file: 'src/main/java/shane/Q1.java',
      line: 1,
      column: 30,
      message: 'cannot find symbol',
      origin: 'javac',
      sourceLine: 'class Q1 { void test() { missing(); } }',
    }])
  })

  it('rejects a malformed diagnostics response instead of treating it as no errors', async () => {
    const invoke: Invoke = async () => ({ unexpected: true })
    await expect(createBackendClient(invoke).checkProblemDiagnostics?.('/repo', 'shane.Q1', 'class Q1 {}'))
      .rejects.toThrow('problem diagnostics response was invalid')
  })

  it('preserves runtime errors and exposes them as failures to the existing UI summary', () => {
    const result = normalizeTestResult({
      phase: 'test',
      summary: { total: 1, passed: 0, failed: 0, errors: 1, skipped: 0 },
      tests: [{ name: 'test()', status: 'passed' }],
      diagnostics: [],
      stdout: '',
      stderr: 'Exception in test()',
    })

    expect(result.success).toBe(false)
    expect(result.summary).toMatchObject({ failed: 1, errors: 1 })
  })

  it('does not let an underspecified summary hide derived testcase counts', () => {
    const result = normalizeTestResult({
      success: false,
      phase: 'test',
      summary: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
      tests: [
        { className: 'Q1Test', name: 'passes()', status: 'passed' },
        { className: 'Q1Test', name: 'crashes()', status: 'error' },
        { className: 'Q1Test', name: 'skips()', status: 'skipped' },
      ],
      diagnostics: [],
      stdout: '',
      stderr: '',
    })

    expect(result.summary).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      errors: 1,
      skipped: 1,
    })
  })

  it('uses a non-zero legacy exit code when success is absent', () => {
    expect(normalizeTestResult({ stdout: '', stderr: '', exitCode: 1 }).success).toBe(false)
    expect(normalizeTestResult({ stdout: '', stderr: '', exitCode: 0 }).success).toBe(true)
  })
})

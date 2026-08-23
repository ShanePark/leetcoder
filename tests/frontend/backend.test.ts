import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  normalizeGitChanges,
  normalizeGitCommitResult,
  normalizeGitDiff,
  normalizeGitPushResult,
  normalizeTestResult,
  normalizeTestRunProgress,
  type Invoke,
} from '../../src/backend'

describe('backend client', () => {
  it('normalizes Git status paths and preserves staged/worktree columns', () => {
    expect(normalizeGitChanges({ changes: [{
      path: 'src/a file.java',
      status: 'MM',
      index_status: 'M',
      worktreeStatus: 'M',
      original_path: 'src/old file.java',
    }] })).toEqual([{
      path: 'src/a file.java',
      status: 'MM',
      indexStatus: 'M',
      worktreeStatus: 'M',
      originalPath: 'src/old file.java',
    }])
  })

  it('invokes Git diff, commit, and push with explicit arguments', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      if (command === 'get_git_diff') return 'diff --git a/Q1.java b/Q1.java\n'
      if (command === 'commit_git') {
        return { commitHash: 'abc123', message: 'Create Q1.java', paths: ['Q1.java'] }
      }
      if (command === 'push_git') return { output: 'done', branch: 'main' }
      throw new Error(`unexpected command ${command}`)
    }
    const backend = createBackendClient(invoke)

    await expect(backend.getGitDiff('/repo', ['Q1.java'])).resolves.toContain('diff --git')
    await expect(backend.commitGit('/repo', ['Q1.java'], 'Create Q1.java')).resolves.toMatchObject({
      commitHash: 'abc123',
    })
    await expect(backend.pushGit('/repo')).resolves.toMatchObject({ branch: 'main' })
    expect(calls).toEqual([
      { command: 'get_git_diff', args: { repoPath: '/repo', paths: ['Q1.java'] } },
      { command: 'commit_git', args: { repoPath: '/repo', paths: ['Q1.java'], message: 'Create Q1.java' } },
      { command: 'push_git', args: { repoPath: '/repo' } },
    ])
  })

  it('invokes deletion with the repository-relative source path', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('delete_problem_file')
      expect(args).toEqual({ repoPath: '/repo', path: 'src/main/java/Q1.java' })
      return undefined
    }

    await expect(
      createBackendClient(invoke).deleteProblemFile('/repo', 'src/main/java/Q1.java'),
    ).resolves.toBeUndefined()
  })

  it('accepts legacy-compatible Git response shapes', () => {
    expect(normalizeGitDiff({ patch: 'patch' })).toBe('patch')
    expect(normalizeGitCommitResult({ hash: 'deadbeef', files: ['Q1.java'] })).toMatchObject({
      commitHash: 'deadbeef',
      paths: ['Q1.java'],
    })
    expect(normalizeGitPushResult('pushed')).toEqual({ output: 'pushed', branch: null })
  })

  it('keeps Kotlin files for collision detection while ignoring unrelated files', async () => {
    const invoke: Invoke = async (command) => {
      expect(command).toBe('list_problem_files')
      return [
        'src/main/java/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation.java',
        'src/main/kotlin/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation5.kt',
        'src/main/java/shane/leetcode/problems/easy/README.md',
      ]
    }

    const files = await createBackendClient(invoke).listProblemFiles('/repo')

    expect(files.map((file) => file.path)).toEqual([
      'src/main/java/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation.java',
      'src/main/kotlin/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation5.kt',
    ])
  })

  it('normalizes the daily DTO and preserves the optional Java snippet', async () => {
    const invoke: Invoke = async (command) => {
      expect(command).toBe('fetch_daily_problem')
      return {
        date: '2026-08-22',
        frontendId: 3622,
        title: 'Check Divisibility by Digit Sum and Product',
        titleSlug: 'check-divisibility-by-digit-sum-and-product',
        difficulty: 'HARD',
        url: 'https://leetcode.com/problems/check-divisibility-by-digit-sum-and-product/',
        javaSnippet: 'class Solution { public boolean checkDivisibility(int n) { return true; } }',
      }
    }

    await expect(createBackendClient(invoke).fetchDailyProblem()).resolves.toMatchObject({
      frontendId: '3622',
      javaSnippet: expect.stringContaining('checkDivisibility'),
    })
  })

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

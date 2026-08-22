import { describe, expect, it } from 'vitest'

import { createBackendClient, normalizeTestResult, type Invoke } from '../../src/backend'

describe('backend client', () => {
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

  it('uses a non-zero legacy exit code when success is absent', () => {
    expect(normalizeTestResult({ stdout: '', stderr: '', exitCode: 1 }).success).toBe(false)
    expect(normalizeTestResult({ stdout: '', stderr: '', exitCode: 0 }).success).toBe(true)
  })
})

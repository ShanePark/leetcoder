import type { BackendClient, TestCaseResult, TestDiagnostic, TestResult, TestRunProgressHandler } from '../backend'
import { activeScenario, delay } from './runtime'

export function createMockTestRunner(): Pick<BackendClient, 'runProblemTest' | 'stopProblemTest'> {
  const activeTestRuns = new Map<number, { cancelled: boolean }>()
  return {
    async runProblemTest(
      _repoPath: string,
      fullyQualifiedClassName: string,
      testRunId: number,
      onProgress?: TestRunProgressHandler,
      testMethod?: string,
    ): Promise<TestResult> {
      const run = { cancelled: false }
      activeTestRuns.set(testRunId, run)
      const finish = (result: TestResult): TestResult => {
        if (activeTestRuns.get(testRunId) === run) {
          activeTestRuns.delete(testRunId)
        }
        return result
      }
      const scenario = activeScenario()
      const sourceFile = `src/main/java/${fullyQualifiedClassName.replace(/\./g, '/')}.java`
      const emit = onProgress ?? ((): void => {})
      emit({ kind: 'started' })
      emit({ kind: 'phase', phase: 'compiling' })
      await delay(600)

      if (run.cancelled) {
        return finish(stoppedMockTestResult([], ''))
      }

      if (scenario === 'compile') {
        const diagnostics: TestDiagnostic[] = [
          {
            severity: 'error',
            message: 'cannot find symbol\n  symbol:   method checkDivisibilty(int)\n  location: class Solution',
            file: sourceFile,
            line: 24,
            column: 27,
            origin: 'javac',
            sourceLine: '        assertThat(checkDivisibilty(99)).isTrue();',
            caret: '                          ^',
          },
          {
            severity: 'error',
            message: "';' expected",
            file: sourceFile,
            line: 25,
            column: 48,
            origin: 'javac',
            sourceLine: '        assertThat(checkDivisibility(23)).isFalse()',
            caret: '                                               ^',
          },
        ]
        emit({ kind: 'log', stream: 'stderr', text: `${sourceFile}:24: error: cannot find symbol\n` })
        return finish({
          success: false,
          phase: 'compile',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 640 },
          tests: [],
          diagnostics,
          stdout: '',
          stderr: `${sourceFile}:24: error: cannot find symbol\n2 errors\n`,
          exitCode: 1,
        })
      }

      emit({ kind: 'phase', phase: 'runningTests' })
      if (scenario === 'notests') {
        await delay(400)
        if (run.cancelled) {
          return finish(stoppedMockTestResult([], '> Task :test\n'))
        }
        return finish({
          success: false,
          phase: 'noTests',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 1040 },
          tests: [],
          diagnostics: [],
          stdout: '> Task :test\n',
          stderr: '',
          exitCode: 0,
        })
      }

      const failing = scenario === 'fail'
      const cases: TestCaseResult[] = [
        { name: 'test()', className: fullyQualifiedClassName, displayName: 'test()', status: 'passed', durationMs: 18 },
        { name: 'testSmallNumbers()', className: fullyQualifiedClassName, displayName: 'testSmallNumbers()', status: 'passed', durationMs: 3 },
        {
          name: 'testSortedOutput()',
          className: fullyQualifiedClassName,
          displayName: 'testSortedOutput()',
          status: failing ? 'failed' : 'passed',
          durationMs: 41,
          ...(failing
            ? {
              message: 'expected: [1, 2, 3] but was: [1, 2, 4]',
              details: 'org.opentest4j.AssertionFailedError: expected: [1, 2, 3] but was: [1, 2, 4]\n'
                + `    at ${fullyQualifiedClassName}.testSortedOutput(${sourceFile.slice(sourceFile.lastIndexOf('/') + 1)}:31)\n`
                + '    at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:38)\n'
                + '    at java.base/java.lang.reflect.Method.invoke(Method.java:565)',
              expected: '[1, 2, 3]',
              actual: '[1, 2, 4]',
              stdout: 'sorting input [3, 1, 2]\ncomparing result…\n',
              file: sourceFile,
              line: 31,
              column: 9,
            }
            : { stdout: 'sorting input [3, 1, 2]\n' }),
        },
        { name: 'testLargeInput()', className: fullyQualifiedClassName, displayName: 'testLargeInput()', status: 'passed', durationMs: 122 },
        { name: 'testEdgeCases()', className: fullyQualifiedClassName, displayName: 'testEdgeCases()', status: 'passed', durationMs: 7 },
      ]
      const methodName = testMethod?.replace(/\(.*$/, '')
      const selectedCases = cases.filter((test) => {
        if (!methodName) {
          return true
        }
        return test.name.replace(/\(.*$/, '') === methodName
      })
      if (methodName && selectedCases.length === 0) {
        return finish({
          success: false,
          phase: 'noTests',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 600 },
          tests: [],
          diagnostics: [],
          stdout: `No tests found for ${fullyQualifiedClassName}.${methodName}\n`,
          stderr: '',
          exitCode: 0,
        })
      }
      const completedCases: TestCaseResult[] = []
      for (const test of selectedCases) {
        if (run.cancelled) {
          return finish(stoppedMockTestResult(completedCases, '> Task :test\n'))
        }
        emit({ kind: 'testStarted', test: { ...test, status: 'running' } })
        await delay(140)
        if (run.cancelled) {
          return finish(stoppedMockTestResult(completedCases, '> Task :test\n'))
        }
        emit({ kind: 'testFinished', test })
        completedCases.push(test)
      }
      emit({ kind: 'log', stream: 'stdout', text: '> Task :test\nBUILD ' + (failing ? 'FAILED' : 'SUCCESSFUL') + ' in 1s\n' })
      await delay(120)
      if (run.cancelled) {
        return finish(stoppedMockTestResult(completedCases, '> Task :test\n'))
      }
      const failed = selectedCases.filter((test) => test.status === 'failed').length
      return finish({
        success: failed === 0,
        phase: 'test',
        summary: {
          total: selectedCases.length,
          passed: selectedCases.length - failed,
          failed,
          skipped: 0,
          errors: 0,
          durationMs: 1460,
        },
        tests: selectedCases,
        diagnostics: [],
        stdout: `> Task :test\nBUILD ${failing ? 'FAILED' : 'SUCCESSFUL'} in 1s\n`,
        stderr: failing ? '5 tests completed, 1 failed\n' : '',
        exitCode: failed === 0 ? 0 : 1,
      })
    },

    async stopProblemTest(testRunId: number): Promise<boolean> {
      const run = activeTestRuns.get(testRunId)
      if (!run) {
        return false
      }
      run.cancelled = true
      return true
    },

  }
}

function stoppedMockTestResult(tests: TestCaseResult[], stdout: string): TestResult {
  const summary = tests.reduce((counts, test) => {
    counts.total += 1
    if (test.status === 'passed') counts.passed += 1
    if (test.status === 'failed') counts.failed += 1
    if (test.status === 'error') {
      counts.errors += 1
      counts.failed += 1
    }
    if (test.status === 'skipped') counts.skipped += 1
    return counts
  }, { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 })
  return {
    success: false,
    phase: 'cancelled',
    summary,
    tests,
    diagnostics: [{ severity: 'error', message: 'Test run stopped by user.', origin: 'runner' }],
    stdout,
    stderr: 'Test run stopped by user.',
    exitCode: null,
  }
}

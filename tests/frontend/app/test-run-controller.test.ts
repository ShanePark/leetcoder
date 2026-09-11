import { describe, expect, it, vi } from 'vitest'

import type { TestCaseResult, TestResult, TestRunProgress } from '../../../src/backend'
import {
  TEST_RUN_ROOT_KEY,
  TestRunController,
  type TestRunControllerContext,
  type TestRunControllerState,
} from '../../../src/app/test-run-controller'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function result(overrides: Partial<TestResult> = {}): TestResult {
  return {
    success: true,
    phase: 'test',
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
    tests: [],
    diagnostics: [],
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

function testCase(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  return {
    name: 'fails',
    className: 'Q1Test',
    status: 'failed',
    message: 'expected 2 but was 1',
    ...overrides,
  }
}

function harness(options: {
  flushPendingSave?: () => Promise<boolean>
  runResult?: Promise<TestResult>
  saveError?: string | null
} = {}): {
  controller: TestRunController
  state: TestRunControllerState
  context: TestRunControllerContext
  progress: { current: TestRunProgress | null; send: (event: TestRunProgress) => void }
  renderAll: ReturnType<typeof vi.fn>
  renderResult: ReturnType<typeof vi.fn>
  blocked: boolean[]
  messages: Array<{ message: string; tone: string }>
  setIssues: ReturnType<typeof vi.fn>
} {
  const state: TestRunControllerState = {
    repoPath: '/repo',
    selectedPath: 'src/Q1.java',
    selectedSource: 'class Q1 {}',
    selectedFqcn: 'shane.leetcode.Q1',
    saveError: options.saveError ?? null,
    busy: false,
    testResult: null,
    testRun: null,
    selectedTestKey: null,
  }
  const progress = {
    current: null as TestRunProgress | null,
    send: (event: TestRunProgress): void => {
      progress.current = event
      progressHandler?.(event)
    },
  }
  let progressHandler: ((event: TestRunProgress) => void) | undefined
  const renderAll = vi.fn()
  const renderResult = vi.fn()
  const blocked: boolean[] = []
  const messages: Array<{ message: string; tone: string }> = []
  const setIssues = vi.fn()
  const context: TestRunControllerContext = {
    state,
    runProblemTest: vi.fn((_repoPath, _fqcn, onProgress) => {
      progressHandler = onProgress
      return options.runResult ?? Promise.resolve(result())
    }),
    flushPendingSave: options.flushPendingSave ?? (() => Promise.resolve(true)),
    setEditorIssues: setIssues,
    setLiveDiagnosticsBlocked: (value) => blocked.push(value),
    cancelLiveDiagnostics: vi.fn(),
    clearLiveDiagnosticsError: vi.fn(),
    selectTestsTab: vi.fn(),
    renderAll,
    renderResult,
    setMessage: (message, tone) => messages.push({ message, tone }),
  }
  const controller = new TestRunController(context)
  return { controller, state, context, progress, renderAll, renderResult, blocked, messages, setIssues }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TestRunController', () => {
  it('streams progress into one live run and reports the final result', async () => {
    const run = deferred<TestResult>()
    const { controller, state, context, progress, renderAll, renderResult, blocked, setIssues } = harness({
      runResult: run.promise,
    })

    const operation = controller.runCurrentTest('fails')
    await flushMicrotasks()

    expect(context.runProblemTest).toHaveBeenCalledWith(
      '/repo',
      'shane.leetcode.Q1',
      expect.any(Function),
      'fails',
    )
    expect(state.busy).toBe(true)
    expect(state.testRun?.status).toBe('running')
    expect(blocked).toEqual([true])
    expect(renderAll).toHaveBeenCalledTimes(1)

    progress.send({ kind: 'phase', phase: 'test' })
    progress.send({ kind: 'log', stream: 'stdout', text: 'hello\n' })
    progress.send({ kind: 'testStarted', test: testCase({ status: 'running' }) })
    progress.send({ kind: 'testFinished', test: testCase() })
    await flushMicrotasks()

    expect(state.testRun?.phase).toBe('test')
    expect(state.testRun?.stdout).toBe('hello\n')
    expect(state.testRun?.tests).toEqual([testCase()])
    expect(state.selectedTestKey).toBe('Q1Test:fails')
    expect(renderResult).toHaveBeenCalledTimes(1)

    run.resolve(result({
      success: false,
      tests: [testCase({ file: 'src/Q1.java', line: 3 })],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0 },
    }))
    await operation

    expect(state.busy).toBe(false)
    expect(state.testRun?.status).toBe('completed')
    expect(state.testResult?.success).toBe(false)
    expect(setIssues).toHaveBeenLastCalledWith([
      expect.objectContaining({ file: 'src/Q1.java', line: expect.any(Number) }),
    ])
    expect(blocked).toEqual([true, false])
    expect(renderAll).toHaveBeenCalledTimes(2)
  })

  it('rejects delayed progress and results after the source changes', async () => {
    const run = deferred<TestResult>()
    const { controller, state, context, progress, renderResult, messages, blocked } = harness({ runResult: run.promise })
    const operation = controller.runCurrentTest()
    await flushMicrotasks()

    progress.send({ kind: 'log', stream: 'stdout', text: 'stale\n' })
    state.selectedSource = 'class Q1 { edited(); }'
    await flushMicrotasks()

    expect(state.testRun).toBeNull()
    expect(state.testResult).toBeNull()
    expect(state.busy).toBe(true)
    expect(renderResult).not.toHaveBeenCalled()
    expect(messages).toEqual([{ message: 'Run cancelled — file changed', tone: 'info' }])

    const secondRun = controller.runCurrentTest()
    await secondRun
    expect(context.runProblemTest).toHaveBeenCalledTimes(1)
    expect(blocked).toEqual([true])

    run.reject(new Error('late runner failure'))
    await operation
    expect(state.busy).toBe(false)
    expect(blocked).toEqual([true, false])
    expect(state.testResult).toBeNull()
    expect(renderResult).not.toHaveBeenCalled()
    expect(controller.resultSource).toBeNull()
  })

  it('reset invalidates an in-flight run without allowing its completion to repaint state', async () => {
    const run = deferred<TestResult>()
    const { controller, state, context, renderAll, renderResult, blocked } = harness({ runResult: run.promise })
    const operation = controller.runCurrentTest()
    await flushMicrotasks()

    controller.resetTestState()
    expect(state.testRun).toBeNull()
    expect(state.testResult).toBeNull()
    expect(state.selectedTestKey).toBeNull()
    expect(state.busy).toBe(true)
    expect(blocked).toEqual([true])
    expect(context.cancelLiveDiagnostics).toHaveBeenCalledTimes(1)
    expect(context.clearLiveDiagnosticsError).toHaveBeenCalledTimes(1)

    run.resolve(result())
    await operation
    expect(state.busy).toBe(false)
    expect(blocked).toEqual([true, false])
    expect(renderAll).toHaveBeenCalledTimes(2)
    expect(renderResult).not.toHaveBeenCalled()
  })

  it('keeps the native lock after direct cancellation until a rejected run settles', async () => {
    const run = deferred<TestResult>()
    const { controller, state, context, renderAll, renderResult, blocked, messages } = harness({ runResult: run.promise })
    const operation = controller.runCurrentTest()
    await flushMicrotasks()

    controller.cancelCurrentRun()
    expect(state.testRun).toBeNull()
    expect(state.busy).toBe(true)
    expect(blocked).toEqual([true])
    expect(messages).toEqual([{ message: 'Run cancelled — file changed', tone: 'info' }])

    const secondRun = controller.runCurrentTest()
    await secondRun
    expect(context.runProblemTest).toHaveBeenCalledTimes(1)
    expect(state.busy).toBe(true)

    run.reject(new Error('late runner failure'))
    await operation
    expect(state.testResult).toBeNull()
    expect(state.busy).toBe(false)
    expect(blocked).toEqual([true, false])
    expect(renderAll).toHaveBeenCalledTimes(2)
    expect(renderResult).not.toHaveBeenCalled()
  })

  it('disposes safely while the native runner is delayed', async () => {
    const run = deferred<TestResult>()
    const { controller, state, renderAll, renderResult, blocked, setIssues } = harness({ runResult: run.promise })
    const operation = controller.runCurrentTest()
    await flushMicrotasks()

    controller.dispose()
    run.resolve(result({ tests: [testCase({ status: 'passed' })] }))
    await operation

    expect(state.busy).toBe(false)
    expect(renderAll).toHaveBeenCalledTimes(1)
    expect(renderResult).not.toHaveBeenCalled()
    expect(blocked).toEqual([true, false])
    expect(setIssues).toHaveBeenCalledTimes(1)
    expect(controller.resultSource).toBeNull()
  })

  it('does not clear busy state owned by another app operation when idle', () => {
    const { controller, state } = harness()
    state.busy = true

    controller.resetTestState()
    controller.dispose()

    expect(state.busy).toBe(true)
  })

  it('turns a failed save into a runner result without starting the backend', async () => {
    const { controller, state, context, renderAll, blocked } = harness({
      flushPendingSave: () => Promise.resolve(false),
      saveError: 'disk is read-only',
    })

    await controller.runCurrentTest()

    expect(context.runProblemTest).not.toHaveBeenCalled()
    expect(state.testResult?.phase).toBe('runner')
    expect(state.testResult?.diagnostics[0]?.message).toContain('disk is read-only')
    expect(state.testRun?.status).toBe('error')
    expect(state.busy).toBe(false)
    expect(blocked).toEqual([true, false])
    expect(renderAll).toHaveBeenCalledTimes(2)
  })

  it('keeps an explicit row or root selection ahead of automatic failure selection', async () => {
    const run = deferred<TestResult>()
    const { controller, state, progress } = harness({ runResult: run.promise })
    const operation = controller.runCurrentTest()
    await flushMicrotasks()

    controller.selectTestResult(TEST_RUN_ROOT_KEY)
    progress.send({ kind: 'testFinished', test: testCase() })
    expect(state.selectedTestKey).toBeNull()

    run.resolve(result({ success: false, tests: [testCase()] }))
    await operation
    expect(state.selectedTestKey).toBeNull()
  })
})

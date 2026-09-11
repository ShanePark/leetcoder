import type { TestCaseResult, TestPhase, TestResult, TestRunProgress } from '../backend'
import { errorMessage } from '../backend'
import type { EditorIssue } from '../editor'
import {
  autoSelectedTestKey,
  collectEditorIssues,
  isTestRunSourceCurrent,
  liveSnapshotResult,
  runnerFailureResult,
  sameTest,
  testFailureMessage,
  testResultBannerMessage,
} from './test-results'
import type {
  CurrentTestSource,
  AppState,
  TestRunSnapshot,
  TestRunSourceSnapshot,
  TestRunnerBackend,
} from './types'

/** The stable key used by the test result tree for its aggregate row. */
export const TEST_RUN_ROOT_KEY = '__leetcoder_test_run__'

/** The part of app state owned by the test-run lifecycle. */
export type TestRunControllerState = Pick<
  AppState,
  | 'repoPath'
  | 'selectedPath'
  | 'selectedSource'
  | 'selectedFqcn'
  | 'saveError'
  | 'busy'
  | 'testResult'
  | 'testRun'
  | 'selectedTestKey'
>

export type TestRunMessageTone = 'info' | 'success' | 'error'

/** Callbacks needed to connect the controller to the app shell. */
export interface TestRunControllerContext {
  state: TestRunControllerState
  runProblemTest: TestRunnerBackend['runProblemTest']
  flushPendingSave: () => Promise<boolean>
  setEditorIssues: (issues: readonly EditorIssue[]) => void
  setLiveDiagnosticsBlocked: (blocked: boolean) => void
  cancelLiveDiagnostics?: () => void
  clearLiveDiagnosticsError?: () => void
  selectTestsTab: () => void
  renderAll: () => void
  renderResult: () => void
  setMessage: (message: string, tone: TestRunMessageTone) => void
  /** Called after a view render when its selected row was normalized or removed. */
  focusTestResult?: (key: string) => void
  /** Lets an app that has its own destruction flag reject late callbacks immediately. */
  isDestroyed?: () => boolean
}

/**
 * Owns one test process at a time and applies only results for its source
 * snapshot. The native process cannot be cancelled reliably, so generation
 * checks and source checks are the cancellation mechanism for its callbacks.
 */
export class TestRunController {
  private readonly context: TestRunControllerContext
  private testRunGeneration = 0
  private runningRunId: number | null = null
  private testSelectionExplicit = false
  private testResultSource: TestRunSourceSnapshot | null = null
  private liveRenderFrame: number | null = null
  private liveRenderToken = 0
  private disposed = false

  constructor(context: TestRunControllerContext) {
    this.context = context
  }

  /** Source associated with the most recent accepted result. */
  get resultSource(): TestRunSourceSnapshot | null {
    return this.testResultSource
  }

  /** Whether a user explicitly selected the root row or a particular test. */
  get selectionExplicit(): boolean {
    return this.testSelectionExplicit
  }

  /** Whether a source snapshot still describes the app's current document. */
  isResultSourceCurrent(snapshot: TestRunSourceSnapshot): boolean {
    return isTestRunSourceCurrent(snapshot, this.currentSource())
  }

  /** Start a complete or method-scoped test run. */
  async runCurrentTest(testMethod?: string): Promise<void> {
    if (!this.isAlive() || this.context.state.busy || this.runningRunId !== null) {
      return
    }
    const { state } = this.context
    if (!state.repoPath || !state.selectedPath || !state.selectedFqcn) {
      this.context.setMessage('Select a Java problem file to run', 'info')
      return
    }

    const runSnapshot: TestRunSourceSnapshot = {
      repoPath: state.repoPath,
      filePath: state.selectedPath,
      source: state.selectedSource,
    }
    const runFqcn = state.selectedFqcn
    const runId = ++this.testRunGeneration
    this.cancelScheduledLiveRender()
    const run: TestRunSnapshot = {
      id: runId,
      status: 'running',
      phase: 'starting',
      startedAt: Date.now(),
      tests: [],
      stdout: '',
      stderr: '',
      activeTest: null,
      error: null,
      testMethod: testMethod ?? null,
    }
    this.runningRunId = runId
    state.busy = true
    state.testRun = run
    state.testResult = null
    this.testResultSource = null
    state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.context.setLiveDiagnosticsBlocked(true)
    this.context.setEditorIssues([])
    // A starting run always brings the Tests tab forward so progress is visible.
    this.context.selectTestsTab()
    this.context.renderAll()

    try {
      if (!(await this.context.flushPendingSave())) {
        if (this.isAcceptingTestRun(runId)) {
          if (!this.isResultSourceCurrent(runSnapshot)) {
            this.discardStaleTestRun(runId)
            return
          }
          const failure = runnerFailureResult(
            run,
            state.saveError
              ?? 'The source file could not be saved before running tests.',
          )
          this.completeError(runSnapshot, run, failure)
        }
        return
      }

      const onProgress = (progress: TestRunProgress): void => {
        this.applyTestRunProgress(runId, runSnapshot, progress)
      }
      const result = testMethod === undefined
        ? await this.context.runProblemTest(runSnapshot.repoPath, runFqcn, onProgress)
        : await this.context.runProblemTest(runSnapshot.repoPath, runFqcn, onProgress, testMethod)
      if (!this.isAcceptingTestRun(runId)) {
        return
      }
      if (!this.isResultSourceCurrent(runSnapshot)) {
        this.discardStaleTestRun(runId)
        return
      }
      this.completeResult(runSnapshot, run, result)
    } catch (error) {
      if (!this.isAcceptingTestRun(runId)) {
        return
      }
      if (!this.isResultSourceCurrent(runSnapshot)) {
        this.discardStaleTestRun(runId)
        return
      }
      this.completeError(runSnapshot, run, runnerFailureResult(run, errorMessage(error)))
    } finally {
      // A stale run cannot update visible results, but its native process still
      // owns the busy state and diagnostics block until this promise settles.
      // The run identity prevents it from releasing a newer operation.
      if (this.isInFlightRun(runId)) {
        this.runningRunId = null
        this.context.setLiveDiagnosticsBlocked(false)
        this.context.state.busy = false
        this.context.renderAll()
      }
    }
  }

  /** Clear test output and invalidate queued, live, and in-flight callbacks. */
  resetTestState(): void {
    if (this.disposed) {
      return
    }
    const hadRunningRun = this.runningRunId !== null
    this.testRunGeneration += 1
    this.cancelScheduledLiveRender()
    this.context.state.testResult = null
    this.context.state.testRun = null
    this.context.state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.testResultSource = null
    this.context.setEditorIssues([])
    this.context.cancelLiveDiagnostics?.()
    this.context.clearLiveDiagnosticsError?.()
    if (!hadRunningRun) {
      this.context.setLiveDiagnosticsBlocked(false)
    }
  }

  /** Invalidate the active run after the editor source has changed. */
  cancelCurrentRun(): void {
    if (this.runningRunId !== null) {
      this.discardStaleTestRun(this.runningRunId)
    }
  }

  /** Apply a row selection from the test results view. */
  selectTestResult(key: string, focus = false): void {
    if (!this.isAlive()) {
      return
    }
    const nextKey = key === TEST_RUN_ROOT_KEY ? null : key
    this.testSelectionExplicit = true
    if (this.context.state.selectedTestKey === nextKey) {
      return
    }
    this.context.state.selectedTestKey = nextKey
    this.context.renderResult()
    if (focus) {
      this.context.focusTestResult?.(key)
    }
  }

  /**
   * Let the view report a selection it normalized during rendering. A changed
   * value is an automatic view choice, so it must not block later failure
   * selection.
   */
  acceptRenderedSelection(selectedTestKey: string | null): void {
    if (this.disposed || this.context.state.selectedTestKey === selectedTestKey) {
      return
    }
    this.context.state.selectedTestKey = selectedTestKey
    this.testSelectionExplicit = false
  }

  /** Stop applying all callbacks from the native process and pending frame. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    const hadRunningRun = this.runningRunId !== null
    this.disposed = true
    this.testRunGeneration += 1
    this.runningRunId = null
    this.testResultSource = null
    this.cancelScheduledLiveRender()
    this.context.setLiveDiagnosticsBlocked(false)
    if (hadRunningRun) {
      this.context.state.busy = false
    }
  }

  private completeResult(
    source: TestRunSourceSnapshot,
    run: TestRunSnapshot,
    result: TestResult,
  ): void {
    const { state } = this.context
    state.testResult = result
    this.testResultSource = source
    this.autoSelectFailedTest(result)
    this.context.setEditorIssues(collectEditorIssues(result, source.filePath))
    run.status = 'completed'
    run.phase = result.phase
    run.tests = result.tests
    run.stdout = result.stdout
    run.stderr = result.stderr
    run.activeTest = null
    run.error = result.success ? null : testFailureMessage(result)
    if (result.success) {
      // Failures never toast: the Tests panel is already front and center.
      this.context.setMessage(testResultBannerMessage(result), 'success')
    }
  }

  private completeError(
    source: TestRunSourceSnapshot,
    run: TestRunSnapshot,
    failure: TestResult,
  ): void {
    run.status = 'error'
    run.phase = failure.phase
    run.error = testFailureMessage(failure)
    run.activeTest = null
    this.context.state.testResult = failure
    this.testResultSource = source
    this.autoSelectFailedTest(failure)
  }

  /** The native process is still running, even after its result is invalidated. */
  private isInFlightRun(runId: number): boolean {
    return this.isAlive() && this.runningRunId === runId
  }

  /** Whether callbacks from this run may still update visible test state. */
  private isAcceptingTestRun(runId: number): boolean {
    return this.isInFlightRun(runId)
      && this.context.state.testRun?.id === runId
      && this.testRunGeneration === runId
  }

  private discardStaleTestRun(
    runId: number,
    message = 'Run cancelled — file changed',
  ): void {
    if (!this.isInFlightRun(runId)) {
      return
    }
    this.testRunGeneration += 1
    this.cancelScheduledLiveRender()
    this.context.state.testRun = null
    this.context.state.testResult = null
    this.testResultSource = null
    this.context.state.selectedTestKey = null
    this.testSelectionExplicit = false
    this.context.setEditorIssues([])
    this.context.setMessage(message, 'info')
  }

  private applyTestRunProgress(
    runId: number,
    source: TestRunSourceSnapshot,
    progress: TestRunProgress,
  ): void {
    if (!this.isAcceptingTestRun(runId)) {
      return
    }
    if (!this.isResultSourceCurrent(source)) {
      this.discardStaleTestRun(runId)
      return
    }
    const run = this.context.state.testRun
    if (!run || run.status !== 'running') {
      return
    }
    switch (progress.kind) {
      case 'started':
        run.phase = 'starting'
        break
      case 'phase':
        run.phase = progress.phase
        break
      case 'log':
        run[progress.stream] += progress.text
        break
      case 'testStarted':
        run.activeTest = progress.test
        this.upsertLiveTest(run, { ...progress.test, status: 'running' })
        break
      case 'testFinished':
        this.upsertLiveTest(run, progress.test)
        if (progress.test.status === 'failed' || progress.test.status === 'error') {
          this.autoSelectFailedTest(liveSnapshotResult(run))
        }
        if (sameTest(run.activeTest, progress.test)) {
          run.activeTest = null
        }
        break
    }
    this.scheduleLiveResultRender(runId, source)
  }

  private upsertLiveTest(run: TestRunSnapshot, test: TestCaseResult): void {
    const index = run.tests.findIndex((entry) => sameTest(entry, test))
    if (index < 0) {
      run.tests.push(test)
      return
    }
    run.tests[index] = { ...run.tests[index], ...test }
  }

  private autoSelectFailedTest(result: TestResult): void {
    this.context.state.selectedTestKey = autoSelectedTestKey(
      result.tests,
      this.context.state.selectedTestKey,
      this.testSelectionExplicit,
    )
  }

  private currentSource(): CurrentTestSource {
    const { state } = this.context
    return {
      repoPath: state.repoPath,
      filePath: state.selectedPath,
      source: state.selectedSource,
    }
  }

  private isAlive(): boolean {
    return !this.disposed && !this.context.isDestroyed?.()
  }

  private scheduleLiveResultRender(runId: number, source: TestRunSourceSnapshot): void {
    if (!this.isAlive() || this.liveRenderFrame !== null) {
      return
    }
    const token = ++this.liveRenderToken
    const flush = (): void => {
      if (token !== this.liveRenderToken) {
        return
      }
      this.liveRenderFrame = null
      if (!this.isAlive() || !this.isAcceptingTestRun(runId)) {
        return
      }
      if (!this.isResultSourceCurrent(source)) {
        this.discardStaleTestRun(runId)
        return
      }
      this.context.renderResult()
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      this.liveRenderFrame = window.requestAnimationFrame(flush)
    } else {
      // Keep coalescing in test and other non-visual environments.
      this.liveRenderFrame = -1
      queueMicrotask(() => {
        if (this.liveRenderFrame === -1) {
          flush()
        }
      })
    }
  }

  private cancelScheduledLiveRender(): void {
    this.liveRenderToken += 1
    if (
      this.liveRenderFrame !== null
      && this.liveRenderFrame !== -1
      && typeof window !== 'undefined'
      && typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(this.liveRenderFrame)
    }
    this.liveRenderFrame = null
  }
}

export type { CurrentTestSource, TestRunSnapshot, TestRunSourceSnapshot, TestPhase }

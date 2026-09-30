import { errorMessage, type BackendClient, type ProblemDiagnostic } from '../backend'
import { LiveDiagnosticsScheduler, type LiveDiagnosticsSnapshot } from '../live-diagnostics'
import type { JavaEditor } from '../editor'
import type { AppState, LiveDiagnosticsBackend } from './types'
import type { TestRunController } from './test-run-controller'
import { collectEditorIssues, collectDiagnosticEditorIssues } from './test-results'

interface LiveDiagnosticsControllerOptions {
  state: AppState
  backend: BackendClient
  testRun: () => Pick<TestRunController, 'resultSource' | 'isResultSourceCurrent'>
  setEditorIssues: JavaEditor['setIssues']
  renderResult: () => void
  isActive: () => boolean
}

/** Apply diagnostics only to the current document and preserve current test issues. */
export class LiveDiagnosticsController {
  private readonly state: AppState
  private readonly backend: BackendClient
  private readonly scheduler: LiveDiagnosticsScheduler

  constructor(private readonly options: LiveDiagnosticsControllerOptions) {
    this.state = options.state
    this.backend = options.backend
    this.scheduler = new LiveDiagnosticsScheduler({
      check: (snapshot) => this.checkLiveDiagnostics(snapshot),
      onResult: (snapshot, diagnostics) => this.applyLiveDiagnostics(snapshot, diagnostics),
      onError: (snapshot, error) => this.handleLiveDiagnosticsError(snapshot, error),
    })
  }

  cancel(): void {
    this.scheduler.cancel()
  }

  setBlocked(blocked: boolean): void {
    this.scheduler.setBlocked(blocked)
  }

  dispose(): void {
    this.scheduler.dispose()
  }

  private liveDiagnosticsSnapshot(): LiveDiagnosticsSnapshot | null {
    if (!this.state.repoPath || !this.state.projectValid
      || !this.state.selectedPath || !this.state.selectedFqcn) {
      return null
    }
    return {
      repoPath: this.state.repoPath,
      relativePath: this.state.selectedPath,
      fullyQualifiedClassName: this.state.selectedFqcn,
      source: this.state.selectedSource,
    }
  }

  scheduleLiveDiagnostics(): void {
    const snapshot = this.liveDiagnosticsSnapshot()
    if (!snapshot) {
      this.scheduler.cancel()
      this.state.liveDiagnosticsError = null
      return
    }
    const hadError = Boolean(this.state.liveDiagnosticsError)
    this.state.liveDiagnosticsError = null
    this.scheduler.schedule(snapshot)
    if (hadError) {
      this.options.renderResult()
    }
  }

  private checkLiveDiagnostics(snapshot: LiveDiagnosticsSnapshot): Promise<readonly ProblemDiagnostic[]> {
    const method = (this.backend as unknown as LiveDiagnosticsBackend).checkProblemDiagnostics
    if (!method) {
      return Promise.reject(new Error('Live diagnostics are not available in this build.'))
    }
    return method(snapshot.repoPath, snapshot.fullyQualifiedClassName, snapshot.source)
  }

  private isCurrentLiveDiagnosticsSnapshot(snapshot: LiveDiagnosticsSnapshot): boolean {
    return snapshot.repoPath === this.state.repoPath
      && snapshot.relativePath === this.state.selectedPath
      && snapshot.fullyQualifiedClassName === this.state.selectedFqcn
      && snapshot.source === this.state.selectedSource
  }

  private applyLiveDiagnostics(
    snapshot: LiveDiagnosticsSnapshot,
    diagnostics: readonly ProblemDiagnostic[],
  ): void {
    if (!this.options.isActive() || !this.isCurrentLiveDiagnosticsSnapshot(snapshot)) {
      return
    }
    this.state.liveDiagnosticsError = null
    const testResultSource = this.options.testRun().resultSource
    const testIssues = testResultSource && this.state.testResult
      && this.options.testRun().isResultSourceCurrent(testResultSource)
      ? collectEditorIssues(this.state.testResult, snapshot.relativePath)
      : []
    this.options.setEditorIssues(
      [...testIssues, ...collectDiagnosticEditorIssues(diagnostics, snapshot.relativePath)],
      { reveal: false },
    )
    this.options.renderResult()
  }

  private handleLiveDiagnosticsError(snapshot: LiveDiagnosticsSnapshot, error: unknown): void {
    if (!this.options.isActive() || !this.isCurrentLiveDiagnosticsSnapshot(snapshot)) {
      return
    }
    // Keep this in the quiet status row rather than a toast: a compiler
    // service failure should be visible without interrupting typing.
    this.state.liveDiagnosticsError = errorMessage(error)
    this.options.renderResult()
  }
}

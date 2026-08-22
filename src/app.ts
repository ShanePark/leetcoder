import { open } from '@tauri-apps/plugin-dialog'

import {
  createBackendClient,
  errorMessage,
  type BackendClient,
  type DailyProblem,
  type ProblemFileEntry,
  type TestResult,
  type TestCaseResult,
  type TestDiagnostic,
  type TestPhase,
  type TestRunProgress,
} from './backend'
import { JavaEditor } from './editor'
import { iconFor } from './icons'
import { createProblemWithRetry } from './problem-generator'

const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'
const FILE_GROUPS: Array<{ key: ProblemFileEntry['packageSegment']; label: string }> = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'xhard', label: 'Hard' },
]

export type DirectoryPicker = () => Promise<string | null>

export interface AppOptions {
  backend?: BackendClient
  directoryPicker?: DirectoryPicker
  storage?: Storage
}

export interface AutosaveSnapshot {
  repoPath: string
  filePath: string
  source: string
}

export type AutosaveStatus = 'idle' | 'saving' | 'error'

export interface AutosaveCoordinatorOptions {
  delayMs?: number
  onStatusChange?: (status: AutosaveStatus) => void
  onError?: (error: unknown) => void
}

export interface TestResultPresentation {
  phaseLabel: string
  statusLabel: string
  failureMessage: string | null
  rawLogsOpen: boolean
}

export type TestRunStatus = 'running' | 'completed' | 'error'

export interface TestRunSnapshot {
  id: number
  status: TestRunStatus
  phase: TestPhase
  startedAt: number
  tests: TestCaseResult[]
  stdout: string
  stderr: string
  activeTest: TestCaseResult | null
  error: string | null
}

/**
 * Turns a structured run result into the short, actionable copy used above
 * the detailed test rows. The full process output remains available below.
 */
export function presentTestResult(result: TestResult): TestResultPresentation {
  const phaseLabel = testPhaseLabel(result.phase)
  const failureMessage = result.success ? null : testFailureMessage(result)
  return {
    phaseLabel,
    statusLabel: result.success
      ? 'Passed'
      : result.summary.errors > 0
        ? `Error · ${phaseLabel}`
        : `Failed · ${phaseLabel}`,
    failureMessage,
    rawLogsOpen: !result.success,
  }
}

export function testResultBannerMessage(result: TestResult): string {
  if (result.success) {
    return 'Test passed.'
  }
  const reason = testFailureMessage(result)
  const phase = normalizeTestPhase(result.phase)
  if (phase === 'compile') {
    return `Compilation failed: ${reason}`
  }
  if (phase === 'runner') {
    return `Test runner failed: ${reason}`
  }
  if (phase === 'noTests') {
    return `No tests found: ${reason}`
  }
  if (phase === 'test') {
    return `Tests failed: ${reason}`
  }
  return `Test failed: ${reason}`
}

function testPhaseLabel(phase: TestPhase): string {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (normalized === 'starting') {
    return 'Starting'
  }
  if (normalized === 'finishing') {
    return 'Finishing'
  }
  switch (normalizeTestPhase(phase)) {
    case 'compile':
      return 'Compilation'
    case 'runner':
      return 'Test runner'
    case 'noTests':
      return 'No tests'
    case 'test':
      return 'Tests'
    default:
      return phase.trim() || 'Test run'
  }
}

function normalizeTestPhase(phase: TestPhase): 'compile' | 'runner' | 'noTests' | 'test' | 'unknown' {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (normalized === 'compile' || normalized === 'compilation') {
    return 'compile'
  }
  if (normalized === 'runner' || normalized === 'run' || normalized === 'execution') {
    return 'runner'
  }
  if (normalized === 'notest' || normalized === 'notests') {
    return 'noTests'
  }
  if (normalized === 'test' || normalized === 'tests') {
    return 'test'
  }
  if (normalized === 'compiling') {
    return 'compile'
  }
  if (normalized === 'runningtests') {
    return 'test'
  }
  return 'unknown'
}

export function testFailureMessage(result: TestResult): string {
  const phase = normalizeTestPhase(result.phase)
  const diagnostic = result.diagnostics.find(
    (entry) => entry.message.trim().length > 0 && entry.severity.trim().toLowerCase() === 'error',
  ) ?? result.diagnostics.find((entry) => entry.message.trim().length > 0)
  const failedTest = result.tests.find(
    (test) => (test.status === 'failed' || test.status === 'error') && test.message?.trim().length,
  )
  if (phase === 'compile' && diagnostic) {
    return shortenResultMessage(diagnostic.message)
  }
  if (phase === 'test' && failedTest?.message) {
    return shortenResultMessage(failedTest.message)
  }
  const stderr = firstUsefulOutputLine(result.stderr)
  if (stderr) {
    return shortenResultMessage(stderr)
  }
  const stdout = firstUsefulOutputLine(result.stdout)
  if (stdout) {
    return shortenResultMessage(stdout)
  }
  if (diagnostic) {
    return shortenResultMessage(diagnostic.message)
  }
  if (phase === 'compile') {
    return 'The Java source could not be compiled.'
  }
  if (phase === 'runner') {
    return 'The test runner stopped before reporting any tests.'
  }
  if (phase === 'noTests') {
    return 'The test task completed without reporting any tests.'
  }
  return 'The test run stopped before reporting a result.'
}

function firstUsefulOutputLine(output: string): string | null {
  const lines = output
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return null
  }
  const useful = lines.find((line) => !/^> task .* (executed|failed)$/i.test(line))
  return useful ?? lines[0]
}

function shortenResultMessage(message: string, limit = 220): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

export function summarizeLiveTests(
  tests: TestCaseResult[],
  durationMs: number | null = null,
): TestResult['summary'] {
  return tests.reduce((summary, test) => {
    summary.total += 1
    if (test.status === 'passed') summary.passed += 1
    if (test.status === 'failed' || test.status === 'error') summary.failed += 1
    if (test.status === 'error') summary.errors += 1
    if (test.status === 'skipped') summary.skipped += 1
    return summary
  }, {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    durationMs,
  })
}

export function liveSnapshotResult(run: TestRunSnapshot, now = Date.now()): TestResult {
  return {
    success: false,
    phase: run.phase,
    summary: summarizeLiveTests(run.tests, Math.max(0, now - run.startedAt)),
    tests: run.tests,
    diagnostics: [],
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: null,
  }
}

export function runnerFailureResult(
  run: TestRunSnapshot,
  message: string,
): TestResult {
  const detail = message.trim() || 'The test runner stopped unexpectedly.'
  const tests = run.tests.map((test) => test.status === 'running'
    ? { ...test, status: 'error', message: test.message ?? detail }
    : test)
  return {
    success: false,
    phase: 'runner',
    summary: summarizeLiveTests(tests, Math.max(0, Date.now() - run.startedAt)),
    tests,
    diagnostics: [{ severity: 'error', message: detail }],
    stdout: run.stdout,
    stderr: run.stderr || detail,
    exitCode: null,
  }
}

function sameTest(left: TestCaseResult | null, right: TestCaseResult): boolean {
  if (!left) {
    return false
  }
  return left.name === right.name && (left.className ?? '') === (right.className ?? '')
}

/**
 * Coalesces editor changes into one debounced write and follows an in-flight
 * write with the newest snapshot when the document changes while saving.
 */
export class AutosaveCoordinator {
  private readonly save: (snapshot: AutosaveSnapshot) => Promise<void>
  private readonly delayMs: number
  private readonly onStatusChange?: (status: AutosaveStatus) => void
  private readonly onError?: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: AutosaveSnapshot | null = null
  private running: Promise<void> | null = null
  private currentStatus: AutosaveStatus = 'idle'
  private disposed = false

  constructor(
    save: (snapshot: AutosaveSnapshot) => Promise<void>,
    options: AutosaveCoordinatorOptions = {},
  ) {
    this.save = save
    this.delayMs = options.delayMs ?? 500
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
  }

  get status(): AutosaveStatus {
    return this.currentStatus
  }

  get hasPendingChanges(): boolean {
    return this.pending !== null || this.running !== null
  }

  schedule(snapshot: AutosaveSnapshot): void {
    if (this.disposed) {
      return
    }
    this.pending = snapshot
    this.clearTimer()
    this.setStatus('saving')
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch((error) => this.onError?.(error))
    }, this.delayMs)
  }

  async flush(): Promise<void> {
    this.clearTimer()
    if (!this.pending && !this.running) {
      return
    }
    await (this.running ?? this.startRun())
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private startRun(): Promise<void> {
    const run = this.persistPending()
    this.running = run
    void run.then(
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
      () => {
        if (this.running === run) {
          this.running = null
        }
      },
    )
    return run
  }

  private async persistPending(): Promise<void> {
    while (this.pending) {
      const snapshot = this.pending
      this.pending = null
      this.setStatus('saving')
      try {
        await this.save(snapshot)
      } catch (error) {
        // Keep the failed snapshot available for an explicit retry. If a
        // newer edit already arrived, that newer snapshot is sufficient.
        this.pending ??= snapshot
        this.setStatus('error')
        throw error
      }
    }
    this.setStatus('idle')
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setStatus(status: AutosaveStatus): void {
    this.currentStatus = status
    this.onStatusChange?.(status)
  }
}

export function filterProblemFiles(files: ProblemFileEntry[], query: string): ProblemFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return files
  }
  return files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
}

export function filterProblemFilesByGroup(
  files: ProblemFileEntry[],
  group: ProblemFileEntry['packageSegment'],
  query: string,
): ProblemFileEntry[] {
  return filterProblemFiles(files, query).filter((file) => file.packageSegment === group)
}

export interface RepositoryRefreshRequest {
  repoPath: string
  repositoryGeneration: number
  requestId: number
}

export interface RepositoryRefreshState {
  repoPath: string | null
  projectValid: boolean
  repositoryGeneration: number
  refreshRequestId: number
}

export function isCurrentRepositoryRefresh(
  request: RepositoryRefreshRequest,
  state: RepositoryRefreshState,
): boolean {
  return state.projectValid
    && state.repoPath === request.repoPath
    && state.repositoryGeneration === request.repositoryGeneration
    && state.refreshRequestId === request.requestId
}

interface AppState {
  repoPath: string | null
  projectValid: boolean
  files: ProblemFileEntry[]
  selectedPath: string | null
  selectedSource: string
  savedSource: string
  selectedFqcn: string | null
  dirty: boolean
  dailyProblem: DailyProblem | null
  dailyError: string | null
  testResult: TestResult | null
  testRun: TestRunSnapshot | null
  busy: boolean
  fileSearch: string
  saveError: string | null
}

/** The desktop application's single-window state and DOM orchestration. */
export class LeetcoderApp {
  private readonly root: HTMLElement
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly storage: Storage | undefined
  private readonly state: AppState = {
    repoPath: null,
    projectValid: false,
    files: [],
    selectedPath: null,
    selectedSource: '',
    savedSource: '',
    selectedFqcn: null,
    dirty: false,
    dailyProblem: null,
    dailyError: null,
    testResult: null,
    testRun: null,
    busy: false,
    fileSearch: '',
    saveError: null,
  }
  private editor: JavaEditor
  private readonly autosave: AutosaveCoordinator
  private suppressEditorChange = false
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private testRunGeneration = 0
  private closePreparation: Promise<void> | null = null
  private destroyed = false
  private renderedTestResult: TestResult | null = null
  private liveRenderFrame: number | null = null
  private liveRenderToken = 0
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    FILE_GROUPS.map((group) => group.key),
  )
  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) {
      return
    }
    // CodeMirror owns shortcuts while the editor has focus. Handling them
    // again on window would run/save the same document twice.
    if (event.target instanceof Node && this.element('#editor').contains(event.target)) {
      return
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void this.saveCurrentFile()
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault()
      void this.runCurrentTest()
    }
  }

  constructor(root: HTMLElement, options: AppOptions = {}) {
    this.root = root
    this.backend = options.backend ?? createBackendClient()
    this.directoryPicker = options.directoryPicker ?? defaultDirectoryPicker
    this.storage = options.storage ?? safeStorage()
    this.renderShell()
    this.autosave = new AutosaveCoordinator(
      (snapshot) => this.persistSnapshot(snapshot),
      {
        onStatusChange: () => {
          if (this.root.querySelector('#save-status')) {
            this.renderFileHeading()
          }
        },
        onError: (error) => this.handleSaveError(error),
      },
    )
    this.editor = new JavaEditor(this.element('#editor'), {
      onChange: (source) => this.onEditorChange(source),
      onSave: () => {
        void this.saveCurrentFile()
        return true
      },
      onRun: () => {
        void this.runCurrentTest()
        return true
      },
    })
    this.bindEvents()
    this.renderAll()
  }

  async start(): Promise<void> {
    await this.loadDailyProblem()
    const rememberedPath = this.storage?.getItem(LAST_REPOSITORY_KEY) ?? null
    if (rememberedPath) {
      await this.selectRepository(rememberedPath, false)
    } else {
      this.setMessage('Choose a repository to get started.', 'info')
    }
  }

  async prepareToClose(): Promise<void> {
    if (this.closePreparation) {
      return this.closePreparation
    }
    const preparation = (async (): Promise<void> => {
      try {
        await this.autosave.flush()
      } catch (error) {
        this.handleSaveError(error)
        throw error
      }
    })()
    this.closePreparation = preparation
    try {
      await preparation
    } finally {
      if (this.closePreparation === preparation) {
        this.closePreparation = null
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    await this.prepareToClose()
    this.cancelScheduledLiveRender()
    this.editor.destroy()
    this.autosave.dispose()
    window.removeEventListener('keydown', this.handleGlobalKeydown)
    this.destroyed = true
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <h1>leetcoder</h1>
          <div class="repository-toolbar">
            <strong id="repo-path">Choose a repository</strong>
            <button id="choose-repository" class="secondary-button" type="button">Choose</button>
          </div>
        </header>

        <div class="app-status" id="app-status" role="status" aria-live="polite"></div>

        <main class="workspace">
          <aside class="sidebar" aria-label="Problem files">
            <div class="sidebar-heading">
              <h2>Problems</h2>
              <button id="refresh-files" class="icon-button" type="button" aria-label="Refresh problem files" title="Refresh files"></button>
            </div>
            <div class="file-search">
              <label class="sr-only" for="file-search">Search problems</label>
              <div class="file-search-field">
                <span id="file-search-icon" aria-hidden="true"></span>
                <input id="file-search" type="search" placeholder="Search problems" autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div id="file-list" class="file-list"></div>
          </aside>

          <section class="editor-column" aria-label="Code editor">
            <section class="daily-card" aria-label="Today's problem">
              <div id="daily-content" class="daily-content"></div>
              <div class="daily-actions">
                <a id="problem-link" class="problem-link" href="#" target="_blank" rel="noreferrer">Open</a>
                <button id="create-file" class="primary-button" type="button">New file</button>
                <button id="refresh-daily" class="icon-button" type="button" aria-label="Refresh daily problem" title="Refresh daily problem"></button>
              </div>
            </section>

            <section class="code-card">
              <div class="code-toolbar">
                <div class="file-heading">
                  <strong id="selected-file">No file selected</strong>
                  <span id="dirty-indicator" class="dirty-indicator" hidden>Unsaved</span>
                  <span id="save-status" class="save-status" aria-live="polite"></span>
                </div>
                <div class="code-actions">
                  <button id="run-test" class="primary-button" type="button">Run <kbd id="run-shortcut">Ctrl+R</kbd></button>
                </div>
              </div>
              <div class="editor-host" id="editor-host" aria-label="Java source editor">
                <div id="editor" class="editor"></div>
                <div id="editor-empty" class="editor-empty">Choose a file from the left to start coding.</div>
              </div>
            </section>

            <section class="results-card" aria-labelledby="results-heading" aria-busy="false">
              <div class="results-heading-row">
                <div class="results-heading-main">
                  <span id="result-badge" class="result-badge" aria-hidden="true">·</span>
                  <div class="results-heading-copy">
                    <h2 id="results-heading">Tests</h2>
                    <span id="result-phase" class="result-phase">No run yet</span>
                  </div>
                </div>
                <div class="result-status-stack">
                  <span id="result-status" class="result-status" aria-live="polite">No run yet</span>
                  <span id="result-elapsed" class="result-elapsed"></span>
                </div>
              </div>
              <div id="test-summary" class="test-summary" aria-live="polite">Run the current class to see results.</div>
              <div id="failure-panel" class="failure-panel" role="alert" hidden>
                <strong id="failure-panel-title"></strong>
                <p id="failure-panel-message"></p>
              </div>
              <div id="test-list" class="test-list"></div>
              <div id="diagnostics" class="diagnostics"></div>
              <details id="raw-logs" class="raw-logs">
                <summary id="raw-logs-summary">Gradle output</summary>
                <div class="result-columns">
                  <div class="result-pane">
                    <span class="result-label">stdout</span>
                    <pre id="stdout"></pre>
                  </div>
                  <div class="result-pane">
                    <span class="result-label">stderr</span>
                    <pre id="stderr"></pre>
                  </div>
                </div>
              </details>
            </section>
          </section>
        </main>
      </div>
    `
    this.installStaticIcons()
  }

  private installStaticIcons(): void {
    this.element<HTMLButtonElement>('#choose-repository').prepend(iconFor('folderOpen', 'button-icon'))
    this.element<HTMLButtonElement>('#refresh-files').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLElement>('#file-search-icon').append(iconFor('search', 'search-icon'))
    this.element<HTMLAnchorElement>('#problem-link').prepend(iconFor('externalLink', 'button-icon'))
    this.element<HTMLButtonElement>('#create-file').prepend(iconFor('filePlus', 'button-icon'))
    this.element<HTMLButtonElement>('#refresh-daily').append(iconFor('refresh', 'button-icon'))
    this.element<HTMLButtonElement>('#run-test').prepend(iconFor('play', 'button-icon'))
    this.element<HTMLElement>('#raw-logs-summary').prepend(iconFor('terminal', 'button-icon'))
  }

  private bindEvents(): void {
    this.element<HTMLButtonElement>('#choose-repository').addEventListener('click', () => {
      void this.chooseRepository()
    })
    this.element<HTMLButtonElement>('#refresh-files').addEventListener('click', () => {
      void this.refreshFiles()
    })
    this.element<HTMLButtonElement>('#refresh-daily').addEventListener('click', () => {
      void this.loadDailyProblem()
    })
    this.element<HTMLButtonElement>('#create-file').addEventListener('click', () => {
      void this.createFileForToday()
    })
    this.element<HTMLInputElement>('#file-search').addEventListener('input', (event) => {
      this.state.fileSearch = (event.target as HTMLInputElement).value
      this.renderFiles()
    })
    this.element<HTMLInputElement>('#file-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        const input = event.currentTarget as HTMLInputElement
        if (input.value.length > 0 || this.state.fileSearch.length > 0) {
          input.value = ''
          this.state.fileSearch = ''
          this.renderFiles()
        }
      }
    })
    this.element<HTMLButtonElement>('#run-test').addEventListener('click', () => {
      void this.runCurrentTest()
    })
    window.addEventListener('keydown', this.handleGlobalKeydown)
  }

  private async chooseRepository(): Promise<void> {
    if (this.state.busy) {
      return
    }
    try {
      const selectedPath = await this.directoryPicker()
      if (selectedPath) {
        await this.selectRepository(selectedPath, true)
      }
    } catch (error) {
      this.setMessage(errorMessage(error), 'error')
    }
  }

  private async selectRepository(path: string, remember: boolean): Promise<void> {
    if (this.state.busy) {
      return
    }
    const switchingRepository = path !== this.state.repoPath
    if (switchingRepository) {
      this.repositoryGeneration += 1
      this.refreshRequestId += 1
    }
    this.state.busy = true
    this.renderAll()
    if (path !== this.state.repoPath && !(await this.flushPendingSave())) {
      this.state.busy = false
      this.renderAll()
      return
    }
    if (switchingRepository) {
      // Clear the old document before loading the new repository. Relative
      // paths can be identical across repositories and must never reuse the
      // previous source, FQCN, or test output.
      this.state.repoPath = null
      this.state.projectValid = false
      this.state.files = []
      this.state.fileSearch = ''
      this.resetCurrentFile()
    }
    this.setMessage('Checking repository…', 'info')
    try {
      const validation = await this.backend.validateProject(path)
      if (!validation.valid) {
        this.storage?.removeItem(LAST_REPOSITORY_KEY)
        throw new Error(validation.message ?? 'This folder does not look like the ps repository.')
      }

      this.state.repoPath = path
      this.state.projectValid = true
      if (remember) {
        this.storage?.setItem(LAST_REPOSITORY_KEY, path)
      }
      const filesLoaded = await this.refreshFiles(false)
      if (filesLoaded) {
        this.setMessage('Repository ready.', 'success')
      }
    } catch (error) {
      this.state.projectValid = false
      this.setMessage(errorMessage(error), 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async loadDailyProblem(): Promise<void> {
    if (this.state.busy) {
      return
    }
    this.state.busy = true
    this.renderAll()
    try {
      this.state.dailyProblem = await this.backend.fetchDailyProblem()
      this.state.dailyError = null
      this.setMessage('Daily problem loaded.', 'success')
    } catch (error) {
      this.state.dailyProblem = null
      this.state.dailyError = errorMessage(error)
      this.setMessage(`Could not load today's problem: ${this.state.dailyError}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async refreshFiles(showMessage = true): Promise<boolean> {
    if (!this.state.repoPath || !this.state.projectValid) {
      return false
    }
    const repoPath = this.state.repoPath
    const repositoryGeneration = this.repositoryGeneration
    const requestId = ++this.refreshRequestId
    try {
      const files = await this.backend.listProblemFiles(repoPath)
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      const selectedFileRemoved = Boolean(
        this.state.selectedPath && !files.some((file) => file.path === this.state.selectedPath),
      )
      if (selectedFileRemoved && !(await this.flushPendingSave())) {
        return false
      }
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.state.files = files
      if (selectedFileRemoved) {
        this.resetCurrentFile()
      }
      if (showMessage) {
        const javaFileCount = files.filter((file) => /\.java$/i.test(file.path)).length
        this.setMessage(`${javaFileCount} Java file${javaFileCount === 1 ? '' : 's'} found.`, 'success')
      }
      return true
    } catch (error) {
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.setMessage(`Could not list problem files: ${errorMessage(error)}`, 'error')
      return false
    } finally {
      this.renderAll()
    }
  }

  private isCurrentRefresh(repoPath: string, repositoryGeneration: number, requestId: number): boolean {
    return isCurrentRepositoryRefresh(
      { repoPath, repositoryGeneration, requestId },
      {
        repoPath: this.state.repoPath,
        projectValid: this.state.projectValid,
        repositoryGeneration: this.repositoryGeneration,
        refreshRequestId: this.refreshRequestId,
      },
    )
  }

  private async openFile(file: ProblemFileEntry): Promise<void> {
    if (!this.state.repoPath) {
      return
    }
    if (file.path === this.state.selectedPath) {
      this.expandedGroups.add(file.packageSegment)
      this.renderFiles()
      this.editor.focus()
      return
    }
    this.state.busy = true
    this.state.testResult = null
    this.state.testRun = null
    this.testRunGeneration += 1
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const source = await this.backend.readProblemFile(this.state.repoPath, file.path)
      this.state.selectedPath = file.path
      this.state.selectedSource = source
      this.state.savedSource = source
      this.state.selectedFqcn = fqcnFromJavaPath(file.path)
      this.state.dirty = false
      this.state.saveError = null
      this.suppressEditorChange = true
      try {
        this.editor.setValue(source)
      } finally {
        this.suppressEditorChange = false
      }
      this.editor.focus()
      this.setMessage(`Opened ${file.name}.`, 'success')
    } catch (error) {
      this.setMessage(`Could not open ${file.name}: ${errorMessage(error)}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private async createFileForToday(): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (!this.state.repoPath || !this.state.projectValid || !this.state.dailyProblem) {
      this.setMessage('Choose a valid repository and load today’s problem first.', 'error')
      return
    }
    this.state.busy = true
    this.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const problem = this.state.dailyProblem
      const plan = await createProblemWithRetry(this.backend, this.state.repoPath, {
        number: problem.frontendId,
        title: problem.title,
        difficulty: problem.difficulty,
        javaCodeSnippet: problem.javaSnippet,
      })
      await this.refreshFiles(false)
      const createdFile = this.state.files.find((file) => file.path === plan.path) ?? {
        path: plan.path,
        name: plan.fileName,
        packageSegment: plan.packageSegment,
      }
      await this.openFile(createdFile)
      this.setMessage(`Created ${plan.fileName}.`, 'success')
    } catch (error) {
      this.setMessage(`Could not create the problem file: ${errorMessage(error)}`, 'error')
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private onEditorChange(source: string): void {
    if (this.suppressEditorChange || !this.state.selectedPath || !this.state.repoPath) {
      return
    }
    this.state.selectedSource = source
    this.state.dirty = source !== this.state.savedSource
    this.state.saveError = null
    this.autosave.schedule({
      repoPath: this.state.repoPath,
      filePath: this.state.selectedPath,
      source,
    })
    this.renderFileHeading()
  }

  private resetCurrentFile(): void {
    this.state.selectedPath = null
    this.state.selectedSource = ''
    this.state.savedSource = ''
    this.state.selectedFqcn = null
    this.state.dirty = false
    this.state.saveError = null
    this.state.testResult = null
    this.state.testRun = null
    this.testRunGeneration += 1
    this.suppressEditorChange = true
    try {
      this.editor.setValue('')
    } finally {
      this.suppressEditorChange = false
    }
  }

  private async saveCurrentFile(): Promise<boolean> {
    if (!this.state.repoPath || !this.state.selectedPath) {
      return true
    }
    return this.flushPendingSave()
  }

  private async flushPendingSave(): Promise<boolean> {
    try {
      await this.autosave.flush()
      return !this.autosave.hasPendingChanges
    } catch (error) {
      this.handleSaveError(error)
      return false
    }
  }

  private async persistSnapshot(snapshot: AutosaveSnapshot): Promise<void> {
    await this.backend.saveProblemFile(snapshot.repoPath, snapshot.filePath, snapshot.source)
    if (snapshot.repoPath !== this.state.repoPath || snapshot.filePath !== this.state.selectedPath) {
      return
    }
    this.state.savedSource = snapshot.source
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.state.saveError = null
    this.element<HTMLElement>('#editor-host').dataset.savedSource = snapshot.source
    this.renderFileHeading()
  }

  private handleSaveError(error: unknown): void {
    this.state.saveError = errorMessage(error)
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.setMessage(`Could not save the file: ${this.state.saveError}`, 'error')
    this.renderAll()
  }

  private async runCurrentTest(): Promise<void> {
    if (this.state.busy) {
      return
    }
    if (!this.state.repoPath || !this.state.selectedPath || !this.state.selectedFqcn) {
      this.setMessage('Choose a Java file before running a test.', 'error')
      return
    }
    this.state.busy = true
    const runId = ++this.testRunGeneration
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
    }
    this.state.testRun = run
    this.state.testResult = null
    this.renderAll()
    this.setMessage(`Running ${this.state.selectedFqcn}…`, 'info')
    try {
      if (!(await this.flushPendingSave())) {
        if (this.isCurrentTestRun(runId)) {
          const failure = runnerFailureResult(
            run,
            this.state.saveError ?? 'The source file could not be saved before running tests.',
          )
          run.status = 'error'
          run.error = testFailureMessage(failure)
          this.state.testResult = failure
          this.setMessage(`Could not save before running the test: ${run.error}`, 'error')
        }
        return
      }
      const result = await this.backend.runProblemTest(
        this.state.repoPath,
        this.state.selectedFqcn,
        (progress) => this.applyTestRunProgress(runId, progress),
      )
      if (!this.isCurrentTestRun(runId)) {
        return
      }
      this.state.testResult = result
      run.status = 'completed'
      run.phase = result.phase
      run.tests = result.tests
      run.stdout = result.stdout
      run.stderr = result.stderr
      run.activeTest = null
      run.error = result.success ? null : testFailureMessage(result)
      this.setMessage(
        testResultBannerMessage(result),
        result.success ? 'success' : 'error',
      )
    } catch (error) {
      if (this.isCurrentTestRun(runId)) {
        const failure = runnerFailureResult(run, errorMessage(error))
        run.status = 'error'
        run.phase = failure.phase
        run.error = testFailureMessage(failure)
        run.activeTest = null
        this.state.testResult = failure
        this.setMessage(`Could not run the test: ${run.error}`, 'error')
      }
    } finally {
      this.state.busy = false
      this.renderAll()
    }
  }

  private isCurrentTestRun(runId: number): boolean {
    return this.state.testRun?.id === runId
      && this.testRunGeneration === runId
  }

  private applyTestRunProgress(runId: number, progress: TestRunProgress): void {
    if (!this.isCurrentTestRun(runId)) {
      return
    }
    const run = this.state.testRun
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
        if (sameTest(run.activeTest, progress.test)) {
          run.activeTest = null
        }
        break
    }
    this.scheduleLiveResultRender()
  }

  private upsertLiveTest(run: TestRunSnapshot, test: TestCaseResult): void {
    const index = run.tests.findIndex((entry) => sameTest(entry, test))
    if (index < 0) {
      run.tests.push(test)
      return
    }
    run.tests[index] = { ...run.tests[index], ...test }
  }

  private scheduleLiveResultRender(): void {
    if (this.destroyed || this.liveRenderFrame !== null) {
      return
    }
    const token = ++this.liveRenderToken
    const flush = (): void => {
      if (token !== this.liveRenderToken || this.destroyed) {
        return
      }
      this.liveRenderFrame = null
      this.renderResult()
    }
    if (typeof window.requestAnimationFrame === 'function') {
      this.liveRenderFrame = window.requestAnimationFrame(flush)
    } else {
      // The fallback keeps the same coalescing behavior in non-visual test
      // environments where requestAnimationFrame is unavailable.
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
      && typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(this.liveRenderFrame)
    }
    this.liveRenderFrame = null
  }

  private renderAll(): void {
    this.cancelScheduledLiveRender()
    this.element<HTMLElement>('#repo-path').textContent = this.state.repoPath ?? 'Not selected'
    this.renderShortcutLabels()
    this.renderDailyProblem()
    this.renderFiles()
    this.renderFileHeading()
    this.renderResult()
    this.element<HTMLButtonElement>('#choose-repository').disabled = this.state.busy
    this.element<HTMLButtonElement>('#refresh-files').disabled = this.state.busy || !this.state.projectValid
    this.element<HTMLButtonElement>('#refresh-daily').disabled = this.state.busy
    this.element<HTMLButtonElement>('#create-file').disabled = this.state.busy || !this.state.projectValid || !this.state.dailyProblem
    this.element<HTMLButtonElement>('#run-test').disabled = this.state.busy || !this.state.selectedPath
    this.element<HTMLElement>('#editor-empty').hidden = Boolean(this.state.selectedPath)
    this.element<HTMLElement>('#editor-host').classList.toggle('is-empty', !this.state.selectedPath)
  }

  private renderShortcutLabels(): void {
    const modifier = isMacPlatform() ? '⌘' : 'Ctrl+'
    this.element<HTMLElement>('#run-shortcut').textContent = `${modifier}R`
  }

  private renderDailyProblem(): void {
    const content = this.element<HTMLElement>('#daily-content')
    const link = this.element<HTMLAnchorElement>('#problem-link')
    if (!this.state.dailyProblem) {
      content.innerHTML = ''
      const message = document.createElement('p')
      message.className = this.state.dailyError ? 'error-copy' : 'muted-copy'
      message.textContent = this.state.dailyError
        ? `Could not load today’s problem: ${this.state.dailyError}`
        : 'Loading today’s problem…'
      content.append(message)
      link.hidden = true
      return
    }
    const problem = this.state.dailyProblem
    content.innerHTML = ''
    content.append(iconFor('calendar', 'daily-icon'))
    const number = document.createElement('span')
    number.className = 'problem-number'
    number.textContent = `#${problem.frontendId}`
    const title = document.createElement('strong')
    title.className = 'problem-title'
    title.textContent = problem.title
    const difficulty = document.createElement('span')
    difficulty.className = `difficulty difficulty-${problem.difficulty.toLowerCase()}`
    difficulty.textContent = problem.difficulty
    content.append(number, title, difficulty)
    link.href = problem.url
    link.hidden = false
  }

  private renderFiles(): void {
    const list = this.element<HTMLElement>('#file-list')
    list.innerHTML = ''
    const searchInput = this.element<HTMLInputElement>('#file-search')
    if (searchInput.value !== this.state.fileSearch) {
      searchInput.value = this.state.fileSearch
    }
    if (!this.state.projectValid) {
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'Select the repository folder to see your problems.'
      list.append(empty)
      return
    }

    const selectedGroup = this.state.files.find((file) => file.path === this.state.selectedPath)?.packageSegment
    if (selectedGroup && selectedGroup !== 'other') {
      this.expandedGroups.add(selectedGroup)
    }

    const searchTerm = this.state.fileSearch.trim()
    const javaFiles = this.state.files.filter((file) => /\.java$/i.test(file.path))
    const filteredFiles = filterProblemFiles(javaFiles, searchTerm)
    if (searchTerm && filteredFiles.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted-copy sidebar-empty'
      empty.textContent = 'No matches'
      list.append(empty)
      return
    }

    for (const group of FILE_GROUPS) {
      const files = filterProblemFilesByGroup(javaFiles, group.key, searchTerm)
      if (searchTerm && files.length === 0) {
        continue
      }
      const section = document.createElement('section')
      section.className = 'file-group'
      const isCurrentGroup = selectedGroup === group.key
      const expanded = isCurrentGroup || this.expandedGroups.has(group.key)
      section.dataset.expanded = String(expanded)

      const heading = document.createElement('div')
      heading.className = 'file-group-heading'
      const headingButton = document.createElement('button')
      headingButton.type = 'button'
      headingButton.className = 'file-group-toggle'
      headingButton.setAttribute('aria-expanded', String(expanded))
      headingButton.setAttribute('aria-controls', `file-group-${group.key}`)
      if (isCurrentGroup) {
        headingButton.title = 'The current file group stays open'
      }
      const groupLabel = document.createElement('span')
      groupLabel.className = 'file-group-label'
      groupLabel.append(
        iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'),
        document.createTextNode(group.label),
      )
      const count = document.createElement('span')
      count.className = 'file-count'
      count.textContent = String(files.length)
      headingButton.append(groupLabel, count)
      const updateGroupIcon = (nextExpanded: boolean): void => {
        const previous = groupLabel.querySelector('.group-toggle-icon')
        previous?.replaceWith(iconFor(nextExpanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'))
      }
      headingButton.addEventListener('click', () => {
        if (selectedGroup === group.key) {
          this.expandedGroups.add(group.key)
          section.dataset.expanded = 'true'
          headingButton.setAttribute('aria-expanded', 'true')
          groupList.hidden = false
          updateGroupIcon(true)
          return
        }
        const nextExpanded = !this.expandedGroups.has(group.key)
        if (nextExpanded) {
          this.expandedGroups.add(group.key)
        } else {
          this.expandedGroups.delete(group.key)
        }
        section.dataset.expanded = String(nextExpanded)
        headingButton.setAttribute('aria-expanded', String(nextExpanded))
        groupList.hidden = !nextExpanded
        updateGroupIcon(nextExpanded)
      })
      heading.append(headingButton)
      section.append(heading)
      const groupList = document.createElement('div')
      groupList.className = 'file-group-list'
      groupList.id = `file-group-${group.key}`
      groupList.hidden = !expanded
      for (const file of files) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'file-item'
        button.classList.toggle('is-active', file.path === this.state.selectedPath)
        button.disabled = this.state.busy
        button.dataset.path = file.path
        button.title = file.path
        const fileName = document.createElement('span')
        fileName.className = 'file-item-name'
        fileName.textContent = file.name.replace(/\.java$/i, '')
        button.append(
          iconFor('fileCode', 'file-item-icon'),
          fileName,
        )
        button.addEventListener('click', () => {
          void this.openFile(file)
        })
        groupList.append(button)
      }
      if (files.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'group-empty'
        empty.textContent = 'No files yet'
        groupList.append(empty)
      }
      section.append(groupList)
      list.append(section)
    }

    this.scrollActiveFileIntoView()
  }

  private scrollActiveFileIntoView(): void {
    if (!this.state.selectedPath) {
      return
    }
    const active = Array.from(this.root.querySelectorAll<HTMLElement>('.file-item'))
      .find((item) => item.dataset.path === this.state.selectedPath)
    const groupList = active?.closest<HTMLElement>('.file-group-list')
    if (!active || active.hidden || groupList?.hidden) {
      return
    }
    const scroll = (): void => {
      active.scrollIntoView?.({ block: 'nearest' })
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scroll)
    } else {
      queueMicrotask(scroll)
    }
  }

  private renderFileHeading(): void {
    const selectedFile = this.element<HTMLElement>('#selected-file')
    const file = this.state.files.find((entry) => entry.path === this.state.selectedPath)
    selectedFile.textContent = file?.name ?? 'No file selected'
    const dirty = this.element<HTMLElement>('#dirty-indicator')
    dirty.hidden = !this.state.dirty || this.autosave.status === 'saving'
    const saveStatus = this.element<HTMLElement>('#save-status')
    saveStatus.className = 'save-status'
    if (this.state.saveError) {
      saveStatus.classList.add('is-error')
      saveStatus.textContent = 'Save failed'
      saveStatus.title = this.state.saveError
    } else if (this.autosave.status === 'saving') {
      saveStatus.classList.add('is-saving')
      saveStatus.textContent = 'Saving…'
      saveStatus.removeAttribute('title')
    } else {
      saveStatus.textContent = ''
      saveStatus.removeAttribute('title')
    }
    this.element<HTMLElement>('#editor-host').dataset.savedSource = this.state.savedSource
  }

  private renderResult(): void {
    const resultsCard = this.element<HTMLElement>('.results-card')
    const status = this.element<HTMLElement>('#result-status')
    const badge = this.element<HTMLElement>('#result-badge')
    const phaseElement = this.element<HTMLElement>('#result-phase')
    const elapsedElement = this.element<HTMLElement>('#result-elapsed')
    const summaryElement = this.element<HTMLElement>('#test-summary')
    const failurePanel = this.element<HTMLElement>('#failure-panel')
    const failurePanelTitle = this.element<HTMLElement>('#failure-panel-title')
    const failurePanelMessage = this.element<HTMLElement>('#failure-panel-message')
    const testList = this.element<HTMLElement>('#test-list')
    const diagnosticsElement = this.element<HTMLElement>('#diagnostics')
    const stdout = this.element<HTMLElement>('#stdout')
    const stderr = this.element<HTMLElement>('#stderr')
    const rawLogs = this.element<HTMLDetailsElement>('#raw-logs')
    const liveRun = this.state.testRun?.status === 'running' ? this.state.testRun : null
    const result = this.state.testResult ?? (liveRun ? liveSnapshotResult(liveRun) : null)
    status.className = 'result-status'
    status.removeAttribute('title')
    badge.className = 'result-badge'
    badge.textContent = '·'
    phaseElement.textContent = 'No run yet'
    elapsedElement.textContent = ''
    summaryElement.textContent = ''
    failurePanel.hidden = true
    failurePanelTitle.textContent = ''
    failurePanelMessage.textContent = ''
    testList.innerHTML = ''
    diagnosticsElement.innerHTML = ''
    resultsCard.setAttribute('aria-busy', liveRun ? 'true' : 'false')
    if (!result) {
      status.textContent = 'No run yet'
      summaryElement.textContent = 'Run the current class to see results.'
      stdout.textContent = ''
      stderr.textContent = ''
      rawLogs.open = false
      this.renderedTestResult = null
      return
    }
    const presentation = presentTestResult(result)
    const isRunning = liveRun !== null
    const isRunnerError = this.state.testRun?.status === 'error'
      || normalizeTestPhase(result.phase) === 'runner'
    const hasFailure = !result.success || isRunnerError
    const statusClass = isRunning ? 'is-running' : hasFailure ? 'is-failure' : 'is-success'
    status.classList.add(statusClass)
    badge.classList.add(statusClass)
    badge.textContent = isRunning ? '◌' : !hasFailure ? '✓' : isRunnerError || result.summary.errors > 0 ? '!' : '×'
    status.textContent = isRunning
      ? 'Running'
      : isRunnerError
        ? `Error · ${testPhaseLabel(result.phase)}`
        : presentation.statusLabel
    phaseElement.textContent = isRunning
      ? `· ${testPhaseLabel(result.phase)}`
      : testPhaseLabel(result.phase)
    if (isRunning) {
      elapsedElement.textContent = formatDuration(result.summary.durationMs ?? 0)
    } else if (result.summary.durationMs !== null && result.summary.durationMs !== undefined) {
      elapsedElement.textContent = formatDuration(result.summary.durationMs)
    }
    if (!isRunning && !result.success && presentation.failureMessage) {
      status.title = presentation.failureMessage
    }
    const resultChanged = this.renderedTestResult !== result
    if (resultChanged || isRunning) {
      rawLogs.open = isRunning || presentation.rawLogsOpen
    }
    this.renderedTestResult = result
    const summary = result.summary
    this.renderSummaryBadges(summaryElement, summary, isRunning)

    if (!isRunning && !result.success && presentation.failureMessage) {
      failurePanel.hidden = false
      failurePanelTitle.textContent = normalizeTestPhase(result.phase) === 'noTests'
        ? 'No tests found'
        : `${presentation.phaseLabel} failed`
      failurePanelMessage.textContent = presentation.failureMessage
    }

    this.renderTestGroups(testList, result.tests)
    if (isRunning && result.tests.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'test-empty test-empty-running'
      empty.textContent = `Running · ${testPhaseLabel(result.phase)}…`
      testList.append(empty)
    } else if (!isRunning && result.tests.length === 0 && result.phase !== 'compile') {
      const empty = document.createElement('div')
      empty.className = 'test-empty'
      empty.textContent = 'No tests were reported.'
      testList.append(empty)
    }
    if (result.diagnostics.length > 0) {
      const heading = document.createElement('h3')
      heading.textContent = 'Diagnostics'
      diagnosticsElement.append(heading)
      for (const diagnostic of result.diagnostics) {
        diagnosticsElement.append(this.renderDiagnostic(diagnostic))
      }
    }
    stdout.textContent = result.stdout || '(no stdout)'
    stderr.textContent = result.stderr || '(no stderr)'
  }

  private renderSummaryBadges(
    container: HTMLElement,
    summary: TestResult['summary'],
    isRunning: boolean,
  ): void {
    const parts: Array<{ label: string; value: number; className: string }> = [
      { label: 'total', value: summary.total, className: 'summary-total' },
      { label: 'passed', value: summary.passed, className: 'summary-passed' },
      { label: 'failed', value: summary.failed, className: 'summary-failed' },
      { label: 'errors', value: summary.errors, className: 'summary-errors' },
      { label: 'skipped', value: summary.skipped, className: 'summary-skipped' },
    ]
    for (const part of parts) {
      const badge = document.createElement('span')
      badge.className = `summary-badge ${part.className}`
      badge.textContent = `${part.value} ${part.label}`
      container.append(badge)
    }
    if (summary.durationMs !== null && summary.durationMs !== undefined) {
      const duration = document.createElement('span')
      duration.className = 'summary-duration'
      duration.textContent = isRunning ? `· ${formatDuration(summary.durationMs)}` : formatDuration(summary.durationMs)
      container.append(duration)
    }
  }

  private renderTestGroups(container: HTMLElement, tests: TestCaseResult[]): void {
    const groups = new Map<string, TestCaseResult[]>()
    for (const test of tests) {
      const className = test.className || this.state.selectedFqcn || 'Tests'
      const group = groups.get(className) ?? []
      group.push(test)
      groups.set(className, group)
    }
    for (const [className, group] of groups) {
      const suite = document.createElement('details')
      suite.className = 'test-suite'
      suite.open = true
      const heading = document.createElement('summary')
      heading.className = 'test-suite-summary'
      const suiteIcon = document.createElement('span')
      suiteIcon.className = 'test-suite-icon'
      suiteIcon.textContent = '▾'
      suiteIcon.setAttribute('aria-hidden', 'true')
      const suiteName = document.createElement('span')
      suiteName.className = 'test-suite-name'
      suiteName.textContent = className
      const suiteCount = document.createElement('span')
      suiteCount.className = 'test-suite-count'
      suiteCount.textContent = `${group.length} test${group.length === 1 ? '' : 's'}`
      heading.append(suiteIcon, suiteName, suiteCount)
      suite.append(heading)
      const children = document.createElement('div')
      children.className = 'test-suite-children'
      for (const test of group) {
        children.append(this.renderTestCase(test))
      }
      suite.append(children)
      container.append(suite)
    }
  }

  private renderTestCase(test: TestCaseResult): HTMLElement {
    const failed = test.status === 'failed' || test.status === 'error'
    const hasDetail = failed || Boolean(
      test.message || test.details || test.expected || test.actual || (test.file && test.line),
    )
    const row = hasDetail ? document.createElement('details') : document.createElement('div')
    row.className = `test-row test-row-${test.status}`

    const summary = document.createElement(hasDetail ? 'summary' : 'div')
    summary.className = 'test-row-summary'
    summary.append(this.statusIcon(test.status))
    const name = document.createElement('span')
    name.className = 'test-name'
    name.textContent = test.displayName || test.name
    summary.append(name)
    if (test.durationMs !== null && test.durationMs !== undefined) {
      const duration = document.createElement('span')
      duration.className = 'test-duration'
      duration.textContent = formatDuration(test.durationMs)
      summary.append(duration)
    }
    row.append(summary)

    if (failed && row instanceof HTMLDetailsElement) {
      row.open = true
    }
    if (hasDetail && row instanceof HTMLDetailsElement) {
      const detail = document.createElement('div')
      detail.className = 'test-failure-detail'
      if (test.message) {
        const message = document.createElement('p')
        message.className = 'failure-message'
        message.textContent = test.message
        detail.append(message)
      }
      if (test.expected !== null && test.expected !== undefined) {
        detail.append(this.renderValue('Expected', test.expected, 'expected-value'))
      }
      if (test.actual !== null && test.actual !== undefined) {
        detail.append(this.renderValue('Actual', test.actual, 'actual-value'))
      }
      if (test.details) {
        const stacktrace = document.createElement('pre')
        stacktrace.className = 'test-stacktrace'
        stacktrace.textContent = test.details
        detail.append(stacktrace)
      }
      if (test.file && test.line !== null && test.line !== undefined) {
        detail.append(this.renderLocation(test.file, test.line, test.column))
      }
      row.append(detail)
    }
    return row
  }

  private renderValue(label: string, value: string, className: string): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = `failure-value ${className}`
    const title = document.createElement('span')
    title.className = 'failure-value-label'
    title.textContent = `${label}:`
    const content = document.createElement('code')
    content.textContent = value
    wrapper.append(title, content)
    return wrapper
  }

  private renderDiagnostic(diagnostic: TestDiagnostic): HTMLElement {
    const row = document.createElement('div')
    row.className = `diagnostic diagnostic-${diagnostic.severity}`
    const icon = document.createElement('span')
    icon.className = 'diagnostic-icon'
    icon.textContent = diagnostic.severity === 'warning' ? '!' : '×'
    icon.setAttribute('aria-hidden', 'true')
    const message = document.createElement('span')
    message.className = 'diagnostic-message'
    message.textContent = diagnostic.message
    row.append(icon, message)
    if (diagnostic.file && diagnostic.line) {
      row.append(this.renderLocation(diagnostic.file, diagnostic.line, diagnostic.column))
    }
    return row
  }

  private renderLocation(file: string, line: number, column?: number | null): HTMLElement {
    const location = document.createElement('button')
    location.type = 'button'
    location.className = 'result-location'
    location.append(
      iconFor('locate', 'result-location-icon'),
      document.createTextNode(`${file}:${line}${column ? `:${column}` : ''}`),
    )
    location.title = 'Reveal this line in the editor'
    location.addEventListener('click', () => {
      const reveal = this.editor as JavaEditor & { revealLine?: (line: number) => void }
      reveal.revealLine?.(line)
    })
    return location
  }

  private statusIcon(status: string): HTMLElement {
    const icon = document.createElement('span')
    icon.className = `test-status-icon test-status-${status}`
    icon.textContent = status === 'passed'
      ? '✓'
      : status === 'failed'
        ? '×'
        : status === 'error'
          ? '!'
          : status === 'skipped'
            ? '–'
            : status === 'running'
              ? '◌'
              : '·'
    icon.setAttribute('aria-label', status)
    return icon
  }

  private setMessage(message: string, tone: 'info' | 'success' | 'error'): void {
    const status = this.element<HTMLElement>('#app-status')
    status.textContent = message
    status.dataset.tone = tone
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`Missing editor element: ${selector}`)
    }
    return element
  }
}

function fqcnFromJavaPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const root = 'src/main/java/'
  const rootIndex = normalized.indexOf(root)
  if (rootIndex < 0 || !normalized.toLowerCase().endsWith('.java')) {
    return null
  }
  return normalized
    .slice(rootIndex + root.length, -'.java'.length)
    .split('/')
    .filter(Boolean)
    .join('.')
}

async function defaultDirectoryPicker(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select your leetcoder repository',
  })
  if (Array.isArray(selected)) {
    return selected[0] ?? null
  }
  return selected
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }
  return `${(durationMs / 1000).toFixed(2)}s`
}

export { fqcnFromJavaPath }

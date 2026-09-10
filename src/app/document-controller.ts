import { errorMessage, type ProblemFileEntry } from '../backend'
import type { EditorIssue } from '../editor'
import { AutosaveCoordinator, type AutosaveStatus } from './autosave'
import { replacementTabIndex } from './navigation'
import { fqcnFromJavaPath, gitFileName, sameFilePath } from './path-helpers'
import type {
  AppState,
  AutosaveSnapshot,
  OpenFileTab,
} from './types'

/** The app state that belongs to the currently open document and tab strip. */
export type DocumentControllerState = Pick<
  AppState,
  | 'repoPath'
  | 'projectValid'
  | 'files'
  | 'openTabs'
  | 'activeTabId'
  | 'selectedPath'
  | 'selectedSource'
  | 'savedSource'
  | 'selectedFqcn'
  | 'dirty'
  | 'saveError'
  | 'testRun'
  | 'busy'
>

/** The file operations needed by the document lifecycle. */
export interface DocumentControllerBackend {
  readProblemFile: (repoPath: string, filePath: string) => Promise<string>
  saveProblemFile: (repoPath: string, filePath: string, source: string) => Promise<void>
}

/** The editor surface used by the document lifecycle. */
export interface DocumentControllerEditor {
  setValue: (source: string) => void
  reloadExternalValue: (source: string) => void
  focus: () => void
  setIssues: (issues: readonly EditorIssue[], options?: { reveal?: boolean }) => void
}

export type DocumentControllerMessageTone = 'info' | 'success' | 'error'

/** Render and state callbacks kept deliberately narrower than LeetcoderApp. */
export interface DocumentControllerContext {
  readonly state: DocumentControllerState
  readonly backend: DocumentControllerBackend
  readonly editor: DocumentControllerEditor
  readonly getRepositoryGeneration: () => number
  readonly resetTestState: () => void
  readonly cancelCurrentRun: () => void
  readonly renderAll: () => void
  readonly renderFileHeading: () => void
  readonly renderFileTabs: () => void
  readonly updateFileTabState: () => void
  readonly updateFileExplorerState: () => void
  readonly updateEditorVisibility: () => void
  readonly renderResult: () => void
  readonly setExpandedGroup: (
    group: ProblemFileEntry['packageSegment'],
    expanded: boolean,
  ) => void
  readonly scheduleLiveDiagnostics: () => void
  readonly markGitStale: () => void
  /** Keep the editor host's saved-source marker in sync without exposing DOM. */
  readonly setSavedSource: (source: string) => void
  readonly setMessage: (message: string, tone: DocumentControllerMessageTone) => void
  /** Updates controls immediately when this controller owns the busy flag. */
  readonly renderBusyControls?: () => void
  /** Preserve the explorer reveal that follows selecting an already-active file. */
  readonly revealSelectedFileInExplorer?: () => void
  /** Lets tests and hosts reject callbacks after their own teardown starts. */
  readonly isDestroyed?: () => boolean
}

/**
 * Owns the selected document, open tabs, autosave, and filesystem reload
 * lifecycle. The app supplies state and rendering callbacks, while repository
 * generation remains an app-level concern used to reject stale reads/writes.
 */
export class DocumentController {
  private readonly context: DocumentControllerContext
  private readonly autosave: AutosaveCoordinator
  private readonly snapshotGenerations = new WeakMap<AutosaveSnapshot, number>()
  private readonly state: DocumentControllerState
  private nextOpenTabId = 1
  private closePreparation: Promise<void> | null = null
  private destroyed = false
  private suppressEditorChange = false
  private fileOpenInProgress = false
  private saveWriteInFlightState = false
  private externalReloadInFlight = false
  private savedFlashState = false
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null
  private gitDiscardInProgress = false

  constructor(context: DocumentControllerContext) {
    this.context = context
    this.state = context.state
    this.autosave = new AutosaveCoordinator(
      (snapshot) => this.persistSnapshot(snapshot),
      {
        onStatusChange: () => {
          if (this.isAlive()) {
            this.context.renderFileHeading()
          }
        },
        onError: (error) => this.handleSaveError(error),
      },
    )
  }

  get autosaveStatus(): AutosaveStatus {
    return this.autosave.status
  }

  get hasPendingChanges(): boolean {
    return this.autosave.hasPendingChanges
  }

  /** True while a debounced or active write is being drained. */
  get isSaving(): boolean {
    return this.saveWriteInFlightState || this.autosave.status === 'saving'
  }

  /** True only while the backend save promise is active. */
  get saveWriteInFlight(): boolean {
    return this.saveWriteInFlightState
  }

  get savedFlash(): boolean {
    return this.savedFlashState
  }

  activeOpenTab(): OpenFileTab | null {
    if (this.state.activeTabId === null) {
      return null
    }
    return this.state.openTabs.find((tab) => tab.id === this.state.activeTabId) ?? null
  }

  openTabForPath(path: string): OpenFileTab | null {
    return this.state.openTabs.find((tab) => sameFilePath(tab.path, path)) ?? null
  }

  /** Open a file, reusing its tab when it is already open. */
  async openFile(file: ProblemFileEntry): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath || this.fileOpenInProgress || !this.isAlive()) {
      return
    }
    const existing = this.openTabForPath(file.path)
    if (existing && existing.id === this.state.activeTabId
      && sameFilePath(file.path, this.state.selectedPath ?? '')) {
      this.context.revealSelectedFileInExplorer?.()
      this.context.editor.focus()
      return
    }

    const ownsBusy = !this.state.busy
    const repositoryGeneration = this.context.getRepositoryGeneration()
    if (ownsBusy) {
      this.fileOpenInProgress = true
      this.state.busy = true
      this.context.renderBusyControls?.()
    }
    try {
      if (!(await this.flushPendingSave())
        || !this.isCurrentRepository(repoPath, repositoryGeneration)) {
        return
      }
      const source = await this.context.backend.readProblemFile(repoPath, file.path)
      if (!this.isCurrentRepository(repoPath, repositoryGeneration)) {
        return
      }
      const tabMetadataChanged = Boolean(existing && (
        existing.path !== file.path
        || existing.name !== file.name
        || existing.packageSegment !== file.packageSegment
      ))
      const tab = existing ?? this.createOpenTab(file)
      tab.path = file.path
      tab.name = file.name
      tab.packageSegment = file.packageSegment
      if (!existing) {
        this.state.openTabs.push(tab)
      }
      this.state.activeTabId = tab.id
      this.state.selectedPath = file.path
      this.state.selectedFqcn = fqcnFromJavaPath(file.path)
      this.applySavedSource(source)
      this.context.setExpandedGroup(file.packageSegment, true)
      this.context.renderFileHeading()
      this.context.renderResult()
      this.context.updateFileExplorerState()
      if (!existing || tabMetadataChanged) {
        this.context.renderFileTabs()
      } else {
        this.context.updateFileTabState()
      }
      this.context.updateEditorVisibility()
      this.context.editor.focus()
      this.context.scheduleLiveDiagnostics()
    } catch (error) {
      if (this.isCurrentRepository(repoPath, repositoryGeneration)) {
        this.context.setMessage(`Could not open ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      if (ownsBusy) {
        this.state.busy = false
        this.fileOpenInProgress = false
        this.context.renderBusyControls?.()
      }
    }
  }

  /** Activate an existing tab, removing it if the repository no longer lists its file. */
  async openTab(tabId: number): Promise<void> {
    if (!this.isAlive() || this.state.busy) {
      return
    }
    const tab = this.state.openTabs.find((entry) => entry.id === tabId)
    if (!tab) {
      return
    }
    const file = this.state.files.find((entry) => sameFilePath(entry.path, tab.path))
    if (!file) {
      this.state.openTabs = this.state.openTabs.filter((entry) => entry.id !== tabId)
      if (this.state.activeTabId === tabId) {
        this.resetCurrentFile()
      }
      this.context.renderAll()
      return
    }
    await this.openFile(file)
  }

  /** Close one tab after the selected document's pending edits are safe on disk. */
  async closeOpenTab(tabId: number): Promise<void> {
    if (!this.isAlive() || this.state.busy) {
      return
    }
    const target = this.state.openTabs.find((tab) => tab.id === tabId)
    if (!target) {
      return
    }
    const wasActive = target.id === this.state.activeTabId
    this.state.busy = true
    this.context.renderAll()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      const replacement = this.removeOpenTab(tabId)
      if (wasActive && replacement) {
        const file = this.state.files.find((entry) => sameFilePath(entry.path, replacement.path)) ?? {
          path: replacement.path,
          name: replacement.name,
          packageSegment: replacement.packageSegment,
        }
        await this.openFile(file)
      }
    } finally {
      this.state.busy = false
      this.context.renderAll()
    }
  }

  /** Close every open tab after flushing the selected document. */
  async closeAllOpenTabs(): Promise<void> {
    if (!this.isAlive() || this.state.busy || this.state.openTabs.length === 0) {
      return
    }
    this.state.busy = true
    this.context.renderBusyControls?.()
    try {
      if (!(await this.flushPendingSave())) {
        return
      }
      this.state.openTabs = []
      this.resetCurrentFile()
    } finally {
      this.state.busy = false
      this.context.renderAll()
    }
  }

  /**
   * Remove a tab without doing asynchronous work. Callers use the returned
   * tab to select a replacement after repository/file-operation checks.
   */
  removeOpenTab(tabId: number): OpenFileTab | null {
    const index = this.state.openTabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) {
      return null
    }
    const wasActive = this.state.activeTabId === tabId
    this.state.openTabs.splice(index, 1)
    if (!wasActive) {
      return null
    }
    const replacementIndex = replacementTabIndex(this.state.openTabs.length, index)
    const replacement = replacementIndex === null ? null : this.state.openTabs[replacementIndex]
    this.resetCurrentFile()
    return replacement ?? null
  }

  /** Clear the active document and invalidate its editor/test state. */
  resetCurrentFile(): void {
    this.state.activeTabId = null
    this.state.selectedPath = null
    this.state.selectedSource = ''
    this.state.savedSource = ''
    this.state.selectedFqcn = null
    this.state.dirty = false
    this.state.saveError = null
    this.context.resetTestState()
    this.clearSavedFlash()
    this.suppressEditorChange = true
    try {
      this.context.editor.setValue('')
    } finally {
      this.suppressEditorChange = false
    }
  }

  /** Record an editor edit and schedule the newest source for autosave. */
  onEditorChange(source: string): void {
    if (!this.isAlive() || this.suppressEditorChange || !this.state.selectedPath || !this.state.repoPath) {
      return
    }
    this.context.editor.setIssues([])
    this.state.selectedSource = source
    this.state.dirty = source !== this.state.savedSource
    this.state.saveError = null
    this.clearSavedFlash()
    if (this.state.testRun?.status === 'running') {
      this.context.cancelCurrentRun()
      this.context.renderResult()
    }
    if (!this.gitDiscardInProgress) {
      const snapshot: AutosaveSnapshot = {
        repoPath: this.state.repoPath,
        filePath: this.state.selectedPath,
        source,
      }
      this.snapshotGenerations.set(snapshot, this.context.getRepositoryGeneration())
      this.autosave.schedule(snapshot)
    }
    this.context.renderFileHeading()
    this.context.updateFileTabState()
    this.context.scheduleLiveDiagnostics()
  }

  /** Save immediately, returning false when the backend rejected the write. */
  async saveCurrentFile(): Promise<boolean> {
    if (!this.state.repoPath || !this.state.selectedPath) {
      return true
    }
    return this.flushPendingSave()
  }

  /** Drain the debounced write before navigation or another file operation. */
  async flushPendingSave(): Promise<boolean> {
    try {
      await this.autosave.flush()
      return !this.autosave.hasPendingChanges
    } catch (error) {
      this.handleSaveError(error)
      return false
    }
  }

  /** Prepare pending edits before the native window is closed. */
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

  /** Cancel queued work before a destructive Git restore. */
  cancelPendingAutosave(): void {
    this.autosave.cancelPending()
  }

  /** Suppress edits generated while Git restores the selected file. */
  beginGitDiscard(): void {
    this.gitDiscardInProgress = true
  }

  endGitDiscard(): void {
    this.gitDiscardInProgress = false
  }

  /** Apply a source loaded from disk while resetting test/editor history. */
  applySavedSource(source: string): void {
    this.state.selectedSource = source
    this.state.savedSource = source
    this.state.dirty = false
    this.state.saveError = null
    this.clearSavedFlash()
    this.context.resetTestState()
    this.suppressEditorChange = true
    try {
      this.context.editor.setValue(source)
    } finally {
      this.suppressEditorChange = false
    }
    this.context.setSavedSource(source)
  }

  /**
   * Reload a clean open document after another process changed it on disk.
   * Pending local edits always win and are kept with an informational toast.
   */
  async reloadOpenFileFromDisk(path: string): Promise<void> {
    const repoPath = this.state.repoPath
    if (!repoPath
      || !this.isAlive()
      || this.externalReloadInFlight
      || this.saveWriteInFlight
      || this.fileOpenInProgress) {
      return
    }
    this.externalReloadInFlight = true
    const repositoryGeneration = this.context.getRepositoryGeneration()
    try {
      const source = await this.context.backend.readProblemFile(repoPath, path)
      if (!this.isCurrentRepository(repoPath, repositoryGeneration)
        || this.state.selectedPath !== path
        || source === this.state.savedSource) {
        return
      }
      if (this.state.dirty || this.autosave.hasPendingChanges) {
        this.context.setMessage(
          `${gitFileName(path)} changed on disk. Your unsaved edits were kept.`,
          'info',
        )
        return
      }
      this.state.savedSource = source
      this.state.selectedSource = source
      this.state.dirty = false
      this.state.saveError = null
      this.context.setSavedSource(source)
      this.suppressEditorChange = true
      try {
        this.context.editor.reloadExternalValue(source)
      } finally {
        this.suppressEditorChange = false
      }
      this.context.editor.setIssues([])
      this.context.markGitStale()
      this.context.scheduleLiveDiagnostics()
      this.context.renderFileHeading()
      this.context.updateFileTabState()
    } catch {
      // A deleted or moved file is reconciled by the repository refresh.
    } finally {
      this.externalReloadInFlight = false
    }
  }

  dispose(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.clearSavedFlash()
    this.autosave.dispose()
  }

  private createOpenTab(file: ProblemFileEntry): OpenFileTab {
    return {
      id: this.nextOpenTabId++,
      path: file.path,
      name: file.name,
      packageSegment: file.packageSegment,
    }
  }

  private isCurrentRepository(repoPath: string, repositoryGeneration: number): boolean {
    return this.isAlive()
      && this.state.repoPath === repoPath
      && this.context.getRepositoryGeneration() === repositoryGeneration
  }

  private async persistSnapshot(snapshot: AutosaveSnapshot): Promise<void> {
    this.saveWriteInFlightState = true
    this.context.renderFileHeading()
    try {
      await this.context.backend.saveProblemFile(snapshot.repoPath, snapshot.filePath, snapshot.source)
    } finally {
      this.saveWriteInFlightState = false
    }
    const snapshotGeneration = this.snapshotGenerations.get(snapshot)
    if (!this.isAlive()
      || snapshot.repoPath !== this.state.repoPath
      || snapshot.filePath !== this.state.selectedPath
      || (snapshotGeneration !== undefined
        && snapshotGeneration !== this.context.getRepositoryGeneration())) {
      return
    }
    this.state.savedSource = snapshot.source
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.state.saveError = null
    this.context.setSavedSource(snapshot.source)
    this.context.markGitStale()
    if (!this.state.dirty) {
      this.flashSavedIndicator()
    }
    this.context.renderFileHeading()
    this.context.updateFileTabState()
  }

  private flashSavedIndicator(): void {
    this.clearSavedFlash()
    this.savedFlashState = true
    this.savedFlashTimer = setTimeout(() => {
      this.savedFlashTimer = null
      this.savedFlashState = false
      if (this.isAlive()) {
        this.context.renderFileHeading()
      }
    }, 1500)
  }

  private clearSavedFlash(): void {
    if (this.savedFlashTimer !== null) {
      clearTimeout(this.savedFlashTimer)
      this.savedFlashTimer = null
    }
    this.savedFlashState = false
  }

  private handleSaveError(error: unknown): void {
    if (!this.isAlive()) {
      return
    }
    this.state.saveError = errorMessage(error)
    this.state.dirty = this.state.selectedSource !== this.state.savedSource
    this.context.setMessage(`Could not save the file: ${this.state.saveError}`, 'error')
    this.context.renderAll()
  }

  private isAlive(): boolean {
    return !this.destroyed && !this.context.isDestroyed?.()
  }
}

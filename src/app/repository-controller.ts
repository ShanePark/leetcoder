import { errorMessage, type BackendClient, type RepositoryFilesChanged } from '../backend'
import type { AppState, DirectoryPicker } from './types'
import type { DocumentController } from './document-controller'
import type { GitController } from './git-controller'
import type { FileDialogController } from './file-dialog-controller'
import type { ProjectContentSearchController } from './project-search-controller'
import type { JavaTypeMembersController } from './java-type-members-controller'
import { isPsBuildConfigurationPath, type PsLibraryController } from './ps-library-controller'
import { indexProblemFiles, findIndexedProblemFile } from './file-index'
import { isCurrentRepositoryRefresh, RepositoryPickerCoordinator } from './navigation'
import { sameFilePath } from './path-helpers'

const LAST_REPOSITORY_KEY = 'leetcoder.repository-path'

interface RepositoryControllerOptions {
  state: AppState
  backend: BackendClient
  directoryPicker: DirectoryPicker
  storage: Storage | undefined
  document: Pick<DocumentController,
    'flushPendingSave' | 'activeOpenTab' | 'resetCurrentFile' | 'reloadOpenFileFromDisk'>
  git: Pick<GitController, 'reset' | 'markStale'>
  dialogs: Pick<FileDialogController, 'closeFileContextMenu' | 'resetGitDiscardDialog'>
  search: Pick<ProjectContentSearchController, 'reset'>
  psLibrary: Pick<PsLibraryController, 'setRepository' | 'invalidate'>
  javaTypes: Pick<JavaTypeMembersController, 'setRepository' | 'invalidate'>
  isActive: () => boolean
  render: () => void
  setMessage: (message: string, tone: 'info' | 'success' | 'error') => void
}

/** Own repository selection, watcher lifetime and stale refresh guards together. */
export class RepositoryController {
  private readonly state: AppState
  private readonly backend: BackendClient
  private readonly directoryPicker: DirectoryPicker
  private readonly storage: Storage | undefined
  private readonly repositoryPicker = new RepositoryPickerCoordinator()
  private repositoryGeneration = 0
  private refreshRequestId = 0
  private visibilityRefreshPending = false
  private stopWatchingFiles: (() => void) | null = null

  constructor(private readonly options: RepositoryControllerOptions) {
    this.state = options.state
    this.backend = options.backend
    this.directoryPicker = options.directoryPicker
    this.storage = options.storage
  }

  get generation(): number {
    return this.repositoryGeneration
  }

  get pickerOpen(): boolean {
    return this.repositoryPicker.isOpen
  }

  get rememberedPath(): string | null {
    return this.storage?.getItem(LAST_REPOSITORY_KEY) ?? null
  }

  async installWatcher(): Promise<void> {
    try {
      this.stopWatchingFiles = await this.backend.onRepositoryFilesChanged(
        this.handleRepositoryFilesChanged,
      )
    } catch {
      // Without the watcher the editor still syncs on window focus.
    }
  }

  dispose(): void {
    this.stopWatchingFiles?.()
    this.stopWatchingFiles = null
    void this.backend.stopWatchingRepository().catch(() => {})
  }

  async chooseRepository(): Promise<void> {
    if (!this.options.isActive() || this.state.busy) {
      return
    }
    const selection = this.repositoryPicker.open(this.directoryPicker)
    if (!selection) {
      return
    }
    this.options.render()
    try {
      const selectedPath = await selection
      if (selectedPath) {
        await this.selectRepository(selectedPath, true)
      }
    } catch (error) {
      this.options.setMessage(errorMessage(error), 'error')
    } finally {
      if (this.options.isActive()) {
        this.options.render()
      }
    }
  }

  async selectRepository(path: string, remember: boolean): Promise<void> {
    if (!this.options.isActive() || this.state.busy) {
      return
    }
    this.options.dialogs.closeFileContextMenu()
    const switchingRepository = path !== this.state.repoPath
    if (switchingRepository) {
      this.options.search.reset()
      this.repositoryGeneration += 1
      this.refreshRequestId += 1
    }
    const selectionGeneration = this.repositoryGeneration
    this.state.busy = true
    this.options.render()
    if (path !== this.state.repoPath) {
      const saved = await this.options.document.flushPendingSave()
      if (!this.isCurrentRepositorySelection(selectionGeneration)) {
        return
      }
      if (!saved) {
        this.state.busy = false
        this.options.render()
        return
      }
    }
    if (switchingRepository) {
      // Clear the old document before loading the new repository. Relative
      // paths can be identical across repositories and must never reuse the
      // previous source, FQCN, or test output.
      void this.backend.stopWatchingRepository().catch(() => {})
      this.options.psLibrary.setRepository(null)
      this.options.javaTypes.setRepository(null)
      this.state.repoPath = null
      this.state.projectValid = false
      this.state.files = []
      this.state.openTabs = []
      this.state.fileSearch = ''
      this.state.gitContextMenu = null
      this.options.dialogs.resetGitDiscardDialog()
      this.options.git.reset()
      this.options.document.resetCurrentFile()
      this.options.search.reset()
    }
    try {
      const validation = await this.backend.validateProject(path)
      if (!this.isCurrentRepositorySelection(selectionGeneration)) {
        return
      }
      if (!validation.valid) {
        this.storage?.removeItem(LAST_REPOSITORY_KEY)
        throw new Error(validation.message ?? 'This folder does not look like the ps repository.')
      }

      this.state.repoPath = path
      this.state.projectValid = true
      if (remember) {
        this.storage?.setItem(LAST_REPOSITORY_KEY, path)
      }
      await this.refreshFiles()
      if (!this.isCurrentRepositorySelection(selectionGeneration)) {
        return
      }
      try {
        await this.backend.watchRepository(path)
        if (!this.isCurrentRepositorySelection(selectionGeneration)) {
          await this.backend.stopWatchingRepository().catch(() => {})
        }
      } catch {
        // Losing the watcher only costs live updates, not the repository.
        if (!this.isCurrentRepositorySelection(selectionGeneration)) {
          await this.backend.stopWatchingRepository().catch(() => {})
        }
      }
      if (this.isCurrentRepositorySelection(selectionGeneration)
        && this.state.projectValid
        && this.state.repoPath === path) {
        this.options.psLibrary.setRepository(path)
        this.options.javaTypes.setRepository(path)
      }
    } catch (error) {
      if (this.isCurrentRepositorySelection(selectionGeneration)) {
        this.state.projectValid = false
        this.options.psLibrary.setRepository(null)
        this.options.javaTypes.setRepository(null)
        this.options.setMessage(errorMessage(error), 'error')
      }
    } finally {
      if (this.isCurrentRepositorySelection(selectionGeneration)) {
        this.state.busy = false
        this.options.render()
      }
    }
  }

  async refreshFiles(): Promise<boolean> {
    if (!this.options.isActive() || !this.state.repoPath || !this.state.projectValid) {
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
      const filesByPath = indexProblemFiles(files)
      const missingTabs = this.state.openTabs.filter((tab) => !findIndexedProblemFile(filesByPath, tab.path))
      if (missingTabs.length > 0) {
        if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
          return false
        }
        if (!(await this.options.document.flushPendingSave())) {
          return false
        }
      }
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.state.files = files
      this.options.git.markStale()
      for (const tab of this.state.openTabs) {
        const refreshed = findIndexedProblemFile(filesByPath, tab.path)
        if (refreshed) {
          tab.path = refreshed.path
          tab.name = refreshed.name
          tab.packageSegment = refreshed.packageSegment
        }
      }
      if (missingTabs.length > 0) {
        const missingTabIds = new Set(missingTabs.map((tab) => tab.id))
        this.state.openTabs = this.state.openTabs.filter((tab) => !missingTabIds.has(tab.id))
        if (!this.options.document.activeOpenTab()) {
          this.options.document.resetCurrentFile()
        }
      }
      if (!this.options.document.activeOpenTab() && this.state.selectedPath) {
        this.options.document.resetCurrentFile()
      }
      return true
    } catch (error) {
      if (!this.isCurrentRefresh(repoPath, repositoryGeneration, requestId)) {
        return false
      }
      this.options.setMessage(`Could not list problem files: ${errorMessage(error)}`, 'error')
      return false
    } finally {
      if (this.options.isActive()) {
        this.options.render()
      }
    }
  }

  handleVisibilityReturn(): void {
    if (!this.options.isActive() || this.state.busy || this.visibilityRefreshPending) {
      return
    }
    // Reconcile structural changes missed while hidden or without a watcher.
    this.visibilityRefreshPending = true
    void this.refreshFiles().finally(() => {
      this.visibilityRefreshPending = false
    })
  }

  private isCurrentRefresh(repoPath: string, repositoryGeneration: number, requestId: number): boolean {
    return this.options.isActive() && isCurrentRepositoryRefresh(
      { repoPath, repositoryGeneration, requestId },
      {
        repoPath: this.state.repoPath,
        projectValid: this.state.projectValid,
        repositoryGeneration: this.repositoryGeneration,
        refreshRequestId: this.refreshRequestId,
      },
    )
  }

  private isCurrentRepositorySelection(repositoryGeneration: number): boolean {
    return this.options.isActive()
      && repositoryGeneration === this.repositoryGeneration
  }

  private readonly handleRepositoryFilesChanged = (change: RepositoryFilesChanged): void => {
    if (!this.options.isActive() || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    if (change.structural) {
      void this.refreshFiles()
    }
    if (change.paths.some(isPsBuildConfigurationPath)) {
      this.options.psLibrary.invalidate()
      this.options.javaTypes.invalidate()
    }
    const path = this.state.selectedPath
    if (path && change.paths.some((changed) => sameFilePath(changed, path))) {
      void this.options.document.reloadOpenFileFromDisk(path)
    }
  }
}

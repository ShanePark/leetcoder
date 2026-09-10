import type {
  BackendClient,
  DailyProblem,
  ProblemFileEntry,
} from '../backend'
import type { ProblemDefinition, ProblemFilePlan } from '../domain'
import { errorMessage } from '../backend'

import type { GitOperationToken } from './git-controller'
import {
  findFileAfterDuplicate,
  findFileAfterRename,
  findRestoredFileAfterGitRename,
  fileMutationResultPath,
  joinFilePath,
} from './file-helpers'
import { isGitNewFile } from './git-helpers'
import { gitDirectoryPath, gitFileName, fqcnFromJavaPath, sameFilePath } from './path-helpers'
import type { AppState, FileManagementBackend, GitChangedFile, OpenFileTab } from './types'

/** The part of application state needed to coordinate file mutations. */
export type FileOperationsState = Pick<
  AppState,
  | 'repoPath'
  | 'projectValid'
  | 'files'
  | 'dailyProblem'
  | 'openTabs'
  | 'activeTabId'
  | 'selectedPath'
  | 'selectedFqcn'
  | 'busy'
>

/** Backend commands used by file operations. Mutation commands remain optional
 * because older desktop builds can still be opened by the frontend. */
export interface FileOperationsBackend extends Pick<
  BackendClient,
  | 'listProblemFiles'
  | 'readProblemFile'
  | 'createProblemFile'
  | 'discardGitChanges'
  | 'showInFileManager'
> {
  deleteProblemFile?: FileManagementBackend['deleteProblemFile']
  duplicateProblemFile?: FileManagementBackend['duplicateProblemFile']
  renameProblemFile?: FileManagementBackend['renameProblemFile']
}

/** Operations that change an open document are delegated to this surface. */
export interface FileOperationsDocument {
  flushPendingSave: () => Promise<boolean>
  cancelPendingAutosave: () => void
  openTabForPath: (path: string) => OpenFileTab | null
  removeOpenTab: (tabId: number) => OpenFileTab | null
  resetCurrentFile: () => void
  openFile: (file: ProblemFileEntry) => Promise<void>
  /** Suppress autosave while a destructive Git operation is in flight. */
  beginGitDiscard: () => void
  endGitDiscard: () => void
  /** Apply source restored by Git while keeping the document bookkeeping in sync. */
  applySavedSource: (source: string) => void
}

/** The subset of GitController used by file operations. */
export interface FileOperationsGit {
  startOperation: (label?: string | null) => GitOperationToken | null
  isCurrentOperation: (token: GitOperationToken) => boolean
  finishOperation: (token: GitOperationToken) => void
  markStale: () => void
  refreshStatus: (allowBusy?: boolean) => Promise<void>
}

export type FileOperationsMessageTone = 'info' | 'success' | 'error'

export interface FileOperationsControllerHooks {
  readonly state: FileOperationsState
  readonly backend: FileOperationsBackend
  readonly document: FileOperationsDocument
  readonly git: FileOperationsGit
  /** Create a planned file using the existing conflict-retry service. */
  readonly createProblem: (repoPath: string, problem: ProblemDefinition) => Promise<ProblemFilePlan>
  readonly refreshFiles: () => Promise<boolean>
  readonly repositoryGeneration: () => number
  readonly getGitFiles: () => readonly GitChangedFile[]
  readonly setAppBusy: (busy: boolean) => void
  readonly render: () => void
  readonly setMessage: (message: string, tone: FileOperationsMessageTone) => void
  readonly isDestroyed: () => boolean
}

/** Identity guard for a file operation that may outlive a repository switch. */
export interface FileOperationToken {
  readonly id: number
  readonly repoPath: string
  readonly repositoryGeneration: number
}

/**
 * Coordinates destructive and repository file operations behind one busy
 * lock. The controller owns async identity checks while the document and app
 * shell retain editor state and dialog focus management.
 */
export class FileOperationsController {
  private operationId = 0
  private disposed = false

  constructor(private readonly hooks: FileOperationsControllerHooks) {}

  async createFileForToday(problem: DailyProblem | null = this.hooks.state.dailyProblem): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid || !problem) {
      this.hooks.setMessage('Choose a repository first', 'error')
      return
    }

    // Copy the metadata before flushing: a pending save can trigger another
    // render or selection update, but creation must use the problem the user
    // clicked.
    const snapshot: ProblemDefinition = {
      number: problem.frontendId,
      title: problem.title,
      difficulty: problem.difficulty,
      javaCodeSnippet: problem.javaSnippet,
    }
    const operation = this.startFileOperation(repoPath)
    if (!operation) {
      return
    }
    try {
      if (!(await this.hooks.document.flushPendingSave()) || !this.isCurrentFileOperation(operation)) {
        return
      }
      const plan = await this.hooks.createProblem(repoPath, snapshot)
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      this.hooks.git.markStale()
      await this.hooks.refreshFiles()
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      const createdFile = this.hooks.state.files.find((file) => file.path === plan.path) ?? {
        path: plan.path,
        name: plan.fileName,
        packageSegment: plan.packageSegment,
      }
      // Document.openFile preserves an already-held busy lock for nested opens.
      await this.hooks.document.openFile(createdFile)
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      this.hooks.setMessage(`Created ${plan.fileName}.`, 'success')
    } catch (error) {
      if (this.isCurrentFileOperation(operation)) {
        this.hooks.setMessage(`Could not create the problem file: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.finishFileOperation(operation)
    }
  }

  async deleteFile(file: ProblemFileEntry): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid) {
      return
    }
    const method = this.hooks.backend.deleteProblemFile
    if (!method) {
      this.hooks.setMessage('Not available in this build', 'error')
      return
    }
    const operation = this.startFileOperation(repoPath)
    if (!operation) {
      return
    }
    try {
      if (!(await this.hooks.document.flushPendingSave()) || !this.isCurrentFileOperation(operation)) {
        return
      }
      await method(repoPath, file.path)
      if (!this.isCurrentFileOperation(operation)) {
        return
      }

      const targetTab = this.hooks.document.openTabForPath(file.path)
      const wasActive = targetTab?.id === this.hooks.state.activeTabId
      const replacement = targetTab && wasActive
        ? this.hooks.document.removeOpenTab(targetTab.id)
        : null
      if (targetTab && !wasActive) {
        this.hooks.document.removeOpenTab(targetTab.id)
      } else if (wasActive && !targetTab) {
        this.hooks.document.resetCurrentFile()
      }
      this.hooks.git.markStale()
      await this.hooks.refreshFiles()
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      if (wasActive && replacement) {
        const replacementFile = this.hooks.state.files.find((entry) => sameFilePath(entry.path, replacement.path))
        if (replacementFile) {
          await this.hooks.document.openFile(replacementFile)
        }
      }
      this.hooks.setMessage(`Deleted ${file.name}.`, 'success')
    } catch (error) {
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      // A backend can report an error after changing the filesystem. Refresh
      // before showing the error so the explorer reflects that mutation.
      await this.hooks.refreshFiles()
      if (this.isCurrentFileOperation(operation)) {
        this.hooks.setMessage(`Could not delete ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.finishFileOperation(operation)
    }
  }

  async duplicateFile(file: ProblemFileEntry): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid) {
      return
    }
    const method = this.hooks.backend.duplicateProblemFile
    if (!method) {
      this.hooks.setMessage('Not available in this build', 'error')
      return
    }
    const existingPaths = new Set(this.hooks.state.files.map((entry) => entry.path))
    const operation = this.startFileOperation(repoPath)
    if (!operation) {
      return
    }
    try {
      if (!(await this.hooks.document.flushPendingSave()) || !this.isCurrentFileOperation(operation)) {
        return
      }
      const result = await method(repoPath, file.path)
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      this.hooks.git.markStale()
      if (!(await this.hooks.refreshFiles()) || !this.isCurrentFileOperation(operation)) {
        return
      }
      const duplicate = findFileAfterDuplicate(
        this.hooks.state.files,
        existingPaths,
        file,
        result,
      )
      if (duplicate) {
        await this.hooks.document.openFile(duplicate)
        if (!this.isCurrentFileOperation(operation)) {
          return
        }
      }
      this.hooks.setMessage(
        duplicate ? `Duplicated ${file.name} as ${duplicate.name}.` : `Duplicated ${file.name}.`,
        'success',
      )
    } catch (error) {
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      await this.hooks.refreshFiles()
      if (this.isCurrentFileOperation(operation)) {
        this.hooks.setMessage(`Could not duplicate ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.finishFileOperation(operation)
    }
  }

  async renameFile(file: ProblemFileEntry, newName: string): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid) {
      return
    }
    const method = this.hooks.backend.renameProblemFile
    if (!method) {
      this.hooks.setMessage('Not available in this build', 'error')
      return
    }
    if (newName === file.name) {
      return
    }
    const targetTab = this.hooks.document.openTabForPath(file.path)
    const wasSelected = targetTab?.id === this.hooks.state.activeTabId
    const existingPaths = new Set(this.hooks.state.files.map((entry) => entry.path))
    const requestedPath = joinFilePath(gitDirectoryPath(file.path), newName)
    if (existingPaths.has(requestedPath) && !sameFilePath(requestedPath, file.path)) {
      this.hooks.setMessage(`A file named ${newName} already exists.`, 'error')
      return
    }
    const operation = this.startFileOperation(repoPath)
    if (!operation) {
      return
    }
    try {
      if (!(await this.hooks.document.flushPendingSave()) || !this.isCurrentFileOperation(operation)) {
        return
      }
      const result = await method(repoPath, file.path, newName)
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      const requestedRenamedPath = fileMutationResultPath(result, file.path) ?? requestedPath
      if (targetTab) {
        targetTab.path = requestedRenamedPath
        targetTab.name = newName
        targetTab.packageSegment = file.packageSegment
      }
      this.hooks.git.markStale()
      const refreshed = await this.hooks.refreshFiles()
      if (!refreshed || !this.isCurrentFileOperation(operation)) {
        if (targetTab && !refreshed) {
          targetTab.path = file.path
          targetTab.name = file.name
          targetTab.packageSegment = file.packageSegment
        }
        return
      }
      const renamed = findFileAfterRename(this.hooks.state.files, file, newName, result)
      if (targetTab && renamed) {
        targetTab.path = renamed.path
        targetTab.name = renamed.name
        targetTab.packageSegment = renamed.packageSegment
      }
      if (wasSelected && renamed) {
        await this.hooks.document.openFile(renamed)
      }
      this.hooks.setMessage(`Renamed ${file.name} to ${renamed?.name ?? newName}.`, 'success')
    } catch (error) {
      if (!this.isCurrentFileOperation(operation)) {
        return
      }
      await this.hooks.refreshFiles()
      if (this.isCurrentFileOperation(operation)) {
        this.hooks.setMessage(`Could not rename ${file.name}: ${errorMessage(error)}`, 'error')
      }
    } finally {
      this.finishFileOperation(operation)
    }
  }

  async showGitFileInManager(filePath: string): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid) {
      return
    }
    const method = this.hooks.backend.showInFileManager
    if (!method) {
      this.hooks.setMessage('Not available in this build', 'error')
      return
    }
    const operation = this.hooks.git.startOperation('Opening in File Manager…')
    if (!operation) {
      return
    }
    this.hooks.render()
    try {
      await method(repoPath, filePath)
      if (this.hooks.git.isCurrentOperation(operation)) {
        this.hooks.setMessage(`Opened ${gitFileName(filePath)} in File Manager.`, 'success')
      }
    } catch (error) {
      if (this.hooks.git.isCurrentOperation(operation)) {
        this.hooks.setMessage(
          `Could not show ${gitFileName(filePath)} in File Manager: ${errorMessage(error)}`,
          'error',
        )
      }
    } finally {
      this.hooks.git.finishOperation(operation)
    }
  }

  async discardGitChanges(file: GitChangedFile): Promise<void> {
    if (!this.isActive() || this.hooks.state.busy) {
      return
    }
    const repoPath = this.hooks.state.repoPath
    if (!repoPath || !this.hooks.state.projectValid) {
      return
    }
    if (!this.hooks.getGitFiles().some((entry) => sameFilePath(entry.path, file.path))) {
      this.hooks.setMessage(`The Git change for ${gitFileName(file.path)} is no longer available.`, 'info')
      return
    }
    const method = this.hooks.backend.discardGitChanges
    if (!method) {
      this.hooks.setMessage('Not available in this build', 'error')
      return
    }

    const targetTab = this.hooks.document.openTabForPath(file.path)
    const targetTabIndex = targetTab ? this.hooks.state.openTabs.indexOf(targetTab) : -1
    const wasActive = targetTab?.id === this.hooks.state.activeTabId
    const wasSelected = sameFilePath(this.hooks.state.selectedPath ?? '', file.path)
    const removesFile = isGitNewFile(file.status)
    const restoredPath = file.originalPath && !sameFilePath(file.originalPath, file.path)
      ? file.originalPath
      : null
    const operation = this.hooks.git.startOperation('Discarding changes…')
    if (!operation) {
      return
    }
    this.hooks.document.beginGitDiscard()
    this.hooks.render()
    try {
      // Flush first so discard always starts from a stable on-disk snapshot.
      if (!(await this.hooks.document.flushPendingSave())
        || !this.hooks.git.isCurrentOperation(operation)) {
        return
      }
      // Do not allow a queued pre-discard source to be written back after Git
      // restores the file. Editor changes remain visible while this awaits.
      this.hooks.document.cancelPendingAutosave()
      await method(repoPath, file.path)
      if (!this.hooks.git.isCurrentOperation(operation)) {
        return
      }

      let replacement: OpenFileTab | null = null
      if (removesFile && targetTab) {
        if (wasActive) {
          replacement = this.hooks.document.removeOpenTab(targetTab.id)
        } else {
          this.hooks.document.removeOpenTab(targetTab.id)
        }
      } else if (removesFile && wasSelected) {
        this.hooks.document.resetCurrentFile()
      }

      if (!removesFile && wasSelected && !restoredPath) {
        const source = await this.hooks.backend.readProblemFile(repoPath, file.path)
        if (!this.hooks.git.isCurrentOperation(operation)) {
          return
        }
        this.hooks.document.applySavedSource(source)
      }

      this.hooks.git.markStale()
      await this.hooks.refreshFiles()
      if (!this.hooks.git.isCurrentOperation(operation)) {
        return
      }

      let restoredRename: ProblemFileEntry | null = null
      if (restoredPath && !this.hooks.state.files.some((entry) => sameFilePath(entry.path, file.path))) {
        restoredRename = findRestoredFileAfterGitRename(this.hooks.state.files, file)
        if (restoredRename && targetTab) {
          targetTab.path = restoredRename.path
          targetTab.name = restoredRename.name
          targetTab.packageSegment = restoredRename.packageSegment
          if (!this.hooks.state.openTabs.includes(targetTab)) {
            const insertionIndex = targetTabIndex < 0
              ? this.hooks.state.openTabs.length
              : Math.min(targetTabIndex, this.hooks.state.openTabs.length)
            this.hooks.state.openTabs.splice(insertionIndex, 0, targetTab)
          }
          if (wasActive) {
            this.hooks.state.activeTabId = targetTab.id
          }
        }
      }
      if (restoredRename && wasSelected) {
        this.hooks.state.selectedPath = restoredRename.path
        this.hooks.state.selectedFqcn = fqcnFromJavaPath(restoredRename.path)
        const source = await this.hooks.backend.readProblemFile(repoPath, restoredRename.path)
        if (!this.hooks.git.isCurrentOperation(operation)) {
          return
        }
        this.hooks.document.applySavedSource(source)
      }

      await this.hooks.git.refreshStatus(true)
      if (!this.hooks.git.isCurrentOperation(operation)) {
        return
      }
      if (wasActive && replacement) {
        const replacementFile = this.hooks.state.files.find((entry) => sameFilePath(entry.path, replacement!.path))
        if (replacementFile) {
          await this.hooks.document.openFile(replacementFile)
        }
      }
      this.hooks.setMessage(`Discarded changes to ${gitFileName(file.path)}.`, 'success')
    } catch (error) {
      if (this.hooks.git.isCurrentOperation(operation)) {
        // A Git command may mutate the worktree before surfacing an error.
        await this.hooks.refreshFiles()
        await this.hooks.git.refreshStatus(true)
        if (this.hooks.git.isCurrentOperation(operation)) {
          this.hooks.setMessage(`Could not discard changes to ${gitFileName(file.path)}: ${errorMessage(error)}`, 'error')
        }
      }
    } finally {
      this.hooks.document.endGitDiscard()
      this.hooks.git.finishOperation(operation)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.operationId += 1
  }

  private startFileOperation(repoPath: string): FileOperationToken | null {
    if (!this.isActive() || this.hooks.state.busy) {
      return null
    }
    const operation: FileOperationToken = {
      id: ++this.operationId,
      repoPath,
      repositoryGeneration: this.hooks.repositoryGeneration(),
    }
    this.hooks.setAppBusy(true)
    this.hooks.render()
    return operation
  }

  private finishFileOperation(operation: FileOperationToken): void {
    if (!this.isCurrentFileOperation(operation)) {
      return
    }
    this.hooks.setAppBusy(false)
    this.hooks.render()
  }

  private isCurrentFileOperation(operation: FileOperationToken): boolean {
    return this.isActive()
      && this.hooks.state.projectValid
      && this.hooks.state.repoPath === operation.repoPath
      && this.hooks.repositoryGeneration() === operation.repositoryGeneration
      && this.operationId === operation.id
  }

  private isActive(): boolean {
    return !this.disposed && !this.hooks.isDestroyed()
  }
}

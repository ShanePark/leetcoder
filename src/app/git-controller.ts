import { errorMessage, type GitPushResult } from '../backend'

import {
  asGitCommitResult,
  asGitPushResult,
  defaultGitCommitMessage,
  gitResultToastMessage,
  normalizeGitDiff,
  normalizeGitStatus,
} from './git-helpers'
import type { GitBackendClient, GitState } from './types'

const GIT_REFRESH_DEBOUNCE_MS = 250
const GIT_POLL_INTERVAL_MS = 4000

export type GitMessageTone = 'info' | 'success' | 'error'

/** The repository identity used to reject responses from an older selection. */
export interface GitRepositoryContext {
  repoPath: string | null
  projectValid: boolean
  repositoryGeneration: number
  appBusy: boolean
}

/** Narrow application hooks used by Git without coupling it to the DOM. */
export interface GitControllerHooks {
  getContext: () => GitRepositoryContext
  flushPendingSave: () => Promise<boolean>
  setAppBusy: (busy: boolean) => void
  render: () => void
  renderPanel: () => void
  isGitPanelVisible: () => boolean
  isWindowVisible: () => boolean
  isDestroyed: () => boolean
  setMessage: (message: string, tone: GitMessageTone) => void
}

/** A token shared with app-level Git operations such as discard. */
export interface GitOperationToken {
  readonly id: number
  readonly repoPath: string
  readonly repositoryGeneration: number
}

export interface GitStatusRequestToken {
  readonly id: number
  readonly repoPath: string
  readonly repositoryGeneration: number
}

/** Keep the mutable app state shape stable while giving Git one owner. */
export function createGitState(): GitState {
  return {
    branch: null,
    files: [],
    selectedPaths: [],
    activePath: null,
    diffByPath: {},
    fallbackDiff: '',
    loading: false,
    diffLoading: false,
    busy: false,
    error: null,
    commitMessage: '',
    commitMessageEdited: false,
    loadedRepoPath: null,
    stale: false,
  }
}

/**
 * Own Git requests and mutations while leaving repository/file orchestration
 * to the application controller.
 *
 * The controller deliberately receives callbacks for persistence and repaint.
 * It can therefore be tested without constructing the full desktop DOM, and
 * stale async responses can be rejected using one consistent identity check.
 */
export class GitController {
  readonly state: GitState

  private readonly backend: GitBackendClient
  private readonly hooks: GitControllerHooks
  private statusRequestId = 0
  private diffRequestId = 0
  private operationId = 0
  private operationLabel: string | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDiffPath: string | null = null
  private disposed = false

  constructor(
    backend: GitBackendClient,
    hooks: GitControllerHooks,
    state: GitState = createGitState(),
  ) {
    this.backend = backend
    this.hooks = hooks
    this.state = state
  }

  get progressLabel(): string | null {
    return this.operationLabel
  }

  /** Invalidate all work tied to the previous repository and clear its view. */
  reset(): void {
    if (this.disposed) {
      return
    }
    this.clearScheduledRefresh()
    this.statusRequestId += 1
    this.diffRequestId += 1
    this.operationId += 1
    this.operationLabel = null
    this.pendingDiffPath = null
    Object.assign(this.state, createGitState())
  }

  /** Stop timers and reject any late response after the app is destroyed. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearScheduledRefresh()
    this.statusRequestId += 1
    this.diffRequestId += 1
    this.operationId += 1
    this.operationLabel = null
    this.pendingDiffPath = null
  }

  /** Mark the status snapshot stale after a file-system mutation. */
  markStale(): void {
    if (!this.isAlive()) {
      return
    }
    this.statusRequestId += 1
    this.diffRequestId += 1
    this.clearScheduledRefresh()
    this.state.stale = true
    this.state.loading = false
    this.state.diffLoading = false
    if (this.hooks.isGitPanelVisible()) {
      this.hooks.renderPanel()
      this.scheduleRefreshIfNeeded()
    }
  }

  scheduleRefreshIfNeeded(): void {
    if (!this.isAlive()) {
      return
    }
    const context = this.hooks.getContext()
    if (this.refreshTimer !== null
      || !this.hooks.isGitPanelVisible()
      || !context.repoPath
      || !context.projectValid
      || !this.hooks.isWindowVisible()
      || context.appBusy
      || this.state.busy
      || this.state.loading) {
      return
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (!this.isAlive()) {
        return
      }
      const current = this.hooks.getContext()
      if (!this.hooks.isGitPanelVisible()
        || !current.repoPath
        || !current.projectValid
        || !this.hooks.isWindowVisible()
        || current.appBusy
        || this.state.busy
        || this.state.loading) {
        this.scheduleRefreshIfNeeded()
        return
      }
      // Consume this marker before the request. A regular poll is still
      // scheduled after an error; request guards protect newer state.
      this.state.stale = false
      void this.refreshStatus()
    }, this.state.stale ? GIT_REFRESH_DEBOUNCE_MS : GIT_POLL_INTERVAL_MS)
  }

  clearScheduledRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  handleVisibilityReturn(): void {
    const context = this.hooks.getContext()
    if (!this.hooks.isWindowVisible()
      || !this.isAlive()
      || !this.hooks.isGitPanelVisible()
      || !context.projectValid
      || !context.repoPath
      || context.appBusy
      || this.state.busy
      || this.state.loading) {
      return
    }
    this.clearScheduledRefresh()
    void this.refreshStatus()
  }

  async refreshStatus(allowBusy = false): Promise<void> {
    if (!this.isAlive()) {
      return
    }
    const context = this.hooks.getContext()
    const repoPath = context.repoPath
    if (!repoPath || !context.projectValid) {
      this.state.error = 'Choose a repository first'
      this.hooks.renderPanel()
      return
    }
    if ((!allowBusy && context.appBusy) || this.state.loading) {
      return
    }
    this.clearScheduledRefresh()
    const method = this.backend.getGitStatus ?? this.backend.listGitChanges
    if (!method) {
      this.state.error = 'Not available in this build'
      this.state.loadedRepoPath = repoPath
      this.hooks.renderPanel()
      return
    }
    const previousPaths = [...this.state.selectedPaths]
    const repositoryGeneration = context.repositoryGeneration
    const requestId = ++this.statusRequestId
    this.pendingDiffPath = null
    this.state.loading = true
    this.state.stale = false
    this.state.error = null
    this.hooks.renderPanel()
    try {
      const snapshot = normalizeGitStatus(await method(repoPath))
      if (!this.isCurrentStatusRequest({ id: requestId, repoPath, repositoryGeneration })) {
        return
      }
      const availablePaths = new Set(snapshot.files.map((file) => file.path))
      const preserveSelection = this.state.loadedRepoPath === repoPath
      const selectedPaths = preserveSelection
        ? previousPaths.filter((path) => availablePaths.has(path))
        : snapshot.files.map((file) => file.path)
      this.state.branch = snapshot.branch
      this.state.files = snapshot.files
      this.state.selectedPaths = selectedPaths
      this.state.activePath = snapshot.files.some((file) => file.path === this.state.activePath)
        ? this.state.activePath
        : snapshot.files[0]?.path ?? null
      this.state.diffByPath = {}
      this.state.fallbackDiff = ''
      this.state.loadedRepoPath = repoPath
      const activePath = this.state.activePath
      await this.loadDiff(
        repoPath,
        activePath ? [activePath] : [],
        { id: requestId, repoPath, repositoryGeneration },
      )
      if (!this.isCurrentStatusRequest({ id: requestId, repoPath, repositoryGeneration })) {
        return
      }
      this.state.stale = false
    } catch (error) {
      if (!this.isCurrentStatusRequest({ id: requestId, repoPath, repositoryGeneration })) {
        return
      }
      this.state.error = errorMessage(error)
    } finally {
      if (this.isCurrentStatusRequest({ id: requestId, repoPath, repositoryGeneration })) {
        this.state.loading = false
        this.hooks.render()
      }
    }
  }

  async loadDiff(
    repoPath: string,
    paths: string[],
    statusToken: GitStatusRequestToken = this.currentStatusToken(repoPath),
  ): Promise<void> {
    if (paths.length === 0) {
      if (this.isCurrentStatusRequest(statusToken)) {
        this.state.diffLoading = false
      }
      return
    }
    const method = this.backend.getGitDiff
    if (!method) {
      if (this.isCurrentStatusRequest(statusToken)) {
        this.state.error = 'Not available in this build'
        this.state.diffLoading = false
      }
      return
    }
    const diffRequestId = ++this.diffRequestId
    this.state.diffLoading = true
    this.hooks.renderPanel()
    try {
      const normalized = normalizeGitDiff(await method(repoPath, paths), paths)
      if (!this.isCurrentDiffRequest(statusToken, diffRequestId)) {
        return
      }
      this.state.diffByPath = { ...this.state.diffByPath, ...normalized }
      if (!this.state.activePath && paths[0]) {
        this.state.activePath = paths[0]
      }
    } catch (error) {
      if (!this.isCurrentDiffRequest(statusToken, diffRequestId)) {
        return
      }
      this.state.error = errorMessage(error)
    } finally {
      if (this.isCurrentDiffRequest(statusToken, diffRequestId)) {
        this.state.diffLoading = false
        this.hooks.renderPanel()
        const nextPath = this.pendingDiffPath
        if (nextPath
          && this.state.activePath === nextPath
          && !this.state.diffByPath[nextPath]
          && this.hooks.getContext().repoPath === repoPath
          && this.hooks.getContext().projectValid) {
          this.pendingDiffPath = null
          void this.loadDiff(repoPath, [nextPath], statusToken)
        }
      }
    }
  }

  setActiveFile(path: string): void {
    if (!this.isAlive()) {
      return
    }
    const context = this.hooks.getContext()
    if (context.appBusy || this.state.busy || !this.state.files.some((file) => file.path === path)) {
      return
    }
    this.state.activePath = path
    this.hooks.renderPanel()
    if (this.state.diffByPath[path]) {
      this.pendingDiffPath = null
      return
    }
    if (this.state.diffLoading) {
      this.pendingDiffPath = path
      return
    }
    if (context.repoPath) {
      void this.loadDiff(context.repoPath, [path])
    }
  }

  updateSelection(paths: string[]): void {
    if (!this.isAlive()) {
      return
    }
    const context = this.hooks.getContext()
    if (context.appBusy || this.state.busy) {
      return
    }
    this.state.selectedPaths = [...new Set(paths)]
    this.state.error = null
    this.hooks.renderPanel()
  }

  toggleFile(path: string, selected: boolean): void {
    const paths = selected
      ? [...this.state.selectedPaths, path]
      : this.state.selectedPaths.filter((entry) => entry !== path)
    this.updateSelection(paths)
  }

  selectAllFiles(): void {
    this.updateSelection(this.state.files.map((file) => file.path))
  }

  selectNoFiles(): void {
    this.updateSelection([])
  }

  /** Start an app-level Git operation and return the identity guard for it. */
  startOperation(label: string | null = null): GitOperationToken | null {
    if (!this.isAlive()) {
      return null
    }
    const context = this.hooks.getContext()
    if (!context.repoPath || !context.projectValid || context.appBusy || this.state.busy) {
      return null
    }
    const token: GitOperationToken = {
      id: ++this.operationId,
      repoPath: context.repoPath,
      repositoryGeneration: context.repositoryGeneration,
    }
    this.state.busy = true
    this.state.error = null
    this.operationLabel = label
    this.hooks.setAppBusy(true)
    return token
  }

  setOperationLabel(token: GitOperationToken, label: string | null): boolean {
    if (!this.isCurrentOperation(token)) {
      return false
    }
    this.operationLabel = label
    return true
  }

  finishOperation(token: GitOperationToken): void {
    if (!this.isCurrentOperation(token)) {
      return
    }
    this.operationLabel = null
    this.state.busy = false
    this.hooks.setAppBusy(false)
    this.hooks.render()
  }

  isCurrentOperation(token: GitOperationToken): boolean {
    const context = this.hooks.getContext()
    return this.isAlive()
      && context.projectValid
      && context.repoPath === token.repoPath
      && context.repositoryGeneration === token.repositoryGeneration
      && this.operationId === token.id
  }

  isCurrentStatusRequest(token: GitStatusRequestToken): boolean {
    const context = this.hooks.getContext()
    return this.isAlive()
      && context.projectValid
      && context.repoPath === token.repoPath
      && context.repositoryGeneration === token.repositoryGeneration
      && this.statusRequestId === token.id
  }

  async commitSelectedFiles(pushAfterCommit: boolean): Promise<void> {
    const context = this.hooks.getContext()
    const repoPath = context.repoPath
    const paths = [...this.state.selectedPaths]
    if (!repoPath || !context.projectValid) {
      this.state.error = 'Choose a repository first'
      this.hooks.renderPanel()
      return
    }
    if (paths.length === 0) {
      this.state.error = 'Select at least one file to commit'
      this.hooks.renderPanel()
      return
    }
    const method = this.backend.commitGitChanges ?? this.backend.commitGit
    if (!method) {
      this.state.error = 'Not available in this build'
      this.hooks.renderPanel()
      return
    }
    const pushMethod = this.backend.pushGit
    if (pushAfterCommit && !pushMethod) {
      this.state.error = 'Not available in this build'
      this.hooks.renderPanel()
      return
    }
    const selectedPathSet = new Set(paths)
    const selectedFiles = this.state.files.filter((file) => selectedPathSet.has(file.path))
    const message = this.state.commitMessage.trim() || defaultGitCommitMessage(selectedFiles)
    const token = this.startOperation(pushAfterCommit ? 'Preparing commit and push…' : 'Preparing commit…')
    if (!token) {
      return
    }
    this.hooks.render()
    let committed = false
    try {
      if (!(await this.hooks.flushPendingSave()) || !this.isCurrentOperation(token)) {
        return
      }
      this.setOperationLabel(token, 'Committing changes…')
      this.hooks.renderPanel()
      const commitResult = asGitCommitResult(await method(repoPath, paths, message))
      if (!this.isCurrentOperation(token)) {
        return
      }
      committed = true
      let pushResult: GitPushResult | null = null
      if (pushAfterCommit && pushMethod) {
        this.setOperationLabel(token, 'Pushing changes…')
        this.hooks.renderPanel()
        pushResult = asGitPushResult(await pushMethod(repoPath))
      }
      if (!this.isCurrentOperation(token)) {
        return
      }
      this.state.commitMessage = ''
      this.state.commitMessageEdited = false
      this.setOperationLabel(token, 'Refreshing Git status…')
      this.hooks.renderPanel()
      await this.refreshStatus(true)
      if (!this.isCurrentOperation(token)) {
        return
      }
      this.hooks.setMessage(
        gitResultToastMessage(paths.length, pushAfterCommit, commitResult, pushResult),
        'success',
      )
    } catch (error) {
      if (!this.isCurrentOperation(token)) {
        return
      }
      const failure = errorMessage(error)
      // Git may have changed the worktree before reporting an error. Refresh
      // first so the visible status reflects the actual repository state.
      await this.refreshStatus(true)
      if (!this.isCurrentOperation(token)) {
        return
      }
      this.state.error = failure
      this.hooks.setMessage(
        committed && pushAfterCommit
          ? `Committed, but could not push: ${this.state.error}`
          : `Could not commit changes: ${this.state.error}`,
        'error',
      )
    } finally {
      this.finishOperation(token)
    }
  }

  private currentStatusToken(repoPath: string): GitStatusRequestToken {
    const context = this.hooks.getContext()
    return {
      id: this.statusRequestId,
      repoPath,
      repositoryGeneration: context.repositoryGeneration,
    }
  }

  private isAlive(): boolean {
    return !this.disposed && !this.hooks.isDestroyed()
  }

  private isCurrentDiffRequest(
    statusToken: GitStatusRequestToken,
    diffRequestId: number,
  ): boolean {
    return this.isCurrentStatusRequest(statusToken) && this.diffRequestId === diffRequestId
  }
}

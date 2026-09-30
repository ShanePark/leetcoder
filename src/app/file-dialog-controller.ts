import type { ProblemFileEntry } from '../backend'
import type { AppState, GitChangedFile } from './types'
import type { FileOperationsController } from './file-operations-controller'
import { joinFilePath, normalizeJavaFileName } from './file-helpers'
import { gitDirectoryPath, sameFilePath } from './path-helpers'
import {
  renderDeleteFileDialog as renderDeleteFileDialogView,
  renderDiscardGitDialog as renderDiscardGitDialogView,
  renderFileContextMenu as renderFileContextMenuView,
  renderGitContextMenu as renderGitContextMenuView,
} from './dialogs-view'

export type FileDialogState = Pick<AppState,
  'repoPath' | 'projectValid' | 'busy' | 'files' | 'contextMenu' | 'gitContextMenu' | 'git'>

interface FileDialogControllerOptions {
  root: HTMLElement
  state: FileDialogState
  operations: Pick<FileOperationsController,
    'showGitFileInManager' | 'discardGitChanges' | 'deleteFile' | 'duplicateFile' | 'renameFile'>
  setMessage: (message: string, tone: 'info' | 'success' | 'error') => void
}

/** Own file menus and confirmation/focus state; mutations stay with file operations. */
export class FileDialogController {
  private readonly root: HTMLElement
  private readonly state: FileDialogState
  private readonly listeners: Array<() => void> = []
  private gitDiscardDialogFile: GitChangedFile | null = null
  private gitDiscardDialogFocusTarget: HTMLElement | null = null
  private deleteDialogFile: ProblemFileEntry | null = null
  private deleteDialogFocusTarget: HTMLElement | null = null
  private renameTargetFile: ProblemFileEntry | null = null

  constructor(private readonly options: FileDialogControllerOptions) {
    this.root = options.root
    this.state = options.state
  }

  bindEvents(): void {
    this.listen(this.element<HTMLButtonElement>('#delete-file-action'), 'click', () => {
      this.openDeleteFileDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#git-discard-action'), 'click', () => {
      this.openDiscardGitDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#git-show-file-action'), 'click', () => {
      void this.showGitFileInManager()
    })
    this.listen(this.element<HTMLButtonElement>('#duplicate-file-action'), 'click', () => {
      void this.duplicateContextMenuFile()
    })
    this.listen(this.element<HTMLButtonElement>('#rename-file-action'), 'click', () => {
      this.openRenameDialog()
    })
    this.listen(this.element<HTMLFormElement>('#rename-file-form'), 'submit', (event) => {
      event.preventDefault()
      void this.renameDialogFile()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-rename-file'), 'click', () => {
      this.closeRenameDialog()
    })
    this.listen(this.element<HTMLElement>('#rename-file-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeRenameDialog()
      }
    })
    this.listen(this.element<HTMLFormElement>('#discard-git-form'), 'submit', (event) => {
      event.preventDefault()
      this.confirmDiscardGitDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-discard-git'), 'click', () => {
      this.closeDiscardGitDialog()
    })
    this.listen(this.element<HTMLElement>('#discard-git-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDiscardGitDialog()
      }
    })
    this.listen(this.element<HTMLFormElement>('#delete-file-form'), 'submit', (event) => {
      event.preventDefault()
      this.confirmDeleteFileDialog()
    })
    this.listen(this.element<HTMLButtonElement>('#cancel-delete-file'), 'click', () => {
      this.closeDeleteFileDialog()
    })
    this.listen(this.element<HTMLElement>('#delete-file-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeDeleteFileDialog()
      }
    })
  }

  dispose(): void {
    for (const remove of this.listeners.splice(0)) remove()
  }

  resetGitDiscardDialog(): void {
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
  }

  handleOutsidePointerDown(event: PointerEvent): void {
    const fileMenu = this.root.querySelector<HTMLElement>('#file-context-menu')
    const gitMenu = this.root.querySelector<HTMLElement>('#git-context-menu')
    const target = event.target instanceof Node ? event.target : null
    const insideFileMenu = Boolean(fileMenu && !fileMenu.hidden && target && fileMenu.contains(target))
    const insideGitMenu = Boolean(gitMenu && !gitMenu.hidden && target && gitMenu.contains(target))
    if (!insideFileMenu && !insideGitMenu) {
      this.closeFileContextMenu()
      this.closeGitContextMenu()
    }
  }

  handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (this.gitDiscardDialogFile) {
      event.preventDefault()
      this.closeDiscardGitDialog()
    } else if (this.deleteDialogFile) {
      event.preventDefault()
      this.closeDeleteFileDialog()
    } else if (this.renameTargetFile) {
      event.preventDefault()
      this.closeRenameDialog()
    } else if (this.state.gitContextMenu) {
      event.preventDefault()
      this.closeGitContextMenu()
    } else if (this.state.contextMenu) {
      event.preventDefault()
      this.closeFileContextMenu()
    }
  }

  openFileContextMenu(file: ProblemFileEntry, x: number, y: number): void {
    if (this.state.busy || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    this.closeGitContextMenu()
    this.state.contextMenu = {
      file,
      x,
      y,
    }
    this.renderContextMenu()
    this.element<HTMLButtonElement>('#duplicate-file-action').focus()
  }

  closeFileContextMenu(): void {
    if (!this.state.contextMenu) {
      return
    }
    this.state.contextMenu = null
    this.renderContextMenu()
  }

  openGitContextMenu(file: GitChangedFile, x: number, y: number): void {
    if (this.state.busy || this.state.git.busy || !this.state.repoPath || !this.state.projectValid) {
      return
    }
    this.closeFileContextMenu()
    this.state.gitContextMenu = {
      file,
      x,
      y,
    }
    this.renderGitContextMenu()
    this.element<HTMLButtonElement>('#git-discard-action').focus()
  }

  closeGitContextMenu(): void {
    if (!this.state.gitContextMenu) {
      return
    }
    this.state.gitContextMenu = null
    this.renderGitContextMenu()
  }

  private findGitFileFocusTarget(path: string): HTMLElement | null {
    const row = Array.from(this.root.querySelectorAll<HTMLElement>('#git-file-list .git-file-row'))
      .find((entry) => entry.title === path)
    return row?.querySelector<HTMLElement>('.git-file-button')
      ?? this.element<HTMLButtonElement>('#git-tab')
  }

  private restoreGitDiscardFocus(target: HTMLElement | null): void {
    if (target && target.isConnected && !target.closest('[hidden]')
      && (!(target instanceof HTMLButtonElement) || !target.disabled)) {
      target.focus()
      return
    }
    this.element<HTMLButtonElement>('#git-tab').focus()
  }

  private openDiscardGitDialog(): void {
    const context = this.state.gitContextMenu
    if (!context || !this.state.repoPath || !this.state.projectValid || this.state.busy || this.state.git.busy) {
      return
    }
    this.gitDiscardDialogFocusTarget = this.findGitFileFocusTarget(context.file.path)
    this.closeGitContextMenu()
    this.gitDiscardDialogFile = context.file
    this.renderDiscardGitDialog()
    queueMicrotask(() => {
      if (this.gitDiscardDialogFile === context.file) {
        this.element<HTMLButtonElement>('#cancel-discard-git').focus()
      }
    })
  }

  private closeDiscardGitDialog(): void {
    if (!this.gitDiscardDialogFile) {
      return
    }
    const focusTarget = this.gitDiscardDialogFocusTarget
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
    this.renderDiscardGitDialog()
    this.restoreGitDiscardFocus(focusTarget)
  }

  private confirmDiscardGitDialog(): void {
    const file = this.gitDiscardDialogFile
    if (!file || this.state.busy || this.state.git.busy) {
      return
    }
    const focusTarget = this.gitDiscardDialogFocusTarget
    this.gitDiscardDialogFile = null
    this.gitDiscardDialogFocusTarget = null
    this.renderDiscardGitDialog()
    void this.discardGitChangesAfterConfirmation(file, focusTarget)
  }

  renderDiscardGitDialog(): void {
    renderDiscardGitDialogView(this.root, {
      file: this.gitDiscardDialogFile,
      busy: this.state.busy,
      gitBusy: this.state.git.busy,
    })
  }

  private openDeleteFileDialog(): void {
    const context = this.state.contextMenu
    if (!context || !this.state.repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    this.deleteDialogFocusTarget = Array.from(this.root.querySelectorAll<HTMLElement>('.file-item'))
      .find((item) => sameFilePath(item.dataset.path ?? '', context.file.path))
      ?? null
    this.closeFileContextMenu()
    this.deleteDialogFile = context.file
    this.renderDeleteFileDialog()
    queueMicrotask(() => {
      if (this.deleteDialogFile === context.file) {
        this.element<HTMLButtonElement>('#cancel-delete-file').focus()
      }
    })
  }

  private closeDeleteFileDialog(): void {
    if (!this.deleteDialogFile) {
      return
    }
    const focusTarget = this.deleteDialogFocusTarget
    this.deleteDialogFile = null
    this.deleteDialogFocusTarget = null
    this.renderDeleteFileDialog()
    if (focusTarget?.isConnected && !focusTarget.closest('[hidden]')) {
      focusTarget.focus()
    } else {
      this.element<HTMLInputElement>('#file-search').focus()
    }
  }

  private confirmDeleteFileDialog(): void {
    const file = this.deleteDialogFile
    if (!file || this.state.busy) {
      return
    }
    this.deleteDialogFile = null
    this.deleteDialogFocusTarget = null
    this.renderDeleteFileDialog()
    void this.deleteFileAfterConfirmation(file)
  }

  renderDeleteFileDialog(): void {
    renderDeleteFileDialogView(this.root, {
      file: this.deleteDialogFile,
      busy: this.state.busy,
    })
  }

  renderContextMenu(): void {
    renderFileContextMenuView(this.root, {
      context: this.state.contextMenu,
      busy: this.state.busy,
    })
  }

  renderGitContextMenu(): void {
    renderGitContextMenuView(this.root, {
      context: this.state.gitContextMenu,
      files: this.state.git.files,
      busy: this.state.busy,
      gitBusy: this.state.git.busy,
      loading: this.state.git.loading,
    })
  }

  private async showGitFileInManager(): Promise<void> {
    const context = this.state.gitContextMenu
    if (!context || this.state.busy || this.state.git.busy) {
      return
    }
    this.closeGitContextMenu()
    return this.options.operations.showGitFileInManager(context.file.path)
  }

  private async discardGitChangesAfterConfirmation(
    file: GitChangedFile,
    focusTarget: HTMLElement | null,
  ): Promise<void> {
    try {
      await this.options.operations.discardGitChanges(file)
    } finally {
      this.restoreGitDiscardFocus(focusTarget)
    }
  }

  private async deleteFileAfterConfirmation(file: ProblemFileEntry): Promise<void> {
    await this.options.operations.deleteFile(file)
  }

  private async duplicateContextMenuFile(): Promise<void> {
    const context = this.state.contextMenu
    if (!context || this.state.busy) {
      return
    }
    const file = context.file
    this.closeFileContextMenu()
    await this.options.operations.duplicateFile(file)
  }

  private openRenameDialog(): void {
    const context = this.state.contextMenu
    if (!context || this.state.busy) {
      return
    }
    this.renameTargetFile = context.file
    this.closeFileContextMenu()
    const dialog = this.element<HTMLElement>('#rename-file-dialog')
    const input = this.element<HTMLInputElement>('#rename-file-input')
    input.value = context.file.name.replace(/\.java$/i, '')
    dialog.hidden = false
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
  }

  private closeRenameDialog(): void {
    if (!this.renameTargetFile) {
      return
    }
    this.renameTargetFile = null
    this.element<HTMLElement>('#rename-file-dialog').hidden = true
  }

  private async renameDialogFile(): Promise<void> {
    const file = this.renameTargetFile
    const repoPath = this.state.repoPath
    if (!file || !repoPath || !this.state.projectValid || this.state.busy) {
      return
    }
    const promptedName = this.element<HTMLInputElement>('#rename-file-input').value
    const newName = normalizeJavaFileName(promptedName)
    if (!newName) {
      this.options.setMessage('Enter a valid Java filename.', 'error')
      this.element<HTMLInputElement>('#rename-file-input').focus()
      return
    }
    if (newName === file.name) {
      this.closeRenameDialog()
      return
    }
    const existingPaths = new Set(this.state.files.map((entry) => entry.path))
    const requestedPath = joinFilePath(gitDirectoryPath(file.path), newName)
    if (existingPaths.has(requestedPath)) {
      this.options.setMessage(`A file named ${newName} already exists.`, 'error')
      this.element<HTMLInputElement>('#rename-file-input').focus()
      return
    }
    this.closeRenameDialog()
    await this.options.operations.renameFile(file, newName)
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    const bound = listener as EventListener
    target.addEventListener(type, bound)
    this.listeners.push(() => target.removeEventListener(type, bound))
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing editor element: ${selector}`)
    return element
  }
}

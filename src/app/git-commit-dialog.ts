import type { GitCommitConfirmation } from './git-controller'

/** Confirm the exact commit before the controller saves or changes the repository. */
export class GitCommitDialog {
  private readonly dialog: HTMLDialogElement
  private readonly listeners: Array<() => void> = []
  private resolve: ((accepted: boolean) => void) | null = null
  private focusTarget: HTMLElement | null = null

  constructor(private readonly root: HTMLElement) {
    this.dialog = this.element<HTMLDialogElement>('#commit-git-dialog')
    this.listen(this.element('#cancel-commit-git'), 'click', () => this.finish(false))
    this.listen(this.element('#confirm-commit-git'), 'click', () => this.finish(true))
    this.listen(this.dialog, 'cancel', (event) => {
      event.preventDefault()
      this.finish(false)
    })
    this.listen(this.dialog, 'close', () => {
      if (!this.dialog.open) this.finish(false)
    })
  }

  get isOpen(): boolean {
    return this.resolve !== null
  }

  confirm(request: GitCommitConfirmation): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(false)
    this.focusTarget = this.root.ownerDocument.activeElement as HTMLElement | null
    const fileCount = `${request.paths.length} ${request.paths.length === 1 ? 'file' : 'files'}`
    const branch = request.branch ? ` to ${request.branch}` : ' to the current branch'
    this.element('#commit-git-title').textContent = request.pushAfterCommit ? 'Commit and push?' : 'Commit changes?'
    this.element('#confirm-commit-git').textContent = request.pushAfterCommit ? 'Commit & Push' : 'Commit'
    this.element('#commit-git-branch').textContent = request.pushAfterCommit
      ? `Commit ${fileCount}${branch} and push to its upstream?`
      : `Commit ${fileCount}${branch}?`
    this.element('#commit-git-message').textContent = request.message
    this.element('#commit-git-paths').textContent = request.paths.join('\n')
    return new Promise((resolve) => {
      this.resolve = resolve
      try {
        this.dialog.hidden = false
        this.dialog.showModal()
        this.element('#cancel-commit-git').focus()
      } catch {
        this.finish(false)
      }
    })
  }

  dispose(): void {
    this.finish(false)
    for (const remove of this.listeners.splice(0)) remove()
  }

  private finish(accepted: boolean): void {
    const resolve = this.resolve
    if (!resolve) return
    this.resolve = null
    const target = this.focusTarget
    this.focusTarget = null
    if (this.dialog.open) this.dialog.close()
    this.dialog.hidden = true
    if (target?.isConnected && !target.closest('[hidden]')) target.focus()
    resolve(accepted)
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing editor element: ${selector}`)
    return element
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener)
    this.listeners.push(() => target.removeEventListener(type, listener))
  }
}

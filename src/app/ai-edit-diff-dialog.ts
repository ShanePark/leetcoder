import { iconFor } from '../icons'
import { diffLines, lineDiffStats, type LineDiffEntry } from '../line-diff'
import { isProposalAcceptShortcut, shortcutLabel } from '../shortcuts'
import type { AiFollowUpProposal } from './ai-follow-up'

export interface AiEditDiffRequest {
  fileName: string
  proposal: AiFollowUpProposal
  /** Whether Accept can apply the change now. */
  canAccept: boolean
  /** Why it cannot, shown beside the disabled Accept button. */
  note: string | null
}

export interface AiEditDiffHandlers {
  accept: () => void
  reject: () => void
}

const MARKERS: Record<LineDiffEntry['kind'], string> = { equal: ' ', delete: '−', insert: '+' }
const LINE_CLASSES: Record<LineDiffEntry['kind'], string> = {
  equal: 'git-diff-line',
  delete: 'git-diff-line is-deletion',
  insert: 'git-diff-line is-addition',
}

interface DialogParts {
  dialog: HTMLDialogElement
  file: HTMLElement
  added: HTMLElement
  removed: HTMLElement
  summary: HTMLElement
  lines: HTMLElement
  note: HTMLElement
  reject: HTMLButtonElement
  accept: HTMLButtonElement
}

/**
 * A modal that shows a pending proposed change to the whole file as one
 * unified diff, with Accept and Reject. It creates its own `<dialog>`
 * and reports the decision through the handlers it was opened with. Closing it
 * with Escape or the close button decides nothing.
 */
export class AiEditDiffDialog {
  private parts: DialogParts | null = null
  private handlers: AiEditDiffHandlers | null = null
  private canAccept = false
  private focusTarget: HTMLElement | null = null

  constructor(
    private readonly host: HTMLElement,
    private readonly macPlatform: boolean,
  ) {}

  get isOpen(): boolean {
    return this.handlers !== null
  }

  /** Show a pending change. A decided one has nothing left to decide and is not shown. */
  open(request: AiEditDiffRequest, handlers: AiEditDiffHandlers): void {
    const { proposal } = request
    if (this.isOpen || proposal.status !== 'pending') return
    const parts = this.parts ?? this.create()
    this.handlers = handlers
    this.canAccept = request.canAccept
    this.focusTarget = this.host.ownerDocument.activeElement as HTMLElement | null

    parts.file.textContent = request.fileName
    const entries = diffLines(proposal.baseCode, proposal.code)
    const { added, removed } = lineDiffStats(entries)
    parts.added.textContent = `+${added}`
    parts.removed.textContent = `−${removed}`
    parts.summary.textContent = proposal.summary
    parts.lines.replaceChildren(...this.renderLines(entries))

    const blocked = !this.canAccept && request.note !== null
    parts.note.textContent = request.note ?? ''
    parts.note.className = blocked ? 'ai-edit-note is-blocked' : 'ai-edit-note'
    parts.accept.disabled = !this.canAccept

    try {
      parts.dialog.hidden = false
      parts.dialog.showModal()
      const focus = this.canAccept ? parts.accept : parts.reject
      focus.focus()
    } catch {
      this.close()
    }
  }

  close(): void {
    if (!this.handlers) return
    this.handlers = null
    this.canAccept = false
    const target = this.focusTarget
    this.focusTarget = null
    const dialog = this.parts?.dialog
    if (dialog) {
      if (dialog.open) dialog.close()
      dialog.hidden = true
    }
    if (target?.isConnected && !target.closest('[hidden]')) target.focus()
  }

  dispose(): void {
    this.close()
    this.parts?.dialog.remove()
    this.parts = null
  }

  private accept(): void {
    const handlers = this.handlers
    if (!handlers || !this.canAccept) return
    this.close()
    handlers.accept()
  }

  private reject(): void {
    const handlers = this.handlers
    if (!handlers) return
    this.close()
    handlers.reject()
  }

  private create(): DialogParts {
    const label = (id: string) => shortcutLabel(id, this.macPlatform)
    const dialog = this.make('dialog', 'ai-edit-dialog') as HTMLDialogElement
    dialog.hidden = true
    dialog.setAttribute('aria-labelledby', 'ai-edit-title')

    const file = this.make('span', 'ai-edit-file')
    const title = this.make('h2', 'ai-edit-title')
    title.id = 'ai-edit-title'
    title.append(this.make('span', '', 'Proposed change to '), file)
    const added = this.make('span', 'is-added')
    const removed = this.make('span', 'is-removed')
    const stats = this.make('span', 'ai-edit-stats')
    stats.append(added, removed)
    const closeButton = this.button('icon-button ai-edit-close')
    closeButton.title = `Close without deciding (${label('ai-close-change')})`
    closeButton.setAttribute('aria-label', 'Close without deciding')
    closeButton.append(iconFor('close'))
    const header = this.make('header', 'ai-edit-header')
    header.append(title, stats, closeButton)

    const diff = this.make('div', 'ai-edit-diff')
    diff.setAttribute('role', 'region')
    diff.setAttribute('aria-label', 'Proposed change')
    diff.tabIndex = 0
    const lines = this.make('div', 'git-diff-lines ai-edit-lines')
    diff.append(lines)

    const reject = this.button('secondary-button ai-edit-reject', 'Reject')
    const accept = this.button('primary-button ai-edit-accept', 'Accept ')
    accept.append(this.make('kbd', '', label('ai-accept-change')))
    const footer = this.make('footer', 'ai-edit-footer')
    const note = this.make('p', 'ai-edit-note')
    note.setAttribute('role', 'status')
    footer.append(note, reject, accept)

    const summary = this.make('p', 'ai-edit-summary')
    dialog.append(header, summary, diff, footer)

    closeButton.addEventListener('click', () => this.close())
    reject.addEventListener('click', () => this.reject())
    accept.addEventListener('click', () => this.accept())
    dialog.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent
      // Enter on another button keeps its native meaning; anywhere else it accepts.
      if (key.isComposing || !isProposalAcceptShortcut(key)) return
      if (key.target === reject || key.target === closeButton) return
      key.preventDefault()
      this.accept()
    })
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.close()
    })
    dialog.addEventListener('close', () => {
      if (!dialog.open) this.close()
    })

    this.host.append(dialog)
    this.parts = { dialog, file, added, removed, summary, lines, note, reject, accept }
    return this.parts
  }

  private renderLines(entries: readonly LineDiffEntry[]): HTMLElement[] {
    let oldNumber = 0
    let newNumber = 0
    return entries.map((entry) => {
      if (entry.kind !== 'insert') oldNumber += 1
      if (entry.kind !== 'delete') newNumber += 1
      const row = this.make('div', LINE_CLASSES[entry.kind])
      row.append(
        this.make('span', 'git-diff-line-number', entry.kind === 'insert' ? '' : String(oldNumber)),
        this.make('span', 'git-diff-line-number', entry.kind === 'delete' ? '' : String(newNumber)),
        this.make('span', 'git-diff-line-marker', MARKERS[entry.kind]),
        this.make('span', 'git-diff-line-content', entry.line.replace(/\r?\n$/, '')),
      )
      return row
    })
  }

  private button(className: string, text?: string): HTMLButtonElement {
    const button = this.make('button', className, text) as HTMLButtonElement
    button.type = 'button'
    return button
  }

  private make(tag: string, className: string, text?: string): HTMLElement {
    const element = this.host.ownerDocument.createElement(tag)
    element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
}

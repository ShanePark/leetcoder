import { MAX_AI_FAILING_CASE_LENGTH } from './ai-controller'

export interface AiCaseDialogOptions {
  root: HTMLElement
  /** Called with the pasted text once the dialog has closed. Only this spends money. */
  confirm: (failingCase: string) => void
  showMessage: (message: string, tone: 'info' | 'success' | 'error') => void
}

/**
 * The dialog that takes a pasted failing case. Opening it sends nothing. The
 * text stays between openings, selected, so a retry needs no new paste and a
 * new paste replaces it. Once the case has been added, `clearDraft` empties it.
 */
export class AiCaseDialog {
  private readonly root: HTMLElement
  private readonly listeners: Array<() => void> = []
  private focusTarget: HTMLElement | null = null
  private open = false

  constructor(private readonly options: AiCaseDialogOptions) {
    this.root = options.root
  }

  get isOpen(): boolean {
    return this.open
  }

  bindEvents(): void {
    // The form has a submit button, so Enter in a field would otherwise reload
    // the webview. Enter in the textarea inserts a newline and never submits.
    this.listen(this.element('#ai-case-form'), 'submit', (event) => {
      event.preventDefault()
      this.submit()
    })
    this.listen(this.element('#cancel-ai-case'), 'click', () => {
      this.close()
    })
    this.listen(this.element('#ai-case-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) this.close()
    })
  }

  show(fileName: string): void {
    if (this.open) return
    this.focusTarget = this.root.ownerDocument.activeElement as HTMLElement | null
    this.open = true
    this.element('#ai-case-file').textContent = fileName
    this.element('#ai-case-dialog').hidden = false
    const input = this.element<HTMLTextAreaElement>('#ai-case-input')
    queueMicrotask(() => {
      if (!this.open) return
      input.focus()
      input.select()
    })
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.element('#ai-case-dialog').hidden = true
    const target = this.focusTarget
    this.focusTarget = null
    if (target?.isConnected && !target.closest?.('[hidden]')) target.focus?.()
  }

  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape' || !this.open) return false
    event.preventDefault()
    this.close()
    return true
  }

  /** Forget the pasted case once it became a test, so the next opening starts empty. */
  clearDraft(): void {
    // A dialog reopened while the request ran holds the user's next paste.
    if (this.open) return
    this.element<HTMLTextAreaElement>('#ai-case-input').value = ''
  }

  dispose(): void {
    for (const remove of this.listeners.splice(0)) remove()
  }

  private submit(): void {
    if (!this.open) return
    const input = this.element<HTMLTextAreaElement>('#ai-case-input')
    const failingCase = input.value.trim()
    if (!failingCase) {
      this.options.showMessage('Paste the failing case first.', 'error')
      input.focus()
      return
    }
    if (failingCase.length > MAX_AI_FAILING_CASE_LENGTH) {
      this.options.showMessage(
        `The failing case is longer than ${MAX_AI_FAILING_CASE_LENGTH} characters, so no request was sent.`,
        'error',
      )
      input.focus()
      return
    }
    this.close()
    this.options.confirm(failingCase)
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

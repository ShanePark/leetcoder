import type { AiFollowUpProposal, AiReviewFollowUp } from './ai-follow-up'
import { renderMarkdown } from './markdown-view'

export const AI_FOLLOW_UP_PLACEHOLDER = 'Ask about this review (Shift+Enter for a new line)'
export const AI_FOLLOW_UP_NO_REVIEW_PLACEHOLDER = 'Review the solution to ask about it'
const AI_REQUEST_RUNNING = 'Available when the current AI request finishes'
const SEND_TITLE = 'Send the question'

const STATUS_NOTES: Partial<Record<AiReviewFollowUp['status'], string>> = {
  truncated: 'The answer was cut off at the output limit.',
  refused: 'The model declined to answer.',
}

export const AI_PROPOSAL_PREPARING = 'Preparing a code change…'

const PROPOSAL_STATUS_LABELS: Record<AiFollowUpProposal['status'], string> = {
  pending: 'Not applied',
  accepted: 'Applied',
  rejected: 'Rejected',
}

/** The answer follows new text only while the panel is scrolled this close to its end. */
const NEAR_BOTTOM_PX = 48
/** The composer grows with its text up to this height, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 160

export interface AiFollowUpViewOptions {
  root: HTMLElement
  /** Ask the question. Resolves false when it should go back to the input. */
  send: (question: string) => Promise<boolean>
  /**
   * Show the pending change `turn` proposed. Without it, a proposal has no View
   * diff button; a decided one never has.
   */
  viewProposal?: (turn: AiReviewFollowUp) => void
}

export interface AiFollowUpComposerState {
  hasReview: boolean
  /** Any AI request is running, a follow-up included. */
  busy: boolean
}

/**
 * The follow-up conversation in the Review tab and the composer under it. The
 * composer is static markup that is never rebuilt, so its draft and focus
 * survive panel renders and file switches. Streaming deltas re-render only the
 * growing answer, at most once per animation frame.
 */
export class AiFollowUpView {
  private readonly root: HTMLElement
  private readonly listeners: Array<() => void> = []
  private readonly turnElements = new Map<AiReviewFollowUp, HTMLElement>()
  private readonly pendingTurns = new Set<AiReviewFollowUp>()
  private frame: number | null = null
  private state: AiFollowUpComposerState = { hasReview: false, busy: false }

  constructor(private readonly options: AiFollowUpViewOptions) {
    this.root = options.root
  }

  bindEvents(): void {
    const input = this.input()
    // The form has a submit button, so the browser's own submit must not reload the webview.
    this.listen(this.element('#review-follow-up-form'), 'submit', (event) => {
      event.preventDefault()
      this.submit()
    })
    this.listen(input, 'keydown', (event) => {
      const key = event as KeyboardEvent
      // Enter while an input method composes text confirms the composition.
      if (key.key !== 'Enter' || key.isComposing || key.keyCode === 229) return
      if (key.shiftKey || key.altKey || key.ctrlKey || key.metaKey) return
      key.preventDefault()
      this.submit()
    })
    this.listen(input, 'input', () => {
      this.fitInput()
      this.updateSendButton()
    })
  }

  /** Enable the composer for the current review and request state. */
  update(state: AiFollowUpComposerState): void {
    this.state = state
    const input = this.input()
    input.disabled = !state.hasReview
    input.placeholder = state.hasReview ? AI_FOLLOW_UP_PLACEHOLDER : AI_FOLLOW_UP_NO_REVIEW_PLACEHOLDER
    this.updateSendButton()
  }

  /**
   * A fresh conversation section for the panel, or null with no turns. Pending
   * frame updates then apply to the new elements.
   */
  renderConversation(turns: readonly AiReviewFollowUp[]): HTMLElement | null {
    this.turnElements.clear()
    if (turns.length === 0) return null
    const section = this.make('section', 'review-section review-follow-ups')
    section.append(this.make('h3', 'review-section-title', 'Follow-up'))
    for (const turn of turns) {
      const element = this.make('div', 'review-turn')
      this.renderTurn(element, turn)
      this.turnElements.set(turn, element)
      section.append(element)
    }
    return section
  }

  /** Re-render the growing answer of `turn` on the next frame. */
  updateTurn(turn: AiReviewFollowUp): void {
    this.pendingTurns.add(turn)
    if (this.frame !== null) return
    const view = this.window()
    if (typeof view?.requestAnimationFrame !== 'function') {
      this.flush()
      return
    }
    this.frame = view.requestAnimationFrame(() => {
      this.frame = null
      this.flush()
    })
  }

  /** Scroll the review to its end, as after sending a question. */
  scrollToEnd(): void {
    const scroller = this.element('#review-body')
    scroller.scrollTop = scroller.scrollHeight
  }

  dispose(): void {
    if (this.frame !== null) {
      this.window()?.cancelAnimationFrame?.(this.frame)
      this.frame = null
    }
    this.pendingTurns.clear()
    for (const remove of this.listeners.splice(0)) remove()
  }

  private flush(): void {
    const scroller = this.element('#review-body')
    const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM_PX
    for (const turn of this.pendingTurns) {
      const element = this.turnElements.get(turn)
      if (element) this.renderTurn(element, turn)
    }
    this.pendingTurns.clear()
    if (follow) scroller.scrollTop = scroller.scrollHeight
  }

  private renderTurn(element: HTMLElement, turn: AiReviewFollowUp): void {
    const streaming = turn.status === 'streaming'
    const answer = this.make('div', 'review-answer')
    answer.setAttribute('aria-busy', String(streaming))
    if (turn.answer) {
      renderMarkdown(answer, turn.answer)
    } else if (streaming) {
      const pending = this.make('span', 'review-answer-pending')
      pending.setAttribute('role', 'status')
      pending.setAttribute('aria-label', 'Waiting for the answer')
      pending.append(this.make('span', ''), this.make('span', ''), this.make('span', ''))
      answer.append(pending)
    }
    const nodes = [this.make('p', 'review-question', turn.question), answer]
    const note = STATUS_NOTES[turn.status]
    if (note) nodes.push(this.make('p', `review-answer-note is-${turn.status}`, note))
    if (streaming && turn.preparingProposal) {
      const preparing = this.make('p', 'review-proposal-preparing')
      preparing.setAttribute('role', 'status')
      const spinner = this.make('span', 'review-proposal-spinner')
      spinner.setAttribute('aria-hidden', 'true')
      preparing.append(spinner, this.make('span', '', AI_PROPOSAL_PREPARING))
      nodes.push(preparing)
    }
    if (turn.proposal) nodes.push(this.renderProposal(turn, turn.proposal))
    element.replaceChildren(...nodes)
  }

  private renderProposal(turn: AiReviewFollowUp, proposal: AiFollowUpProposal): HTMLElement {
    const card = this.make('div', `review-proposal is-${proposal.status}`)
    const header = this.make('div', 'review-proposal-header')
    const stats = this.make('span', 'review-proposal-stats')
    stats.setAttribute('aria-label', `${proposal.added} lines added, ${proposal.removed} removed`)
    stats.append(
      this.make('span', 'is-added', `+${proposal.added}`),
      this.make('span', 'is-removed', `−${proposal.removed}`),
    )
    header.append(
      this.make('span', 'review-proposal-title', 'Proposed change'),
      stats,
      this.make('span', `review-proposal-status is-${proposal.status}`, PROPOSAL_STATUS_LABELS[proposal.status]),
    )
    card.append(header, this.make('p', 'review-proposal-summary', proposal.summary))
    const { viewProposal } = this.options
    if (viewProposal && proposal.status === 'pending') {
      const button = this.make('button', 'secondary-button review-proposal-view', 'View diff') as HTMLButtonElement
      button.type = 'button'
      button.addEventListener('click', () => viewProposal(turn))
      card.append(button)
    }
    return card
  }

  private submit(): void {
    const input = this.input()
    const question = input.value.trim()
    if (!this.state.hasReview || this.state.busy || !question) return
    input.value = ''
    this.fitInput()
    // Keep typing in place: a Send click moved focus to the button.
    input.focus()
    void this.options.send(question).then((answered) => {
      if (answered) return
      const draft = input.value.trim()
      input.value = draft ? `${question}\n${draft}` : question
      this.fitInput()
      this.updateSendButton()
    })
    this.updateSendButton()
  }

  private updateSendButton(): void {
    const button = this.element<HTMLButtonElement>('#review-follow-up-send')
    const { hasReview, busy } = this.state
    button.disabled = !hasReview || busy || !this.input().value.trim()
    button.title = hasReview && busy ? AI_REQUEST_RUNNING : SEND_TITLE
  }

  /**
   * Size the composer to its text. The box is border-box sized and
   * `scrollHeight` leaves out the borders, so they are added back: a box set to
   * `scrollHeight` alone is shorter than its text, scrolls, and shows its
   * scrollbar on every keystroke. Collapsing the box to measure it briefly
   * grows the review above, which can clamp its scroll position, so that is
   * restored.
   */
  private fitInput(): void {
    const input = this.input()
    if (!input.style) return
    const scroller = this.element('#review-body')
    const scrollTop = scroller.scrollTop
    input.style.height = 'auto'
    const height = input.scrollHeight + input.offsetHeight - input.clientHeight
    input.style.height = `${Math.min(height, MAX_INPUT_HEIGHT_PX)}px`
    input.style.overflowY = height > MAX_INPUT_HEIGHT_PX ? 'auto' : 'hidden'
    if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop
  }

  private window(): Window | null {
    return this.root.ownerDocument.defaultView ?? (typeof window === 'undefined' ? null : window)
  }

  private input(): HTMLTextAreaElement {
    return this.element<HTMLTextAreaElement>('#review-follow-up-input')
  }

  private make(tag: string, className: string, text?: string): HTMLElement {
    const element = this.root.ownerDocument.createElement(tag)
    element.className = className
    if (text !== undefined) element.textContent = text
    return element
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

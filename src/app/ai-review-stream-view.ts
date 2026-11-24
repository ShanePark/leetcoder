import { parsePartialJson } from '../partial-json'
import type { AiReviewStream } from './ai-controller'
import { partialAiReview, renderAiReviewDraft } from './ai-review-view'

export const AI_REVIEW_THINKING = 'Thinking…'
export const AI_REVIEW_WRITING = 'Writing the review…'

/** What the model is doing, the whole seconds since the request was sent, and the model. */
export function aiReviewStreamStatus(stream: AiReviewStream, now: number): string {
  const seconds = Math.max(0, Math.floor((now - stream.startedAt) / 1000))
  return `${stream.text ? AI_REVIEW_WRITING : AI_REVIEW_THINKING} ${seconds}s · ${stream.modelName}`
}

export interface AiReviewStreamViewOptions {
  body: () => HTMLElement
  /** The usage meter element to place beside the review. */
  meter: () => HTMLElement | null
  now?: () => number
}

/**
 * Shows a review in the Review tab while its JSON streams in. Each frame
 * parses the text so far and renders the sections that have arrived with the
 * finished review's renderer; deltas between frames are coalesced. The status
 * line ticks every second without a render, so its spinner keeps turning.
 */
export class AiReviewStreamView {
  private current: AiReviewStream | null = null
  private status: HTMLElement | null = null
  private statusText: HTMLElement | null = null
  private frame: number | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly options: AiReviewStreamViewOptions) {
    this.now = options.now ?? Date.now
  }

  get stream(): AiReviewStream | null {
    return this.current
  }

  /** Start showing `stream`, rendered at once. */
  show(stream: AiReviewStream): void {
    this.hide()
    this.current = stream
    this.render()
    const view = this.window()
    if (typeof view?.setInterval === 'function') this.ticker = view.setInterval(() => this.tick(), 1_000)
  }

  /** Render the stream again on the next frame. */
  update(): void {
    if (!this.current || this.frame !== null) return
    const view = this.window()
    if (typeof view?.requestAnimationFrame !== 'function') {
      this.render()
      return
    }
    this.frame = view.requestAnimationFrame(() => {
      this.frame = null
      this.render()
    })
  }

  /** Render the stream now, as after another part of the panel changed. */
  render(): void {
    const stream = this.current
    if (!stream) return
    renderAiReviewDraft(this.options.body(), {
      fileName: stream.fileName,
      modelId: stream.modelId,
      testRunOmitted: stream.testRunOmitted,
      review: partialAiReview(parsePartialJson(stream.text)),
    }, this.statusElement(), this.options.meter())
    this.tick()
  }

  /** Stop showing the stream. The caller renders what replaces it. */
  hide(): void {
    const view = this.window()
    if (this.frame !== null) view?.cancelAnimationFrame?.(this.frame)
    if (this.ticker !== null) view?.clearInterval?.(this.ticker)
    this.frame = null
    this.ticker = null
    this.current = null
  }

  dispose(): void {
    this.hide()
  }

  private tick(): void {
    if (this.current && this.statusText) this.statusText.textContent = aiReviewStreamStatus(this.current, this.now())
  }

  private statusElement(): HTMLElement {
    if (this.status) return this.status
    const documentRef = this.options.body().ownerDocument
    const status = documentRef.createElement('p')
    status.className = 'review-stream-status'
    const spinner = documentRef.createElement('span')
    spinner.className = 'review-stream-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    const text = documentRef.createElement('span')
    text.className = 'review-stream-text'
    status.append(spinner, text)
    this.status = status
    this.statusText = text
    return status
  }

  private window(): Window | null {
    return this.options.body().ownerDocument.defaultView ?? (typeof window === 'undefined' ? null : window)
  }
}

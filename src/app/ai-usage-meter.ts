import type { AiModelPricing, AiRequestUsage, AiStreamEvent, AiStreamUsage } from '../backend'
import type { AiReviewStream, AiReviewTestRunOmission, StoredAiReview } from './ai-controller'
import { formatReviewCost, formatReviewTokens } from './ai-review-view'

/**
 * Streamed output is counted at four characters a token, the usual ratio for
 * English prose and JSON. Korean and code run denser, so the estimate can run
 * low, and thinking the API omits streams no characters at all. The final
 * count replaces the estimate when the message ends.
 */
export const CHARS_PER_OUTPUT_TOKEN = 4

/**
 * How fast the meter rolls toward its reading: it closes all but 1/e of the
 * gap every 90 ms, so a jump settles in about 400 ms. Each frame starts from
 * what is shown, so readings that keep arriving mid-roll never restart it.
 */
const ROLL_TIME_CONSTANT_MS = 90

/** What a running request has reported so far. */
export interface AiLiveUsage {
  /** The last counts the stream reported; null until the message starts. */
  reported: AiStreamUsage | null
  /** `reported` holds the final counts. */
  final: boolean
  /** Characters of text and thinking streamed so far. */
  chars: number
}

export function emptyLiveUsage(): AiLiveUsage {
  return { reported: null, final: false, chars: 0 }
}

/** Fold one stream event into `live`. */
export function recordStreamUsage(live: AiLiveUsage, event: AiStreamEvent): void {
  if (event.kind === 'text') live.chars += event.text.length
  else if (event.kind === 'thinking') live.chars += event.chars
  else if (event.kind === 'usage') {
    live.reported = { ...event.usage }
    live.final = event.final
  }
}

export function estimateOutputTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN)
}

/**
 * The counts of a running request: input and cache counts as the message start
 * reported them, and output estimated from the streamed characters until the
 * final count arrives.
 */
export function liveTokens(live: AiLiveUsage): AiStreamUsage {
  const reported = live.reported ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  if (live.final) return { ...reported }
  return { ...reported, outputTokens: Math.max(reported.outputTokens, estimateOutputTokens(live.chars)) }
}

/**
 * A cost in USD priced as the native ledger prices it: a token class in use
 * without a price leaves the cost unknown.
 */
export function aiTokenCost(tokens: AiStreamUsage, pricing: AiModelPricing | null): number | null {
  if (pricing === null) return null
  const classes: Array<[number, number | null]> = [
    [tokens.inputTokens, pricing.inputPerMTok],
    [tokens.outputTokens, pricing.outputPerMTok],
    [tokens.cacheReadTokens, pricing.cacheReadPerMTok],
    [tokens.cacheWriteTokens, pricing.cacheWritePerMTok],
  ]
  let cost = 0
  for (const [count, perMTok] of classes) {
    if (count === 0) continue
    if (perMTok === null) return null
    cost += (count / 1_000_000) * perMTok
  }
  return cost
}

/** One request of the conversation. */
export interface AiMeterEntry {
  label: string
  tokens: AiStreamUsage
  costUsd: number | null
  /** Still running, so the output and the cost are estimates. */
  estimated: boolean
}

export interface AiMeterState {
  entries: AiMeterEntry[]
  modelName: string
  modelId: string
  /** A help answer has no tests to include, so the meter leaves that line out. */
  help: boolean
  testRunOmitted: AiReviewTestRunOmission | null
}

const settledEntry = (label: string, usage: AiRequestUsage): AiMeterEntry => ({
  label,
  tokens: {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  },
  costUsd: usage.costUsd,
  estimated: false,
})

const liveEntry = (label: string, live: AiLiveUsage, pricing: AiModelPricing | null): AiMeterEntry => {
  const tokens = liveTokens(live)
  return { label, tokens, costUsd: aiTokenCost(tokens, pricing), estimated: true }
}

/**
 * The conversation the meter counts: a review on its way alone, since it
 * starts a new conversation, or the shown review with all of its follow-ups.
 * Null with nothing to count.
 */
export function aiMeterState(stored: StoredAiReview | null, stream: AiReviewStream | null): AiMeterState | null {
  if (stream) {
    return {
      entries: [liveEntry(stream.mode === 'help' ? 'Help' : 'Review', stream.live, stream.pricing)],
      modelName: stream.modelName,
      modelId: stream.modelId,
      help: stream.mode === 'help',
      testRunOmitted: stream.testRunOmitted,
    }
  }
  if (!stored) return null
  return {
    entries: [
      settledEntry(stored.request.mode === 'help' ? 'Help' : 'Review', stored.usage),
      ...stored.followUps.map((turn, index) => {
        const label = `Follow-up ${index + 1}`
        return turn.usage ? settledEntry(label, turn.usage) : liveEntry(label, turn.live, stored.pricing)
      }),
    ],
    modelName: stored.servedModelName,
    modelId: stored.servedModel,
    help: stored.request.mode === 'help',
    testRunOmitted: stored.testRunOmitted,
  }
}

export interface AiMeterTotals {
  tokens: AiStreamUsage
  /** The priced requests' sum; null when none had a price. */
  costUsd: number | null
  unpriced: number
  estimated: boolean
}

export function aiMeterTotals(entries: readonly AiMeterEntry[]): AiMeterTotals {
  const tokens: AiStreamUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let costUsd: number | null = null
  let unpriced = 0
  for (const entry of entries) {
    tokens.inputTokens += entry.tokens.inputTokens
    tokens.outputTokens += entry.tokens.outputTokens
    tokens.cacheReadTokens += entry.tokens.cacheReadTokens
    tokens.cacheWriteTokens += entry.tokens.cacheWriteTokens
    if (entry.costUsd === null) unpriced += 1
    else costUsd = (costUsd ?? 0) + entry.costUsd
  }
  return { tokens, costUsd, unpriced, estimated: entries.some((entry) => entry.estimated) }
}

/** A cost, marked approximate while estimated, with the unpriced requests counted after it. */
export function formatMeterCost(costUsd: number | null, estimated: boolean, unpriced: number): string {
  if (costUsd === null) return 'Cost unknown'
  const cost = `${estimated ? '≈ ' : ''}${formatReviewCost(costUsd)}`
  return unpriced > 0 ? `${cost} + ${unpriced} unpriced` : cost
}

const TOKEN_ROWS = [
  ['Input', 'inputTokens'],
  ['Output', 'outputTokens'],
  ['Cache read', 'cacheReadTokens'],
  ['Cache write', 'cacheWriteTokens'],
] as const

/** The readings the meter rolls: the four token counts, then the cost. */
type Reading = [number, number, number, number, number]

/**
 * One usage meter for the whole conversation, beside the review. The element
 * is kept across panel renders, so a running request rolls its numbers like a
 * taxi meter, once per animation frame, and an open breakdown stays open.
 * Under reduced motion the numbers jump.
 */
export class AiUsageMeter {
  readonly element: HTMLElement
  private readonly cost: HTMLElement
  private readonly model: HTMLElement
  private readonly values: HTMLElement[]
  private readonly summary: HTMLElement
  private readonly requests: HTMLElement
  private readonly tests: HTMLElement
  private totals: AiMeterTotals | null = null
  private shown: Reading | null = null
  private target: Reading = [0, 0, 0, 0, 0]
  private lastFrame: number | null = null
  private frame: number | null = null

  constructor(private readonly documentRef: Document) {
    this.element = this.make('aside', 'review-usage')
    this.element.setAttribute('aria-label', 'Conversation usage')
    this.cost = this.make('p', 'review-usage-cost')
    this.model = this.make('p', 'review-usage-model')
    const stats = this.make('dl', 'review-usage-stats')
    this.values = TOKEN_ROWS.map(([label]) => {
      const value = this.make('dd', 'review-usage-value')
      stats.append(this.make('dt', 'review-usage-label', label), value)
      return value
    })
    const breakdown = this.make('details', 'review-usage-breakdown')
    this.summary = this.make('summary', 'review-usage-summary')
    this.requests = this.make('ul', 'review-usage-requests')
    breakdown.append(this.summary, this.requests)
    this.tests = this.make('p', 'review-usage-tests')
    this.element.append(this.make('h3', 'review-usage-title', 'Usage'), this.cost, this.model, stats, breakdown, this.tests)
  }

  update(state: AiMeterState): void {
    const totals = aiMeterTotals(state.entries)
    this.totals = totals
    this.model.textContent = state.modelName
    this.model.title = state.modelId
    const included = state.testRunOmitted === null
    this.tests.className = `review-usage-tests ${included ? 'is-included' : 'is-omitted'}`
    this.tests.textContent = included ? 'Test results included' : 'Test results not included'
    this.tests.hidden = state.help
    this.cost.className = totals.costUsd === null ? 'review-usage-cost is-unknown' : 'review-usage-cost'
    this.element.setAttribute('aria-busy', String(totals.estimated))
    this.renderRequests(state.entries)

    const { tokens } = totals
    this.target = [tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens, totals.costUsd ?? 0]
    const view = this.documentRef.defaultView
    if (this.shown === null || typeof view?.requestAnimationFrame !== 'function' || reducedMotion(view)) {
      this.stopRolling()
      this.write(this.target)
      return
    }
    if (this.frame === null) {
      this.lastFrame = null
      this.frame = view.requestAnimationFrame((time) => this.step(time))
    }
  }

  /** Start the next conversation from zero instead of rolling from the last one's totals. */
  reset(): void {
    this.stopRolling()
    this.shown = null
  }

  dispose(): void {
    this.stopRolling()
  }

  private step(time: number): void {
    this.frame = null
    const shown = this.shown ?? this.target
    const elapsed = this.lastFrame === null ? 0 : time - this.lastFrame
    this.lastFrame = time
    const keep = Math.exp(-elapsed / ROLL_TIME_CONSTANT_MS)
    const next = shown.map((value, index) => this.target[index] - (this.target[index] - value) * keep) as Reading
    // Close enough once every count rounds to its reading and the cost is within a thousandth.
    const settled = next.every((value, index) => {
      const gap = Math.abs(this.target[index] - value)
      return index < 4 ? gap < 0.5 : gap <= Math.abs(this.target[index]) * 1e-3
    })
    this.write(settled ? this.target : next)
    if (!settled) this.frame = this.documentRef.defaultView?.requestAnimationFrame((later) => this.step(later)) ?? null
  }

  private stopRolling(): void {
    if (this.frame !== null) this.documentRef.defaultView?.cancelAnimationFrame?.(this.frame)
    this.frame = null
    this.lastFrame = null
  }

  private write(reading: Reading): void {
    this.shown = reading
    const totals = this.totals
    if (!totals) return
    this.values.forEach((value, index) => {
      value.textContent = formatReviewTokens(Math.round(reading[index]))
    })
    this.cost.textContent = formatMeterCost(totals.costUsd === null ? null : reading[4], totals.estimated, totals.unpriced)
  }

  private renderRequests(entries: readonly AiMeterEntry[]): void {
    this.summary.textContent = entries.length === 1 ? '1 request' : `${entries.length} requests`
    this.requests.replaceChildren(...entries.map((entry) => {
      const { tokens } = entry
      const item = this.make('li', `review-usage-request${entry.estimated ? ' is-estimated' : ''}`)
      const parts = [
        `${formatReviewTokens(tokens.inputTokens)} in`,
        `${formatReviewTokens(tokens.outputTokens)} out`,
        ...(tokens.cacheReadTokens > 0 ? [`${formatReviewTokens(tokens.cacheReadTokens)} cache read`] : []),
        ...(tokens.cacheWriteTokens > 0 ? [`${formatReviewTokens(tokens.cacheWriteTokens)} cache write`] : []),
      ]
      item.append(
        this.make('span', 'review-usage-request-label', entry.label),
        this.make('span', 'review-usage-request-cost', formatMeterCost(entry.costUsd, entry.estimated, 0)),
        this.make('span', 'review-usage-request-tokens', parts.join(' · ')),
      )
      return item
    }))
  }

  private make(tag: string, className: string, text?: string): HTMLElement {
    const element = this.documentRef.createElement(tag)
    element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
}

function reducedMotion(view: Window): boolean {
  return typeof view.matchMedia === 'function' && view.matchMedia('(prefers-reduced-motion: reduce)').matches
}

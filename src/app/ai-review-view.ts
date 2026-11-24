import type { AiReviewVerdict } from '../backend'
import type { AiReviewTestRunOmission, StoredAiReview } from './ai-controller'

const VERDICT_LABELS: Readonly<Record<AiReviewVerdict, string>> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  unsure: 'Unsure',
}

const TEST_RUN_NOTES: Readonly<Record<AiReviewTestRunOmission | 'included', string>> = {
  included: 'Based on the code and its latest test results.',
  'no-run': 'Based on the code only, because it had no test run.',
  changed: 'Based on the code only, because it changed after the last test run.',
}

export const AI_REVIEW_EMPTY_COPY = 'No review yet. Review the open solution from the editor toolbar.'

/** What the review was based on, for the line under its verdict. */
export function aiReviewTestRunNote(omitted: AiReviewTestRunOmission | null): string {
  return TEST_RUN_NOTES[omitted ?? 'included']
}

/** A token count with thousands separators. */
export function formatReviewTokens(count: number): string {
  return count.toLocaleString('en-US')
}

/**
 * A request's cost in USD: cents from a dollar up, four decimals below, and two
 * significant digits for amounts too small to show in four.
 */
export function formatReviewCost(costUsd: number | null): string {
  if (costUsd === null) return 'Cost unknown'
  if (costUsd === 0) return '$0.00'
  if (costUsd >= 1) {
    return `$${costUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (costUsd >= 0.0001) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
}

/** A review as far as its streamed JSON has arrived. Any field may be missing. */
export interface PartialAiReview {
  verdict?: AiReviewVerdict
  summary?: string
  failureCause?: string | null
  issues?: string[]
  missedCases?: Array<{ input?: string; reason?: string }>
  efficiency?: { time?: string; space?: string; assessment?: string }
  improvements?: string[]
}

const isVerdict = (value: unknown): value is AiReviewVerdict =>
  typeof value === 'string' && Object.hasOwn(VERDICT_LABELS, value)

const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null

/**
 * The fields of a partly parsed review that have the right shape. A verdict
 * counts only once it is a whole verdict word.
 */
export function partialAiReview(value: unknown): PartialAiReview {
  const document = record(value)
  if (!document) return {}
  const efficiency = record(document.efficiency)
  return {
    verdict: isVerdict(document.verdict) ? document.verdict : undefined,
    summary: text(document.summary),
    failureCause: text(document.failureCause),
    issues: texts(document.issues),
    missedCases: Array.isArray(document.missedCases)
      ? document.missedCases.map(record).filter((missed) => missed !== null)
        .map((missed) => ({ input: text(missed.input), reason: text(missed.reason) }))
      : undefined,
    efficiency: efficiency
      ? { time: text(efficiency.time), space: text(efficiency.space), assessment: text(efficiency.assessment) }
      : undefined,
    improvements: texts(document.improvements),
  }
}

type Make = (tag: string, className: string, text?: string) => HTMLElement

const maker = (documentRef: Document): Make => (tag, className, text) => {
  const element = documentRef.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/**
 * Render the last review into the Review tab. Model text is set only through
 * `textContent`, so it can never become markup. Empty sections are left out.
 * `conversation`, the follow-up section, goes after the review sections, and
 * `meter`, the conversation's usage, beside them.
 */
export function renderAiReviewPanel(
  body: HTMLElement,
  stored: StoredAiReview | null,
  conversation: HTMLElement | null = null,
  meter: HTMLElement | null = null,
): void {
  const make = maker(body.ownerDocument)
  if (!stored) {
    body.replaceChildren(make('p', 'review-empty', AI_REVIEW_EMPTY_COPY))
    return
  }
  const main = make('div', 'review-main')
  main.append(...reviewSections(make, stored.review))
  if (conversation) main.append(conversation)
  const head = reviewHead(make, stored.review.verdict, `${stored.fileName} · ${stored.servedModel}`, stored.testRunOmitted)
  layout(body, make, head, meter, main)
}

/** What the Review tab shows while a review streams in. */
export interface AiReviewDraft {
  fileName: string
  modelId: string
  testRunOmitted: AiReviewTestRunOmission | null
  review: PartialAiReview
}

/**
 * Render a review on its way with the same sections as the finished one, as
 * far as they have arrived. `status`, which says the review is still being
 * written, goes under the head; it is kept by the caller so it can tick
 * without a render.
 */
export function renderAiReviewDraft(
  body: HTMLElement,
  draft: AiReviewDraft,
  status: HTMLElement,
  meter: HTMLElement | null = null,
): void {
  const make = maker(body.ownerDocument)
  const head = reviewHead(make, draft.review.verdict ?? null, `${draft.fileName} · ${draft.modelId}`, draft.testRunOmitted)
  head.append(status)
  const main = make('div', 'review-main')
  main.setAttribute('aria-busy', 'true')
  main.append(...reviewSections(make, draft.review))
  layout(body, make, head, meter, main)
}

function layout(body: HTMLElement, make: Make, head: HTMLElement, meter: HTMLElement | null, main: HTMLElement): void {
  const element = make('div', 'review-layout')
  element.append(head, ...(meter ? [meter] : []), main)
  body.replaceChildren(element)
}

function reviewHead(
  make: Make,
  verdict: AiReviewVerdict | null,
  meta: string,
  testRunOmitted: AiReviewTestRunOmission | null,
): HTMLElement {
  const head = make('div', 'review-head')
  const header = make('div', 'review-header')
  if (verdict) header.append(make('span', `review-verdict is-${verdict}`, VERDICT_LABELS[verdict] ?? VERDICT_LABELS.unsure))
  header.append(make('span', 'review-meta', meta))
  head.append(header, make('p', 'review-context', aiReviewTestRunNote(testRunOmitted)))
  return head
}

function reviewSections(make: Make, review: PartialAiReview): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const summary = review.summary?.trim()
  if (summary) nodes.push(make('p', 'review-summary', summary))

  const section = (title: string, ...content: HTMLElement[]): HTMLElement => {
    const element = make('section', 'review-section')
    element.append(make('h3', 'review-section-title', title), ...content)
    return element
  }
  const list = (items: readonly string[] | undefined): HTMLElement | null => {
    const entries = (items ?? []).map((item) => item.trim()).filter(Boolean)
    if (entries.length === 0) return null
    const element = make('ul', 'review-list')
    element.append(...entries.map((entry) => make('li', 'review-item', entry)))
    return element
  }

  const failureCause = review.failureCause?.trim()
  if (failureCause) nodes.push(section('Failure cause', make('p', 'review-text', failureCause)))

  const issues = list(review.issues)
  if (issues) nodes.push(section('Issues', issues))

  const missedCases = (review.missedCases ?? [])
    .map((missed) => ({ input: missed.input?.trim() ?? '', reason: missed.reason?.trim() ?? '' }))
    .filter((missed) => missed.input || missed.reason)
  if (missedCases.length > 0) {
    const element = make('ul', 'review-list review-missed-cases')
    element.append(...missedCases.map((missed) => {
      const item = make('li', 'review-item review-missed-case')
      if (missed.input) item.append(make('code', 'review-case-input', missed.input))
      if (missed.reason) item.append(make('span', 'review-case-reason', missed.reason))
      return item
    }))
    nodes.push(section('Missed cases', element))
  }

  const efficiency: HTMLElement[] = []
  const facts = make('dl', 'review-efficiency')
  for (const [label, value] of [['Time', review.efficiency?.time], ['Space', review.efficiency?.space]] as const) {
    const fact = value?.trim()
    if (fact) facts.append(make('dt', 'review-efficiency-label', label), make('dd', 'review-efficiency-value', fact))
  }
  if (facts.children.length > 0) efficiency.push(facts)
  const assessment = review.efficiency?.assessment?.trim()
  if (assessment) efficiency.push(make('p', 'review-text', assessment))
  if (efficiency.length > 0) nodes.push(section('Efficiency', ...efficiency))

  const improvements = list(review.improvements)
  if (improvements) nodes.push(section('Improvements', improvements))
  return nodes
}

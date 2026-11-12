import type { AiRequestUsage, AiReviewVerdict } from '../backend'
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

/** Token rows for the usage card. Cache rows appear only when the request used the cache. */
export function aiReviewUsageRows(usage: AiRequestUsage): Array<{ label: string; value: string }> {
  const rows = [
    { label: 'Input', count: usage.inputTokens, always: true },
    { label: 'Output', count: usage.outputTokens, always: true },
    { label: 'Cache read', count: usage.cacheReadTokens, always: false },
    { label: 'Cache write', count: usage.cacheWriteTokens, always: false },
  ]
  return rows
    .filter((row) => row.always || row.count > 0)
    .map((row) => ({ label: row.label, value: formatReviewTokens(row.count) }))
}

/**
 * Render the last review into the Review tab. Model text is set only through
 * `textContent`, so it can never become markup. Empty sections are left out.
 */
export function renderAiReviewPanel(body: HTMLElement, stored: StoredAiReview | null): void {
  const documentRef = body.ownerDocument
  const make = (tag: string, className: string, text?: string): HTMLElement => {
    const element = documentRef.createElement(tag)
    element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  if (!stored) {
    body.replaceChildren(make('p', 'review-empty', AI_REVIEW_EMPTY_COPY))
    return
  }

  const { review } = stored
  const nodes: HTMLElement[] = []

  const head = make('div', 'review-head')
  const header = make('div', 'review-header')
  const verdict = make('span', `review-verdict is-${review.verdict}`, VERDICT_LABELS[review.verdict] ?? VERDICT_LABELS.unsure)
  header.append(verdict, make('span', 'review-meta', `${stored.fileName} · ${stored.servedModel}`))
  head.append(header, make('p', 'review-context', aiReviewTestRunNote(stored.testRunOmitted)))

  const summary = review.summary.trim()
  if (summary) nodes.push(make('p', 'review-summary', summary))

  const section = (title: string, ...content: HTMLElement[]): HTMLElement => {
    const element = make('section', 'review-section')
    element.append(make('h3', 'review-section-title', title), ...content)
    return element
  }
  const list = (items: readonly string[]): HTMLElement | null => {
    const texts = items.map((item) => item.trim()).filter(Boolean)
    if (texts.length === 0) return null
    const element = make('ul', 'review-list')
    element.append(...texts.map((text) => make('li', 'review-item', text)))
    return element
  }

  const failureCause = review.failureCause?.trim()
  if (failureCause) nodes.push(section('Failure cause', make('p', 'review-text', failureCause)))

  const issues = list(review.issues)
  if (issues) nodes.push(section('Issues', issues))

  const missedCases = review.missedCases
    .map((missed) => ({ input: missed.input.trim(), reason: missed.reason.trim() }))
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
  for (const [label, value] of [['Time', review.efficiency.time], ['Space', review.efficiency.space]] as const) {
    const text = value.trim()
    if (text) facts.append(make('dt', 'review-efficiency-label', label), make('dd', 'review-efficiency-value', text))
  }
  if (facts.children.length > 0) efficiency.push(facts)
  const assessment = review.efficiency.assessment.trim()
  if (assessment) efficiency.push(make('p', 'review-text', assessment))
  if (efficiency.length > 0) nodes.push(section('Efficiency', ...efficiency))

  const improvements = list(review.improvements)
  if (improvements) nodes.push(section('Improvements', improvements))

  const main = make('div', 'review-main')
  main.append(...nodes)
  const layout = make('div', 'review-layout')
  layout.append(head, renderUsageCard(make, stored), main)
  body.replaceChildren(layout)
}

/** What the request cost and what it was based on, beside the review. */
function renderUsageCard(
  make: (tag: string, className: string, text?: string) => HTMLElement,
  stored: StoredAiReview,
): HTMLElement {
  const { usage } = stored
  const card = make('aside', 'review-usage')
  card.setAttribute('aria-label', 'Request usage')
  const cost = make(
    'p',
    usage.costUsd === null ? 'review-usage-cost is-unknown' : 'review-usage-cost',
    formatReviewCost(usage.costUsd),
  )
  const model = make('p', 'review-usage-model', stored.servedModelName)
  model.title = stored.servedModel
  const stats = make('dl', 'review-usage-stats')
  for (const row of aiReviewUsageRows(usage)) {
    stats.append(make('dt', 'review-usage-label', row.label), make('dd', 'review-usage-value', row.value))
  }
  const included = stored.testRunOmitted === null
  const tests = make(
    'p',
    `review-usage-tests ${included ? 'is-included' : 'is-omitted'}`,
    included ? 'Test results included' : 'Test results not included',
  )
  card.append(
    make('h3', 'review-usage-title', 'Usage'),
    cost,
    model,
    make('p', 'review-usage-caption', 'Tokens'),
    stats,
    tests,
  )
  return card
}

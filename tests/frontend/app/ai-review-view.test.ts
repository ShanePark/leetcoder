import { describe, expect, it } from 'vitest'

import type { AiRequestUsage, AiReview } from '../../../src/backend'
import type { StoredAiReview } from '../../../src/app/ai-controller'
import {
  AI_REVIEW_EMPTY_COPY,
  aiReviewUsageRows,
  formatReviewCost,
  formatReviewTokens,
  renderAiReviewPanel,
} from '../../../src/app/ai-review-view'

/** Just enough of the DOM to build the panel: elements with class, text, attributes, and children. */
class FakeElement {
  className = ''
  textContent = ''
  title = ''
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  /** Every descendant with the class, in document order. */
  all(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...child.all(className),
    ])
  }

  texts(className: string): string[] {
    return this.all(className).map((element) => element.textContent)
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }
}

const render = (stored: StoredAiReview | null): FakeElement => {
  const body = new FakeDocument().createElement('div')
  renderAiReviewPanel(body as unknown as HTMLElement, stored)
  return body
}

const fullReview: AiReview = {
  verdict: 'incorrect',
  summary: 'Misses duplicates.',
  failureCause: 'The map is filled before the lookup.',
  issues: ['Wrong order', '  '],
  missedCases: [{ input: 'nums = [3,3], target = 6', reason: 'Same value twice' }, { input: ' ', reason: '' }],
  efficiency: { time: 'O(n)', space: 'O(n)', assessment: 'Fits the limits.' },
  improvements: ['Look up before inserting.'],
}

const usage: AiRequestUsage = {
  inputTokens: 12_345,
  outputTokens: 1_234,
  cacheReadTokens: 0,
  cacheWriteTokens: 2_048,
  costUsd: 0.0123,
}

const stored = (
  review: AiReview,
  testRunOmitted: StoredAiReview['testRunOmitted'] = null,
  requestUsage: AiRequestUsage = usage,
): StoredAiReview => ({
  review,
  fileName: 'Q1TwoSum.java',
  servedModel: 'model-a',
  servedModelName: 'Model A',
  testRunOmitted,
  usage: requestUsage,
})

describe('review panel', () => {
  it('shows an empty state before any review', () => {
    expect(render(null).texts('review-empty')).toEqual([AI_REVIEW_EMPTY_COPY])
  })

  it('renders every section with content, in order, and skips blank items', () => {
    const body = render(stored(fullReview))

    expect(body.all('review-verdict')[0]).toMatchObject({ className: 'review-verdict is-incorrect', textContent: 'Incorrect' })
    expect(body.texts('review-meta')).toEqual(['Q1TwoSum.java · model-a'])
    expect(body.texts('review-context')).toEqual(['Based on the code and its latest test results.'])
    expect(body.texts('review-summary')).toEqual(['Misses duplicates.'])
    expect(body.texts('review-section-title')).toEqual([
      'Failure cause',
      'Issues',
      'Missed cases',
      'Efficiency',
      'Improvements',
    ])
    expect(body.texts('review-case-input')).toEqual(['nums = [3,3], target = 6'])
    expect(body.all('review-case-input')[0].tagName).toBe('code')
    expect(body.texts('review-case-reason')).toEqual(['Same value twice'])
    expect(body.all('review-missed-case')).toHaveLength(1)
    expect(body.texts('review-efficiency-label')).toEqual(['Time', 'Space'])
    expect(body.texts('review-efficiency-value')).toEqual(['O(n)', 'O(n)'])
    expect(body.all('review-list')[0].children.map((item) => item.textContent)).toEqual(['Wrong order'])
  })

  it('leaves out empty sections', () => {
    const body = render(stored({
      verdict: 'correct',
      summary: 'Looks right.',
      failureCause: null,
      issues: [],
      missedCases: [],
      efficiency: { time: ' ', space: '', assessment: '' },
      improvements: [' '],
    }, 'changed'))

    expect(body.all('review-verdict')[0]).toMatchObject({ className: 'review-verdict is-correct', textContent: 'Correct' })
    expect(body.texts('review-context')).toEqual(['Based on the code only, because it changed after the last test run.'])
    expect(body.all('review-section')).toHaveLength(0)
  })

  it('keeps model text as plain text', () => {
    const markup = '<img src=x onerror=alert(1)>'
    const body = render(stored({ ...fullReview, summary: markup, issues: [markup] }, 'no-run'))

    expect(body.texts('review-summary')).toEqual([markup])
    expect(body.texts('review-item')[0]).toBe(markup)
    expect(body.texts('review-context')).toEqual(['Based on the code only, because it had no test run.'])
  })
})

describe('review usage card', () => {
  it('sits beside the review content with the cost, model, tokens, and test results', () => {
    const body = render(stored(fullReview))

    const layout = body.children[0]
    expect(layout.className).toBe('review-layout')
    expect(layout.children.map((child) => child.className)).toEqual(['review-head', 'review-usage', 'review-main'])
    const card = body.all('review-usage')[0]
    expect(card.tagName).toBe('aside')
    expect(card.attributes.get('aria-label')).toBe('Request usage')
    expect(body.texts('review-usage-cost')).toEqual(['$0.0123'])
    expect(body.all('review-usage-model')[0]).toMatchObject({ textContent: 'Model A', title: 'model-a' })
    expect(body.texts('review-usage-label')).toEqual(['Input', 'Output', 'Cache write'])
    expect(body.texts('review-usage-value')).toEqual(['12,345', '1,234', '2,048'])
    expect(body.all('review-usage-tests')[0]).toMatchObject({
      className: 'review-usage-tests is-included',
      textContent: 'Test results included',
    })
  })

  it('says when the cost is unknown and the test results were left out', () => {
    const body = render(stored(fullReview, 'changed', { ...usage, costUsd: null }))

    expect(body.all('review-usage-cost')[0]).toMatchObject({
      className: 'review-usage-cost is-unknown',
      textContent: 'Cost unknown',
    })
    expect(body.all('review-usage-tests')[0]).toMatchObject({
      className: 'review-usage-tests is-omitted',
      textContent: 'Test results not included',
    })
  })

  it('formats costs by size and tokens with separators', () => {
    expect(formatReviewCost(null)).toBe('Cost unknown')
    expect(formatReviewCost(0)).toBe('$0.00')
    expect(formatReviewCost(1234.5)).toBe('$1,234.50')
    expect(formatReviewCost(1)).toBe('$1.00')
    expect(formatReviewCost(0.0123)).toBe('$0.0123')
    expect(formatReviewCost(0.0001)).toBe('$0.0001')
    expect(formatReviewCost(0.0000423)).toBe('$0.000042')
    expect(formatReviewTokens(0)).toBe('0')
    expect(formatReviewTokens(1_234_567)).toBe('1,234,567')
  })

  it('always lists input and output tokens and cache tokens only when used', () => {
    expect(aiReviewUsageRows({ ...usage, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 })).toEqual([
      { label: 'Input', value: '0' },
      { label: 'Output', value: '0' },
    ])
    expect(aiReviewUsageRows({ ...usage, cacheReadTokens: 9_000 }).map((row) => row.label)).toEqual([
      'Input',
      'Output',
      'Cache read',
      'Cache write',
    ])
  })
})

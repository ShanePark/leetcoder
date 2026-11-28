import { describe, expect, it } from 'vitest'

import type { AiProblemHelp, AiRequestUsage, AiReview } from '../../../src/backend'
import type { StoredAiReview } from '../../../src/app/ai-controller'
import {
  AI_REVIEW_EMPTY_COPY,
  formatReviewCost,
  formatReviewTokens,
  partialAiProblemHelp,
  partialAiReview,
  renderAiHelpDraft,
  renderAiReviewDraft,
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

const render = (stored: StoredAiReview | null, conversation: FakeElement | null = null): FakeElement => {
  const body = new FakeDocument().createElement('div')
  renderAiReviewPanel(body as unknown as HTMLElement, stored, conversation as unknown as HTMLElement | null)
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
  help: null,
  fileName: 'Q1TwoSum.java',
  servedModel: 'model-a',
  servedModelName: 'Model A',
  testRunOmitted,
  usage: requestUsage,
  pricing: null,
  request: {
    mode: 'review',
    selectedModelId: 'model-a',
    problemTitle: 'Two Sum',
    problemContent: '<p>Two Sum</p>',
    entryPoint: null,
    source: 'class Q1TwoSum {}',
    testRun: null,
    language: 'english',
  },
  target: { repoPath: '/repo', path: 'src/Q1TwoSum.java', repositoryGeneration: 1 },
  followUps: [],
})

const fullHelp: AiProblemHelp = {
  overview: 'Return the indices of two numbers that add up to the target.',
  keyPoints: ['Exactly one answer exists.', ' '],
  hints: ['What do you need to have seen to finish at one number?', 'Remember each value with its index.'],
}

const storedHelp = (help: AiProblemHelp): StoredAiReview => {
  const base = stored(fullReview, 'no-run')
  return { ...base, review: null, help, request: { ...base.request, mode: 'help' } }
}

describe('help panel', () => {
  it('renders the overview, key points, and ordered hints without a verdict or test note', () => {
    const body = render(storedHelp(fullHelp))
    expect(body.all('review-verdict')).toEqual([])
    expect(body.all('review-context')).toEqual([])
    expect(body.texts('review-meta')).toEqual(['Q1TwoSum.java · model-a'])
    expect(body.texts('review-section-title')).toEqual(['Overview', 'Key points', 'Hints'])
    expect(body.texts('review-text')).toEqual([fullHelp.overview])
    const [keyPoints, hints] = body.all('review-list')
    expect(keyPoints.tagName).toBe('ul')
    expect(keyPoints.children.map((item) => item.textContent)).toEqual(['Exactly one answer exists.'])
    expect(hints.tagName).toBe('ol')
    expect(hints.children.map((item) => item.textContent)).toEqual(fullHelp.hints)
  })

  it('leaves out empty sections and keeps the conversation last', () => {
    const conversation = new FakeDocument().createElement('section')
    const body = render(storedHelp({ overview: ' ', keyPoints: [], hints: ['Start small.'] }), conversation)
    expect(body.texts('review-section-title')).toEqual(['Hints'])
    expect(body.all('review-main')[0].children.at(-1)).toBe(conversation)
  })

  it('keeps the fields of partial help that have the right shape', () => {
    expect(partialAiProblemHelp(null)).toEqual({})
    expect(partialAiProblemHelp({ overview: 1, keyPoints: ['a', 2], hints: 'x' }))
      .toEqual({ overview: undefined, keyPoints: ['a'], hints: undefined })
  })

  it('renders a help draft with the status under the head', () => {
    const documentRef = new FakeDocument()
    const body = documentRef.createElement('div')
    const status = documentRef.createElement('p')
    status.className = 'review-stream-status'
    renderAiHelpDraft(body as unknown as HTMLElement, {
      fileName: 'Q1TwoSum.java',
      modelId: 'model-a',
      help: { overview: 'Return the' },
    }, status as unknown as HTMLElement)
    expect(body.all('review-head')[0].children.at(-1)).toBe(status)
    expect(body.texts('review-text')).toEqual(['Return the'])
    expect(body.all('review-main')[0].attributes.get('aria-busy')).toBe('true')
  })
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

describe('review usage slot', () => {
  it('puts the usage meter beside the review content', () => {
    const meter = new FakeDocument().createElement('aside')
    meter.className = 'review-usage'
    const body = new FakeDocument().createElement('div')
    renderAiReviewPanel(body as unknown as HTMLElement, stored(fullReview), null, meter as unknown as HTMLElement)

    const layout = body.children[0]
    expect(layout.className).toBe('review-layout')
    expect(layout.children.map((child) => child.className)).toEqual(['review-head', 'review-usage', 'review-main'])
    expect(layout.children[1]).toBe(meter)
  })

  it('leaves the slot out without a meter', () => {
    expect(render(stored(fullReview)).children[0].children.map((child) => child.className))
      .toEqual(['review-head', 'review-main'])
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
})

describe('streamed review', () => {
  it('keeps the fields that have the right shape and a verdict only once it is a whole word', () => {
    expect(partialAiReview(undefined)).toEqual({})
    expect(partialAiReview(['correct'])).toEqual({})
    expect(partialAiReview({ verdict: 'incor' }).verdict).toBeUndefined()
    expect(partialAiReview({
      verdict: 'incorrect',
      summary: 'Miss',
      failureCause: null,
      issues: ['a', 3],
      missedCases: [{ input: '[3' }, 'x', null],
      efficiency: { time: 'O(n)', space: 7 },
      improvements: 'none',
    })).toEqual({
      verdict: 'incorrect',
      summary: 'Miss',
      failureCause: undefined,
      issues: ['a'],
      missedCases: [{ input: '[3', reason: undefined }],
      efficiency: { time: 'O(n)', space: undefined, assessment: undefined },
      improvements: undefined,
    })
  })

  it('renders the sections so far with the status under the head and the meter beside them', () => {
    const documentRef = new FakeDocument()
    const body = documentRef.createElement('div')
    const status = documentRef.createElement('p')
    status.className = 'review-stream-status'
    const meter = documentRef.createElement('aside')
    meter.className = 'review-usage'
    renderAiReviewDraft(body as unknown as HTMLElement, {
      fileName: 'Q1TwoSum.java',
      modelId: 'model-a',
      testRunOmitted: 'no-run',
      review: { summary: 'Misses dup', issues: ['Wrong order'], efficiency: { time: 'O(' } },
    }, status as unknown as HTMLElement, meter as unknown as HTMLElement)

    const layout = body.children[0]
    expect(layout.children.map((child) => child.className)).toEqual(['review-head', 'review-usage', 'review-main'])
    expect(body.all('review-verdict')).toHaveLength(0)
    expect(body.texts('review-meta')).toEqual(['Q1TwoSum.java · model-a'])
    expect(body.texts('review-context')).toEqual(['Based on the code only, because it had no test run.'])
    expect(layout.children[0].children.at(-1)).toBe(status)
    expect(body.all('review-main')[0].attributes.get('aria-busy')).toBe('true')
    expect(body.texts('review-summary')).toEqual(['Misses dup'])
    expect(body.texts('review-section-title')).toEqual(['Issues', 'Efficiency'])
    expect(body.texts('review-efficiency-value')).toEqual(['O('])
  })

  it('shows the verdict once it arrives', () => {
    const documentRef = new FakeDocument()
    const body = documentRef.createElement('div')
    renderAiReviewDraft(body as unknown as HTMLElement, {
      fileName: 'Q1TwoSum.java',
      modelId: 'model-a',
      testRunOmitted: null,
      review: { verdict: 'correct' },
    }, documentRef.createElement('p') as unknown as HTMLElement)
    expect(body.all('review-verdict')[0]).toMatchObject({ className: 'review-verdict is-correct', textContent: 'Correct' })
    expect(body.all('review-section')).toHaveLength(0)
  })
})

describe('review follow-up slot', () => {
  it('puts the conversation after the review sections', () => {
    const conversation = new FakeDocument().createElement('section')
    conversation.className = 'review-follow-ups'
    const body = render(stored(fullReview), conversation)
    const main = body.all('review-main')[0]
    expect(main.children.at(-1)).toBe(conversation)
  })

  it('leaves the conversation out of the empty state', () => {
    const conversation = new FakeDocument().createElement('section')
    expect(render(null, conversation).children.map((child) => child.className)).toEqual(['review-empty'])
  })
})

import { describe, expect, it } from 'vitest'

import type { AiModelPricing, AiRequestUsage, AiStreamUsage } from '../../../src/backend'
import type { AiReviewStream, StoredAiReview } from '../../../src/app/ai-controller'
import type { AiReviewFollowUp } from '../../../src/app/ai-follow-up'
import {
  AiUsageMeter,
  CHARS_PER_OUTPUT_TOKEN,
  aiMeterState,
  aiMeterTotals,
  aiTokenCost,
  emptyLiveUsage,
  estimateOutputTokens,
  formatMeterCost,
  liveTokens,
  recordStreamUsage,
  type AiLiveUsage,
  type AiMeterState,
} from '../../../src/app/ai-usage-meter'

class FakeElement {
  className = ''
  textContent = ''
  title = ''
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

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

/** Animation frames run only when the test steps them, at the time it names. */
class FakeWindow {
  readonly frames = new Map<number, FrameRequestCallback>()
  private nextFrame = 1
  reduceMotion = false

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = this.nextFrame++
    this.frames.set(id, callback)
    return id
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id)
  }

  matchMedia(query: string): { matches: boolean } {
    return { matches: query === '(prefers-reduced-motion: reduce)' && this.reduceMotion }
  }

  step(time: number): void {
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) callback(time)
  }
}

class FakeDocument {
  constructor(readonly defaultView: FakeWindow | null) {}

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }
}

const tokens = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): AiStreamUsage =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })

const pricing: AiModelPricing = { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 }

const settled = (usage: AiStreamUsage, costUsd: number | null): AiRequestUsage => ({ ...usage, costUsd })

const live = (reported: AiStreamUsage | null, chars: number, final = false): AiLiveUsage => ({ reported, final, chars })

const storedReview = (followUps: AiReviewFollowUp[] = []): StoredAiReview => ({
  review: {
    verdict: 'correct',
    summary: '',
    failureCause: null,
    issues: [],
    missedCases: [],
    efficiency: { time: '', space: '', assessment: '' },
    improvements: [],
  },
  help: null,
  fileName: 'Q1TwoSum.java',
  servedModel: 'model-a',
  servedModelName: 'Model A',
  testRunOmitted: null,
  usage: settled(tokens(1_000, 100, 500), 0.0016),
  pricing,
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
  followUps,
})

const followUp = (usage: AiRequestUsage | null, liveUsage: AiLiveUsage = emptyLiveUsage()): AiReviewFollowUp => ({
  question: 'Why?',
  answer: 'Because.',
  status: usage ? 'done' : 'streaming',
  usage,
  preparingProposal: false,
  proposal: null,
  live: liveUsage,
})

const stream = (overrides: Partial<AiReviewStream> = {}): AiReviewStream => ({
  mode: 'review',
  fileName: 'Q1TwoSum.java',
  modelId: 'model-a',
  modelName: 'Model A',
  pricing,
  testRunOmitted: 'changed',
  startedAt: 0,
  text: '',
  live: emptyLiveUsage(),
  ...overrides,
})

describe('live usage', () => {
  it('estimates output at four characters a token, rounding up', () => {
    expect(CHARS_PER_OUTPUT_TOKEN).toBe(4)
    expect(estimateOutputTokens(0)).toBe(0)
    expect(estimateOutputTokens(1)).toBe(1)
    expect(estimateOutputTokens(8)).toBe(2)
    expect(estimateOutputTokens(9)).toBe(3)
  })

  it('counts streamed text and thinking and keeps the last reported counts', () => {
    const usage = emptyLiveUsage()
    recordStreamUsage(usage, { kind: 'usage', usage: tokens(900, 1, 300), final: false })
    recordStreamUsage(usage, { kind: 'thinking', chars: 10 })
    recordStreamUsage(usage, { kind: 'text', text: 'abcdef' })
    recordStreamUsage(usage, { kind: 'proposal-started' })
    expect(usage).toEqual(live(tokens(900, 1, 300), 16))
    recordStreamUsage(usage, { kind: 'usage', usage: tokens(900, 3, 300), final: true })
    expect(usage).toEqual(live(tokens(900, 3, 300), 16, true))
  })

  it('estimates output until the final count replaces it', () => {
    expect(liveTokens(emptyLiveUsage())).toEqual(tokens(0, 0))
    expect(liveTokens(live(null, 10))).toEqual(tokens(0, 3))
    expect(liveTokens(live(tokens(900, 1, 300), 40))).toEqual(tokens(900, 10, 300))
    // A reported count above the estimate wins while the stream runs.
    expect(liveTokens(live(tokens(900, 50), 40))).toEqual(tokens(900, 50))
    expect(liveTokens(live(tokens(900, 3), 400, true))).toEqual(tokens(900, 3))
  })

  it('prices tokens as the ledger does: a used class without a price leaves the cost unknown', () => {
    expect(aiTokenCost(tokens(1_000_000, 200_000, 1_000_000, 0), pricing)).toBeCloseTo(2.1, 9)
    expect(aiTokenCost(tokens(10, 1), null)).toBeNull()
    expect(aiTokenCost(tokens(10, 1), { ...pricing, cacheWritePerMTok: null })).toBeCloseTo(0.000015, 12)
    expect(aiTokenCost(tokens(10, 1, 0, 5), { ...pricing, cacheWritePerMTok: null })).toBeNull()
  })
})

describe('meter state', () => {
  it('counts a review on its way alone, as a new conversation', () => {
    const state = aiMeterState(storedReview([followUp(settled(tokens(1, 1), 0))]), stream({
      live: live(tokens(2_000, 1), 40),
    }))
    expect(state).toEqual({
      entries: [{ label: 'Review', tokens: tokens(2_000, 10), costUsd: 0.00205, estimated: true }],
      modelName: 'Model A',
      modelId: 'model-a',
      help: false,
      testRunOmitted: 'changed',
    })
  })

  it('labels a help answer as help, on its way and settled', () => {
    expect(aiMeterState(null, stream({ mode: 'help', testRunOmitted: 'no-run' }))).toMatchObject({
      entries: [{ label: 'Help' }],
      help: true,
    })
    const stored = storedReview([followUp(settled(tokens(1, 1), 0))])
    const state = aiMeterState({ ...stored, request: { ...stored.request, mode: 'help' } }, null)!
    expect(state.entries.map(({ label }) => label)).toEqual(['Help', 'Follow-up 1'])
    expect(state.help).toBe(true)
  })

  it('counts the review and each follow-up, settled or still running', () => {
    expect(aiMeterState(null, null)).toBeNull()
    const state = aiMeterState(storedReview([
      followUp(settled(tokens(1_200, 80, 1_000), null)),
      followUp(null, live(tokens(1_500, 1), 20)),
    ]), null)!
    expect(state.entries).toEqual([
      { label: 'Review', tokens: tokens(1_000, 100, 500), costUsd: 0.0016, estimated: false },
      { label: 'Follow-up 1', tokens: tokens(1_200, 80, 1_000), costUsd: null, estimated: false },
      { label: 'Follow-up 2', tokens: tokens(1_500, 5), costUsd: aiTokenCost(tokens(1_500, 5), pricing), estimated: true },
    ])
    expect(state.testRunOmitted).toBeNull()
  })

  it('sums the requests and counts the unpriced ones', () => {
    const entry = (costUsd: number | null, estimated = false) =>
      ({ label: 'x', tokens: tokens(10, 2, 3, 4), costUsd, estimated })
    expect(aiMeterTotals([entry(0.5), entry(null), entry(0.25, true)])).toEqual({
      tokens: tokens(30, 6, 9, 12),
      costUsd: 0.75,
      unpriced: 1,
      estimated: true,
    })
    expect(aiMeterTotals([entry(null)])).toMatchObject({ costUsd: null, unpriced: 1, estimated: false })
  })

  it('marks an estimated cost and names the unpriced requests', () => {
    expect(formatMeterCost(0.0123, false, 0)).toBe('$0.0123')
    expect(formatMeterCost(0.0123, true, 0)).toBe('≈ $0.0123')
    expect(formatMeterCost(0.0123, true, 2)).toBe('≈ $0.0123 + 2 unpriced')
    expect(formatMeterCost(null, true, 1)).toBe('Cost unknown')
  })
})

describe('usage meter', () => {
  const meterOf = (view: FakeWindow | null) => {
    const meter = new AiUsageMeter(new FakeDocument(view) as unknown as Document)
    const element = meter.element as unknown as FakeElement
    return { meter, element }
  }
  const state = (entries: AiMeterState['entries'], overrides: Partial<AiMeterState> = {}): AiMeterState => ({
    entries,
    modelName: 'Model A',
    modelId: 'model-a',
    help: false,
    testRunOmitted: null,
    ...overrides,
  })
  const entry = (usage: AiStreamUsage, costUsd: number | null, estimated = false, label = 'Review') =>
    ({ label, tokens: usage, costUsd, estimated })

  it('shows the cost, model, four token counts, requests, and test results', () => {
    const { meter, element } = meterOf(null)
    meter.update(state([
      entry(tokens(1_000, 100, 500, 0), 0.0016),
      entry(tokens(1_200, 80, 0, 64), null, false, 'Follow-up 1'),
    ]))

    expect(element.tagName).toBe('aside')
    expect(element.attributes.get('aria-label')).toBe('Conversation usage')
    expect(element.attributes.get('aria-busy')).toBe('false')
    expect(element.texts('review-usage-cost')).toEqual(['$0.0016 + 1 unpriced'])
    expect(element.all('review-usage-model')[0]).toMatchObject({ textContent: 'Model A', title: 'model-a' })
    expect(element.texts('review-usage-label')).toEqual(['Input', 'Output', 'Cache read', 'Cache write'])
    expect(element.texts('review-usage-value')).toEqual(['2,200', '180', '500', '64'])
    expect(element.texts('review-usage-summary')).toEqual(['2 requests'])
    expect(element.texts('review-usage-request-label')).toEqual(['Review', 'Follow-up 1'])
    expect(element.texts('review-usage-request-cost')).toEqual(['$0.0016', 'Cost unknown'])
    expect(element.texts('review-usage-request-tokens')).toEqual([
      '1,000 in · 100 out · 500 cache read',
      '1,200 in · 80 out · 64 cache write',
    ])
    expect(element.all('review-usage-tests')[0]).toMatchObject({
      className: 'review-usage-tests is-included',
      textContent: 'Test results included',
    })
  })

  it('marks a running request as estimated and says when the cost is unknown', () => {
    const { meter, element } = meterOf(null)
    meter.update(state([entry(tokens(10, 2), 0.25, true)], { testRunOmitted: 'no-run' }))
    expect(element.attributes.get('aria-busy')).toBe('true')
    expect(element.texts('review-usage-cost')).toEqual(['≈ $0.2500'])
    expect(element.all('review-usage-request')[0].className).toBe('review-usage-request is-estimated')
    expect(element.texts('review-usage-summary')).toEqual(['1 request'])
    expect(element.all('review-usage-tests')[0]).toMatchObject({ textContent: 'Test results not included', hidden: false })

    meter.update(state([entry(tokens(10, 2), 0.25, true, 'Help')], { help: true, testRunOmitted: 'no-run' }))
    expect(element.all('review-usage-tests')[0].hidden).toBe(true)

    meter.update(state([entry(tokens(10, 2), null)]))
    expect(element.all('review-usage-cost')[0]).toMatchObject({ className: 'review-usage-cost is-unknown', textContent: 'Cost unknown' })
  })

  it('rolls toward each new reading over animation frames without restarting mid-roll', () => {
    const view = new FakeWindow()
    const { meter, element } = meterOf(view)
    meter.update(state([entry(tokens(0, 0), 0, true)]))
    // The first reading is written at once.
    expect(element.texts('review-usage-value')).toEqual(['0', '0', '0', '0'])
    expect(view.frames.size).toBe(0)

    meter.update(state([entry(tokens(1_000, 400), 0.003, true)]))
    expect(element.texts('review-usage-value')[0]).toBe('0')
    view.step(100)
    expect(element.texts('review-usage-value')[0]).toBe('0')
    view.step(190)
    // One time constant closes all but 1/e of the gap.
    expect(element.texts('review-usage-value').slice(0, 2)).toEqual(['632', '253'])
    expect(element.texts('review-usage-cost')).toEqual(['≈ $0.0019'])

    // Readings that keep arriving retarget the same roll from what is shown.
    meter.update(state([entry(tokens(2_000, 400), 0.004, true)]))
    meter.update(state([entry(tokens(2_000, 400), 0.004)]))
    expect(view.frames.size).toBe(1)
    view.step(280)
    expect(element.texts('review-usage-value')[0]).toBe('1,497')
    view.step(1_000)
    expect(element.texts('review-usage-value').slice(0, 2)).toEqual(['2,000', '400'])
    expect(element.texts('review-usage-cost')).toEqual(['$0.0040'])
    expect(view.frames.size).toBe(0)
  })

  it('jumps to each reading under reduced motion, and after a reset', () => {
    const view = new FakeWindow()
    view.reduceMotion = true
    const { meter, element } = meterOf(view)
    meter.update(state([entry(tokens(10, 1), 0)]))
    meter.update(state([entry(tokens(500, 20), 0)]))
    expect(element.texts('review-usage-value')[0]).toBe('500')
    expect(view.frames.size).toBe(0)

    view.reduceMotion = false
    meter.update(state([entry(tokens(900, 20), 0)]))
    expect(view.frames.size).toBe(1)
    meter.reset()
    expect(view.frames.size).toBe(0)
    meter.update(state([entry(tokens(30, 2), 0)]))
    expect(element.texts('review-usage-value')[0]).toBe('30')
    meter.dispose()
  })
})

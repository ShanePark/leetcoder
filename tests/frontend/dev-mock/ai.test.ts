import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiGenerateRequest, AiProgress, AiReviewRequest } from '../../../src/backend'
import { createDevMockBackend } from '../../../src/dev-mock'

const day = 86_400_000
const reviewRequest: AiReviewRequest = {
  selectedModelId: null,
  problemTitle: 'Two Sum',
  problemContent: '<p>Input: nums = [3,2,4], target = 6</p>',
  entryPoint: 'public int[] twoSum(int[] nums, int target)',
  source: 'class Q1TwoSum {}',
  testRun: null,
  language: 'english',
}
const request: AiGenerateRequest = {
  selectedModelId: null,
  problemTitle: 'Check Divisibility by Digit Sum and Product',
  problemContent: '<pre>Input: n = 99\nOutput: true</pre>',
  entryPoint: 'public boolean checkDivisibility(int n) {',
  methodHeaders: ['public boolean checkDivisibility(int n)'],
  javaSnippet: null,
  psSignatures: [],
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function finishDelayed<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return pending
}

async function configuredBackend() {
  const backend = createDevMockBackend()
  await finishDelayed(backend.aiSaveKey('preview-key'))
  return backend
}

describe('browser preview AI key state', () => {
  it('starts with no key, saves one, and clears it per backend', async () => {
    const provider = { id: 'anthropic', displayName: 'Claude' }
    const backend = createDevMockBackend()
    expect(await backend.aiStatus()).toEqual({ configured: false, provider })
    expect(await finishDelayed(backend.aiSaveKey('preview-key'))).toEqual({ verified: true })
    expect(await backend.aiStatus()).toEqual({ configured: true, provider })
    expect(await createDevMockBackend().aiStatus()).toEqual({ configured: false, provider })
    await backend.aiClearKey()
    expect(await backend.aiStatus()).toEqual({ configured: false, provider })
  })

  it('never exposes or logs the key value', async () => {
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const secret = 'sk-preview-secret-value'
    const backend = createDevMockBackend()

    const results = [
      await finishDelayed(backend.aiSaveKey(secret)),
      await backend.aiStatus(),
      await finishDelayed(backend.aiListModels(true)),
      await finishDelayed(backend.aiGenerateTests(request)),
      await finishDelayed(backend.reviewAiCode(reviewRequest)),
      await backend.aiUsage([0]),
    ]

    expect(JSON.stringify(results)).not.toContain(secret)
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})

describe('browser preview AI models', () => {
  it('offers no models without a key', async () => {
    expect(await createDevMockBackend().aiListModels(true)).toEqual({
      models: [], defaultModelId: null, fetchedAt: null, error: null,
    })
  })

  it('lists models with a default that is active and one deprecated entry', async () => {
    const list = await finishDelayed((await configuredBackend()).aiListModels(false))
    expect(list.error).toBeNull()
    expect(list.models.filter((model) => model.deprecated)).toHaveLength(1)
    expect(list.models.find((model) => model.id === list.defaultModelId)?.deprecated).toBe(false)
  })

  it('prices the current models and leaves one without a price', async () => {
    const list = await finishDelayed((await configuredBackend()).aiListModels(false))
    expect(list.models.find((model) => model.id === 'claude-haiku-5')?.pricing).toEqual({
      inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25,
    })
    expect(list.models.filter((model) => model.pricing === null).map((model) => model.id)).toEqual(['claude-sonnet-4-5'])
  })

  it('keeps the fetch time until a refresh', async () => {
    const backend = await configuredBackend()
    const first = await finishDelayed(backend.aiListModels(false))
    expect(first.fetchedAt).toBe(Date.now())
    vi.advanceTimersByTime(1_000)
    expect((await finishDelayed(backend.aiListModels(false))).fetchedAt).toBe(first.fetchedAt)
    const refreshed = await finishDelayed(backend.aiListModels(true))
    expect(refreshed.fetchedAt).toBeGreaterThan(first.fetchedAt ?? Infinity)
  })
})

describe('browser preview AI generation', () => {
  it('requires a key', async () => {
    await expect(createDevMockBackend().aiGenerateTests(request)).rejects.toThrow('No API key is configured.')
  })

  it('returns one-line statements for the entry point with the default model', async () => {
    const backend = await configuredBackend()
    const { defaultModelId } = await finishDelayed(backend.aiListModels(false))
    expect(await finishDelayed(backend.aiGenerateTests(request))).toEqual({
      outcome: 'ok',
      statements: [
        'assertThat(checkDivisibility(99)).isTrue();',
        'assertThat(checkDivisibility(23)).isFalse();',
      ],
      servedModel: defaultModelId,
      fellBack: false,
    })
  })

  it('uses the method headers without a snippet and handles an unknown method', async () => {
    const backend = await configuredBackend()
    const twoSum = await finishDelayed(backend.aiGenerateTests({
      ...request,
      entryPoint: null,
      methodHeaders: ['public int[] twoSum(int[] nums, int target)'],
    }))
    expect(twoSum.statements[0]).toBe('assertThat(twoSum(new int[]{2, 7, 11, 15}, 9)).containsExactly(0, 1);')
    const unknown = await finishDelayed(backend.aiGenerateTests({
      ...request,
      entryPoint: 'public int constructor(int n)',
    }))
    expect(unknown.statements).toEqual(['assertThat(constructor()).isNotNull();'])
  })

  it('answers a failing case with a single statement', async () => {
    const backend = await configuredBackend()
    const twoSum = { ...request, entryPoint: 'public int[] twoSum(int[] nums, int target)' }
    const examples = await finishDelayed(backend.aiGenerateTests(twoSum))
    const failingCase = await finishDelayed(backend.aiGenerateTests({ ...twoSum, failingCase: 'nums =\n[1]' }))
    expect(examples.statements.length).toBeGreaterThan(1)
    expect(failingCase.statements).toEqual(examples.statements.slice(0, 1))
  })

  it('serves a pinned model and falls back when it left the list', async () => {
    const backend = await configuredBackend()
    const { models, defaultModelId } = await finishDelayed(backend.aiListModels(false))
    const deprecated = models.find((model) => model.deprecated)?.id ?? null
    expect(await finishDelayed(backend.aiGenerateTests({ ...request, selectedModelId: deprecated })))
      .toMatchObject({ servedModel: deprecated, fellBack: false })
    expect(await finishDelayed(backend.aiGenerateTests({ ...request, selectedModelId: 'retired-model' })))
      .toMatchObject({ servedModel: defaultModelId, fellBack: true })
  })
})

describe('browser preview AI progress', () => {
  it('reports the served model before the reply arrives, for both requests', async () => {
    const backend = await configuredBackend()
    for (const start of [
      (onProgress: (progress: AiProgress) => void) =>
        backend.aiGenerateTests({ ...request, selectedModelId: 'retired-model' }, onProgress),
      (onProgress: (progress: AiProgress) => void) =>
        backend.reviewAiCode({ ...reviewRequest, selectedModelId: 'retired-model' }, onProgress),
    ]) {
      const events: AiProgress[] = []
      let settled = false
      const pending = start((progress) => events.push(progress)).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(events).toEqual([{ stage: 'requesting', model: 'claude-sonnet-5-5' }])
      await vi.advanceTimersByTimeAsync(500)
      expect(events).toHaveLength(1)
      expect(settled).toBe(false)
      const result = await finishDelayed(pending)
      expect(events).toEqual([{ stage: 'requesting', model: 'claude-sonnet-5-5' }, { stage: 'received' }])
      expect(result).toMatchObject({ servedModel: 'claude-sonnet-5-5', fellBack: true })
    }
  })
})

describe('browser preview AI review', () => {
  it('requires a key and a non-empty file, without reporting progress', async () => {
    const events: AiProgress[] = []
    await expect(createDevMockBackend().reviewAiCode(reviewRequest, (progress) => events.push(progress)))
      .rejects.toThrow('No API key is configured.')
    const backend = await configuredBackend()
    await expect(backend.reviewAiCode({ ...reviewRequest, source: ' \n' }, (progress) => events.push(progress)))
      .rejects.toThrow('The solution file is empty.')
    expect(events).toEqual([])
  })

  it('explains the failure only when the last run failed', async () => {
    const backend = await configuredBackend()
    const run = {
      success: true,
      phase: 'test',
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 },
      tests: [{ name: 'test()', status: 'passed' }],
      diagnostics: [],
    }
    const noRun = await finishDelayed(backend.reviewAiCode(reviewRequest))
    const passed = await finishDelayed(backend.reviewAiCode({ ...reviewRequest, testRun: run }))
    const failed = await finishDelayed(backend.reviewAiCode({
      ...reviewRequest,
      testRun: { ...run, success: false, summary: { ...run.summary, passed: 0, failed: 1 } },
    }))

    expect(noRun).toMatchObject({ outcome: 'ok', servedModel: 'claude-sonnet-5-5', fellBack: false })
    expect(noRun.review?.failureCause).toBeNull()
    expect(passed.review).toEqual(noRun.review)
    expect(failed.review?.verdict).toBe('incorrect')
    expect(failed.review?.failureCause).toEqual(expect.any(String))
    for (const { review } of [noRun, failed]) {
      expect(review?.missedCases.length).toBeGreaterThan(0)
      expect(review?.efficiency.time).toBe('O(n)')
    }
  })

  it('records reviews in the ledger with the cost the result reports', async () => {
    const backend = await configuredBackend()
    const result = await finishDelayed(backend.reviewAiCode({ ...reviewRequest, selectedModelId: 'claude-haiku-5' }))
    expect(result.usage).toEqual({
      inputTokens: 2_480, outputTokens: 412, cacheReadTokens: 1_650, cacheWriteTokens: 0, costUsd: expect.any(Number),
    })
    expect(result.usage.costUsd).toBeCloseTo(0.004705, 9)
    const summary = await backend.aiUsage([Date.now() - 1])
    expect(summary.buckets[0].perModel).toEqual([
      {
        model: 'claude-haiku-5',
        totals: expect.objectContaining({ requests: 1, outputTokens: 412, costUsd: result.usage.costUsd }),
      },
    ])
  })

  it('reports no cost for a review by a model without a price', async () => {
    const backend = await configuredBackend()
    const result = await finishDelayed(backend.reviewAiCode({ ...reviewRequest, selectedModelId: 'claude-sonnet-4-5' }))
    expect(result.usage).toMatchObject({ inputTokens: 2_480, costUsd: null })
  })
})

describe('browser preview AI usage', () => {
  it('reports totals with unpriced requests, without needing a key', async () => {
    const summary = await createDevMockBackend().aiUsage([0])
    expect(summary.allTime).toMatchObject({
      requests: 14, unpricedRequests: 2, approximateRequests: 1, refusedRequests: 1,
    })
    expect(summary.allTime.costUsd).toBeCloseTo(0.181)
    expect(summary.skippedLines).toBe(0)
    expect(summary.buckets).toHaveLength(1)
    expect(summary.buckets[0].totals).toEqual(summary.allTime)
    expect(summary.buckets[0].perModel.map((row) => row.model)).toEqual([
      'claude-haiku-5', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5',
    ])
  })

  it('splits records at each start, leaving older ones to all time only', async () => {
    const now = Date.now()
    const summary = await createDevMockBackend().aiUsage([now - 4 * day, now - day / 2])

    expect(summary.buckets.map((bucket) => bucket.startMs)).toEqual([now - 4 * day, now - day / 2])
    expect(summary.buckets[0].totals).toMatchObject({ requests: 3, approximateRequests: 1 })
    expect(summary.buckets[1].totals.requests).toBe(3)
    expect(summary.buckets[1].perModel).toHaveLength(3)
    expect(summary.allTime.requests).toBe(14)
  })

  it('has several days of data for the day chart', async () => {
    const now = Date.now()
    const starts = Array.from({ length: 14 }, (_, index) => now - (13 - index) * day - 1)
    const { buckets } = await createDevMockBackend().aiUsage(starts)
    expect(buckets.filter((bucket) => bucket.totals.requests > 0).length).toBeGreaterThan(4)
  })

  it('records generations and keeps the ledger after the key is removed', async () => {
    const backend = await configuredBackend()
    const { servedModel } = await finishDelayed(backend.aiGenerateTests(request))
    await backend.aiClearKey()
    const summary = await backend.aiUsage([Date.now() - 1])
    expect(summary.buckets[0].totals.requests).toBe(1)
    expect(summary.allTime.requests).toBe(15)
    expect(summary.buckets[0].perModel.map((row) => row.model)).toContain(servedModel)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiGenerateRequest } from '../../../src/backend'
import { createDevMockBackend } from '../../../src/dev-mock'

const day = 86_400_000
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
    const backend = createDevMockBackend()
    expect(await backend.aiStatus()).toEqual({ configured: false })
    expect(await finishDelayed(backend.aiSaveKey('preview-key'))).toEqual({ verified: true })
    expect(await backend.aiStatus()).toEqual({ configured: true })
    expect(await createDevMockBackend().aiStatus()).toEqual({ configured: false })
    await backend.aiClearKey()
    expect(await backend.aiStatus()).toEqual({ configured: false })
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

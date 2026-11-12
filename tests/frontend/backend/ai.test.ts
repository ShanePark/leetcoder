import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  type AiGenerateRequest,
  type AiProgress,
  type AiReviewRequest,
  type AiUsageTotals,
  type Invoke,
} from '../../../src/backend'

const request: AiGenerateRequest = {
  selectedModelId: null,
  problemTitle: 'Two Sum',
  problemContent: '<p>Input: nums = [2,7]</p>',
  entryPoint: 'public int[] twoSum(int[] nums, int target)',
  methodHeaders: ['public int[] twoSum(int[] nums, int target)'],
  javaSnippet: null,
  psSignatures: ['int[][] intArray(String)'],
}

const requestUsage = {
  inputTokens: 2_480,
  outputTokens: 412,
  cacheReadTokens: 1_650,
  cacheWriteTokens: 0,
  costUsd: 0.014115,
}

const reviewRequest: AiReviewRequest = {
  selectedModelId: 'model-a',
  problemTitle: 'Two Sum',
  problemContent: '<p>Input: nums = [2,7]</p>',
  entryPoint: 'public int[] twoSum(int[] nums, int target)',
  source: 'class Q1TwoSum {}',
  testRun: {
    success: false,
    phase: 'test',
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0 },
    tests: [{ name: 'test()', status: 'failed', expected: '[0, 1]', actual: '[1, 0]' }],
    diagnostics: [],
  },
  language: 'korean',
}

const provider = { id: 'anthropic', displayName: 'Claude' }

const review = {
  verdict: 'incorrect',
  summary: 'The pair comes back reversed.',
  failureCause: 'The indices are swapped on return.',
  issues: ['The return swaps i and j.'],
  missedCases: [{ input: 'nums = [3,3], target = 6', reason: 'Duplicate values.' }],
  efficiency: { time: 'O(n)', space: 'O(n)', assessment: 'Fits the limits.' },
  improvements: [],
}

const totals: AiUsageTotals = {
  requests: 3,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  costUsd: 0.25,
  unpricedRequests: 1,
  approximateRequests: 0,
  refusedRequests: 1,
}

function clientReturning(response: unknown) {
  return createBackendClient(async () => response as never)
}

describe('AI command mapping', () => {
  it('invokes each native command with camelCase arguments', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const responses: Record<string, unknown> = {
      ai_status: { configured: true, provider },
      ai_save_key: { verified: true },
      ai_clear_key: undefined,
      ai_list_models: { models: [], defaultModelId: null, fetchedAt: null, error: null },
      ai_generate_tests: { outcome: 'ok', statements: [], servedModel: 'model-a', fellBack: false },
      ai_review_code: { outcome: 'refused', review: null, servedModel: 'model-a', fellBack: false, usage: requestUsage },
      ai_usage: { buckets: [], allTime: totals, skippedLines: 0 },
    }
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      return responses[command] as never
    }
    const client = createBackendClient(invoke)

    await client.aiStatus()
    await client.aiSaveKey('test-key')
    await expect(client.aiClearKey()).resolves.toBeUndefined()
    await client.aiListModels(true)
    await client.aiGenerateTests(request)
    await client.reviewAiCode(reviewRequest)
    await client.aiUsage([1_700_000_000_000, 1_700_000_100_000])

    expect(calls).toEqual([
      { command: 'ai_status', args: undefined },
      { command: 'ai_save_key', args: { apiKey: 'test-key' } },
      { command: 'ai_clear_key', args: undefined },
      { command: 'ai_list_models', args: { refresh: true } },
      { command: 'ai_generate_tests', args: { request, onProgress: expect.anything() } },
      { command: 'ai_review_code', args: { request: reviewRequest, onProgress: expect.anything() } },
      { command: 'ai_usage', args: { bucketStartsMs: [1_700_000_000_000, 1_700_000_100_000] } },
    ])
  })

  it.each([
    ['ai_generate_tests', (client: ReturnType<typeof createBackendClient>, onProgress: (p: AiProgress) => void) =>
      client.aiGenerateTests(request, onProgress)],
    ['ai_review_code', (client: ReturnType<typeof createBackendClient>, onProgress: (p: AiProgress) => void) =>
      client.reviewAiCode(reviewRequest, onProgress)],
  ])('forwards valid %s progress events and drops unknown ones', async (command, call) => {
    const responses: Record<string, unknown> = {
      ai_generate_tests: { outcome: 'ok', statements: [], servedModel: 'model-a', fellBack: false },
      ai_review_code: { outcome: 'ok', review, servedModel: 'model-a', fellBack: false, usage: requestUsage },
    }
    const client = createBackendClient(async (invoked, args) => {
      expect(invoked).toBe(command)
      const channel = args?.onProgress as { onmessage?: (event: unknown) => void }
      channel.onmessage?.({ stage: 'requesting', model: 'model-a', extra: true })
      channel.onmessage?.({ stage: 'requesting' })
      channel.onmessage?.({ stage: 'thinking' })
      channel.onmessage?.(null)
      channel.onmessage?.({ stage: 'received' })
      return responses[invoked] as never
    })
    const events: AiProgress[] = []
    await call(client, (progress) => events.push(progress))
    expect(events).toEqual([{ stage: 'requesting', model: 'model-a' }, { stage: 'received' }])
  })

  it('accepts progress without a handler', async () => {
    const client = createBackendClient(async (_command, args) => {
      const channel = args?.onProgress as { onmessage?: (event: unknown) => void }
      channel.onmessage?.({ stage: 'received' })
      return { outcome: 'ok', review, servedModel: 'model-a', fellBack: false, usage: requestUsage } as never
    })
    await expect(client.reviewAiCode(reviewRequest)).resolves.toMatchObject({ outcome: 'ok' })
  })

  it('propagates native errors from a rejected key', async () => {
    const client = createBackendClient(async () => {
      throw new Error('The API key was rejected (401 authentication_error).')
    })
    await expect(client.aiSaveKey('test-key')).rejects.toThrow('401 authentication_error')
  })
})

describe('AI status and key responses', () => {
  it('normalizes well-formed payloads', async () => {
    await expect(clientReturning({ configured: false, provider: { ...provider, extra: 1 } }).aiStatus())
      .resolves.toEqual({ configured: false, provider })
    await expect(clientReturning({ verified: false }).aiSaveKey('k')).resolves.toEqual({ verified: false })
  })

  it.each([
    null,
    {},
    { configured: 'yes', provider },
    [true],
    { configured: true },
    { configured: true, provider: null },
    { configured: true, provider: { id: '', displayName: 'Claude' } },
    { configured: true, provider: { id: 'anthropic' } },
  ])('rejects the malformed status %j', async (response) => {
    await expect(clientReturning(response).aiStatus()).rejects.toThrow('The AI status response was invalid.')
  })

  it.each([null, {}, { verified: 1 }])('rejects the malformed key result %j', async (response) => {
    await expect(clientReturning(response).aiSaveKey('k')).rejects.toThrow('The AI key save response was invalid.')
  })
})

describe('AI model list responses', () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
  const list = {
    models: [
      { id: 'model-a', displayName: 'Model A', deprecated: true, superseded: false, pricing },
      { id: 'model-b', displayName: 'Model B', deprecated: false, superseded: false, pricing: null },
    ],
    defaultModelId: 'model-a',
    fetchedAt: 1_700_000_000_000,
    error: 'refresh failed',
  }

  it('keeps the contract fields and drops anything else', async () => {
    const response = {
      ...list,
      models: [{ ...list.models[0], line: 'sonnet', pricing: { ...pricing, batchPerMTok: 1 } }, list.models[1]],
    }
    await expect(clientReturning(response).aiListModels(false)).resolves.toEqual(list)
  })

  it('accepts the nullable fields as null', async () => {
    const empty = { models: [], defaultModelId: null, fetchedAt: null, error: null }
    await expect(clientReturning(empty).aiListModels(false)).resolves.toEqual(empty)
  })

  it('accepts free and unknown cache prices', async () => {
    const response = {
      ...list,
      models: [{ ...list.models[0], pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: null, cacheWritePerMTok: null } }],
    }
    await expect(clientReturning(response).aiListModels(false)).resolves.toEqual(response)
  })

  it.each([
    ['a non-object', null],
    ['missing models', { ...list, models: undefined }],
    ['missing nullable fields', { models: [] }],
    ['an empty default id', { ...list, defaultModelId: '' }],
    ['a fractional timestamp', { ...list, fetchedAt: 1.5 }],
    ['a string timestamp', { ...list, fetchedAt: '1700000000000' }],
    ['a non-string error', { ...list, error: 500 }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).aiListModels(false)).rejects.toThrow(
      'The AI model list response was invalid.',
    )
  })

  it.each([
    ['a non-object', 'model-a'],
    ['an empty id', { id: '', displayName: 'Model A', deprecated: false, superseded: false }],
    ['a missing display name', { id: 'model-a', deprecated: false, superseded: false }],
    ['a non-boolean deprecated flag', { id: 'model-a', displayName: 'Model A', deprecated: 'no', superseded: false }],
    ['a non-boolean superseded flag', { id: 'model-a', displayName: 'Model A', deprecated: false, superseded: 'no' }],
  ])('rejects a model with %s', async (_name, model) => {
    await expect(clientReturning({ ...list, models: [model] }).aiListModels(false)).rejects.toThrow(
      'The AI model list contained an invalid model.',
    )
  })

  it.each([
    ['missing pricing', undefined],
    ['non-object pricing', 3],
    ['a negative input price', { ...pricing, inputPerMTok: -1 }],
    ['a NaN output price', { ...pricing, outputPerMTok: Number.NaN }],
    ['an infinite cache read price', { ...pricing, cacheReadPerMTok: Number.POSITIVE_INFINITY }],
    ['a string cache write price', { ...pricing, cacheWritePerMTok: '3.75' }],
    ['a missing cache write price', { ...pricing, cacheWritePerMTok: undefined }],
  ])('rejects a model with %s', async (_name, modelPricing) => {
    const response = { ...list, models: [{ ...list.models[0], pricing: modelPricing }] }
    await expect(clientReturning(response).aiListModels(false)).rejects.toThrow(
      'The AI model list contained invalid pricing.',
    )
  })
})

describe('AI generation responses', () => {
  const result = {
    outcome: 'ok',
    statements: ['assertThat(twoSum(new int[]{2, 7}, 9)).containsExactly(0, 1);'],
    servedModel: 'model-a',
    fellBack: true,
  }

  it('normalizes each outcome', async () => {
    const client = clientReturning(result)
    await expect(client.aiGenerateTests(request)).resolves.toEqual(result)
    for (const outcome of ['refused', 'truncated']) {
      const empty = { ...result, outcome, statements: [] }
      await expect(clientReturning(empty).aiGenerateTests(request)).resolves.toEqual(empty)
    }
  })

  it.each([
    ['a non-object', null],
    ['an unknown outcome', { ...result, outcome: 'error' }],
    ['non-string statements', { ...result, statements: [1] }],
    ['missing statements', { ...result, statements: undefined }],
    ['statements on a refusal', { ...result, outcome: 'refused' }],
    ['statements on a truncated result', { ...result, outcome: 'truncated' }],
    ['an empty served model', { ...result, servedModel: '' }],
    ['a non-boolean fallback flag', { ...result, fellBack: null }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).aiGenerateTests(request)).rejects.toThrow(
      'The AI test generation response was invalid.',
    )
  })
})

describe('AI review responses', () => {
  const result = { outcome: 'ok', review, servedModel: 'model-a', fellBack: true, usage: requestUsage }

  it('normalizes each outcome and drops fields outside the contract', async () => {
    const extra = {
      ...result,
      extra: 1,
      review: { ...review, extra: 1, efficiency: { ...review.efficiency, extra: 1 } },
      usage: { ...requestUsage, extra: 1 },
    }
    await expect(clientReturning(extra).reviewAiCode(reviewRequest)).resolves.toEqual(result)
    const noCause = { ...result, review: { ...review, failureCause: null } }
    await expect(clientReturning(noCause).reviewAiCode(reviewRequest)).resolves.toEqual(noCause)
    for (const outcome of ['refused', 'truncated']) {
      const empty = { ...result, outcome, review: null }
      await expect(clientReturning(empty).reviewAiCode(reviewRequest)).resolves.toEqual(empty)
    }
    const unpriced = { ...result, usage: { ...requestUsage, costUsd: null } }
    await expect(clientReturning(unpriced).reviewAiCode(reviewRequest)).resolves.toEqual(unpriced)
  })

  it.each([
    ['missing usage', undefined],
    ['a negative token count', { ...requestUsage, inputTokens: -1 }],
    ['a fractional token count', { ...requestUsage, outputTokens: 1.5 }],
    ['a missing token count', { ...requestUsage, cacheReadTokens: undefined }],
    ['a negative cost', { ...requestUsage, costUsd: -0.01 }],
    ['a NaN cost', { ...requestUsage, costUsd: Number.NaN }],
    ['a missing cost', { ...requestUsage, costUsd: undefined }],
  ])('rejects a result with %s', async (_name, usage) => {
    await expect(clientReturning({ ...result, usage }).reviewAiCode(reviewRequest)).rejects.toThrow(
      'The AI review response contained invalid usage.',
    )
  })

  it.each([
    ['a non-object', null],
    ['an unknown outcome', { ...result, outcome: 'error' }],
    ['a missing review on success', { ...result, review: null }],
    ['a review on a refusal', { ...result, outcome: 'refused' }],
    ['a review on a truncated result', { ...result, outcome: 'truncated' }],
    ['an empty served model', { ...result, servedModel: '' }],
    ['a non-boolean fallback flag', { ...result, fellBack: null }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).reviewAiCode(reviewRequest)).rejects.toThrow(
      'The AI review response was invalid.',
    )
  })

  it.each([
    ['an unknown verdict', { verdict: 'maybe' }],
    ['a missing summary', { summary: undefined }],
    ['an undefined failure cause', { failureCause: undefined }],
    ['non-string issues', { issues: [1] }],
    ['missing missed cases', { missedCases: undefined }],
    ['missing efficiency', { efficiency: null }],
    ['a non-string complexity', { efficiency: { ...review.efficiency, time: 1 } }],
    ['missing improvements', { improvements: undefined }],
  ])('rejects a review with %s', async (_name, change) => {
    await expect(clientReturning({ ...result, review: { ...review, ...change } }).reviewAiCode(reviewRequest))
      .rejects.toThrow('The AI review response contained an invalid review.')
  })

  it('rejects a review that is missing rather than null', async () => {
    await expect(clientReturning({ ...result, review: undefined }).reviewAiCode(reviewRequest))
      .rejects.toThrow('The AI review response contained an invalid review.')
  })

  it('rejects a malformed missed case', async () => {
    const response = { ...result, review: { ...review, missedCases: [{ input: 'x' }] } }
    await expect(clientReturning(response).reviewAiCode(reviewRequest)).rejects.toThrow(
      'The AI review response contained an invalid missed case.',
    )
  })
})

describe('AI usage responses', () => {
  const bucket = { startMs: 1_700_000_000_000, totals, perModel: [{ model: 'model-a', totals }] }
  const summary = {
    buckets: [bucket, { startMs: 1_700_000_100_000, totals, perModel: [] }],
    allTime: { ...totals, requests: 9 },
    skippedLines: 2,
  }

  it('normalizes a summary, including one with no buckets', async () => {
    await expect(clientReturning(summary).aiUsage([])).resolves.toEqual(summary)
    const noBuckets = { ...summary, buckets: [] }
    await expect(clientReturning(noBuckets).aiUsage([])).resolves.toEqual(noBuckets)
  })

  it.each([
    ['a non-object', null],
    ['missing buckets', { ...summary, buckets: undefined }],
    ['negative skipped lines', { ...summary, skippedLines: -1 }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).aiUsage([])).rejects.toThrow('The AI usage response was invalid.')
  })

  it.each([
    ['a non-object bucket', { ...summary, buckets: [null] }],
    ['a missing bucket start', { ...summary, buckets: [{ ...bucket, startMs: undefined }] }],
    ['a fractional bucket start', { ...summary, buckets: [{ ...bucket, startMs: 1.5 }] }],
    ['missing per-model rows', { ...summary, buckets: [{ ...bucket, perModel: undefined }] }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).aiUsage([])).rejects.toThrow(
      'The AI usage response contained an invalid bucket.',
    )
  })

  const inBucket = (values: unknown) => ({ ...summary, buckets: [{ ...bucket, totals: values }] })

  it.each([
    ['missing bucket totals', inBucket(undefined)],
    ['a missing all-time block', { ...summary, allTime: null }],
    ['fractional tokens', inBucket({ ...totals, inputTokens: 1.5 })],
    ['a negative count', { ...summary, allTime: { ...totals, unpricedRequests: -1 } }],
    ['a string count', inBucket({ ...totals, requests: '3' })],
    ['a missing count', inBucket({ ...totals, refusedRequests: undefined })],
    ['a non-finite cost', inBucket({ ...totals, costUsd: Number.NaN })],
    ['a negative cost', inBucket({ ...totals, costUsd: -0.01 })],
    ['invalid per-model totals', { ...summary, buckets: [{ ...bucket, perModel: [{ model: 'model-a', totals: {} }] }] }],
  ])('rejects %s', async (_name, response) => {
    await expect(clientReturning(response).aiUsage([])).rejects.toThrow(
      'The AI usage response contained invalid totals.',
    )
  })

  it('rejects a per-model row with no model name', async () => {
    const response = { ...summary, buckets: [{ ...bucket, perModel: [{ model: '', totals }] }] }
    await expect(clientReturning(response).aiUsage([])).rejects.toThrow(
      'The AI usage response contained an invalid model entry.',
    )
  })
})

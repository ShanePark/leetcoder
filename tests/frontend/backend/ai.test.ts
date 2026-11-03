import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  type AiGenerateRequest,
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
      ai_status: { configured: true },
      ai_save_key: { verified: true },
      ai_clear_key: undefined,
      ai_list_models: { models: [], defaultModelId: null, fetchedAt: null, error: null },
      ai_generate_tests: { outcome: 'ok', statements: [], servedModel: 'model-a', fellBack: false },
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
    await client.aiUsage([1_700_000_000_000, 1_700_000_100_000])

    expect(calls).toEqual([
      { command: 'ai_status', args: undefined },
      { command: 'ai_save_key', args: { apiKey: 'test-key' } },
      { command: 'ai_clear_key', args: undefined },
      { command: 'ai_list_models', args: { refresh: true } },
      { command: 'ai_generate_tests', args: { request } },
      { command: 'ai_usage', args: { bucketStartsMs: [1_700_000_000_000, 1_700_000_100_000] } },
    ])
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
    await expect(clientReturning({ configured: false }).aiStatus()).resolves.toEqual({ configured: false })
    await expect(clientReturning({ verified: false }).aiSaveKey('k')).resolves.toEqual({ verified: false })
  })

  it.each([null, {}, { configured: 'yes' }, [true]])('rejects the malformed status %j', async (response) => {
    await expect(clientReturning(response).aiStatus()).rejects.toThrow('The AI status response was invalid.')
  })

  it.each([null, {}, { verified: 1 }])('rejects the malformed key result %j', async (response) => {
    await expect(clientReturning(response).aiSaveKey('k')).rejects.toThrow('The AI key save response was invalid.')
  })
})

describe('AI model list responses', () => {
  const list = {
    models: [{ id: 'model-a', displayName: 'Model A', deprecated: true, superseded: false }],
    defaultModelId: 'model-a',
    fetchedAt: 1_700_000_000_000,
    error: 'refresh failed',
  }

  it('keeps the contract fields and drops anything else', async () => {
    const response = {
      ...list,
      models: [{ ...list.models[0], line: 'sonnet' }],
    }
    await expect(clientReturning(response).aiListModels(false)).resolves.toEqual(list)
  })

  it('accepts the nullable fields as null', async () => {
    const empty = { models: [], defaultModelId: null, fetchedAt: null, error: null }
    await expect(clientReturning(empty).aiListModels(false)).resolves.toEqual(empty)
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

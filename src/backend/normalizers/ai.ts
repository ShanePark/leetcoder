import type {
  AiGenerateResult,
  AiKeySaveResult,
  AiModel,
  AiModelList,
  AiStatus,
  AiUsageBucket,
  AiUsageSummary,
  AiUsageTotals,
} from '../contracts'
import { isRecord } from './common'

export function normalizeAiStatus(value: unknown): AiStatus {
  if (!isRecord(value) || typeof value.configured !== 'boolean') {
    throw new Error('The AI status response was invalid.')
  }
  return { configured: value.configured }
}

export function normalizeAiKeySaveResult(value: unknown): AiKeySaveResult {
  if (!isRecord(value) || typeof value.verified !== 'boolean') {
    throw new Error('The AI key save response was invalid.')
  }
  return { verified: value.verified }
}

export function normalizeAiModelList(value: unknown): AiModelList {
  if (
    !isRecord(value)
    || !Array.isArray(value.models)
    || !isNullableNonEmptyString(value.defaultModelId)
    || !isNullableTimestamp(value.fetchedAt)
    || !isNullableString(value.error)
  ) {
    throw new Error('The AI model list response was invalid.')
  }
  return {
    models: value.models.map(normalizeAiModel),
    defaultModelId: value.defaultModelId,
    fetchedAt: value.fetchedAt,
    error: value.error,
  }
}

function normalizeAiModel(value: unknown): AiModel {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.displayName)
    || typeof value.deprecated !== 'boolean'
    || typeof value.superseded !== 'boolean'
  ) {
    throw new Error('The AI model list contained an invalid model.')
  }
  return {
    id: value.id,
    displayName: value.displayName,
    deprecated: value.deprecated,
    superseded: value.superseded,
  }
}

export function normalizeAiGenerateResult(value: unknown): AiGenerateResult {
  if (
    !isRecord(value)
    || !isAiOutcome(value.outcome)
    || !isStringArray(value.statements)
    || !isNonEmptyString(value.servedModel)
    || typeof value.fellBack !== 'boolean'
    || (value.outcome !== 'ok' && value.statements.length > 0)
  ) {
    throw new Error('The AI test generation response was invalid.')
  }
  return {
    outcome: value.outcome,
    statements: value.statements,
    servedModel: value.servedModel,
    fellBack: value.fellBack,
  }
}

export function normalizeAiUsageSummary(value: unknown): AiUsageSummary {
  if (
    !isRecord(value)
    || !Array.isArray(value.buckets)
    || !isNonNegativeInteger(value.skippedLines)
  ) {
    throw new Error('The AI usage response was invalid.')
  }
  return {
    buckets: value.buckets.map(normalizeAiUsageBucket),
    allTime: normalizeAiUsageTotals(value.allTime),
    skippedLines: value.skippedLines,
  }
}

function normalizeAiUsageBucket(value: unknown): AiUsageBucket {
  if (!isRecord(value) || !Number.isSafeInteger(value.startMs) || !Array.isArray(value.perModel)) {
    throw new Error('The AI usage response contained an invalid bucket.')
  }
  return {
    startMs: value.startMs as number,
    totals: normalizeAiUsageTotals(value.totals),
    perModel: value.perModel.map((entry) => {
      if (!isRecord(entry) || !isNonEmptyString(entry.model)) {
        throw new Error('The AI usage response contained an invalid model entry.')
      }
      return { model: entry.model, totals: normalizeAiUsageTotals(entry.totals) }
    }),
  }
}

function normalizeAiUsageTotals(value: unknown): AiUsageTotals {
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.requests)
    || !isNonNegativeInteger(value.inputTokens)
    || !isNonNegativeInteger(value.outputTokens)
    || !isNonNegativeInteger(value.cacheReadTokens)
    || !isNonNegativeInteger(value.cacheWriteTokens)
    || typeof value.costUsd !== 'number'
    || !Number.isFinite(value.costUsd)
    || value.costUsd < 0
    || !isNonNegativeInteger(value.unpricedRequests)
    || !isNonNegativeInteger(value.approximateRequests)
    || !isNonNegativeInteger(value.refusedRequests)
  ) {
    throw new Error('The AI usage response contained invalid totals.')
  }
  return {
    requests: value.requests,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    costUsd: value.costUsd,
    unpricedRequests: value.unpricedRequests,
    approximateRequests: value.approximateRequests,
    refusedRequests: value.refusedRequests,
  }
}

function isAiOutcome(value: unknown): value is AiGenerateResult['outcome'] {
  return value === 'ok' || value === 'refused' || value === 'truncated'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

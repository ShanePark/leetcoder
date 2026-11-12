import type {
  AiGenerateResult,
  AiKeySaveResult,
  AiModel,
  AiModelList,
  AiModelPricing,
  AiProgress,
  AiRequestUsage,
  AiReview,
  AiReviewMissedCase,
  AiReviewResult,
  AiStatus,
  AiUsageBucket,
  AiUsageSummary,
  AiUsageTotals,
} from '../contracts'
import { isRecord } from './common'

export function normalizeAiStatus(value: unknown): AiStatus {
  if (
    !isRecord(value)
    || typeof value.configured !== 'boolean'
    || !isRecord(value.provider)
    || !isNonEmptyString(value.provider.id)
    || !isNonEmptyString(value.provider.displayName)
  ) {
    throw new Error('The AI status response was invalid.')
  }
  return {
    configured: value.configured,
    provider: { id: value.provider.id, displayName: value.provider.displayName },
  }
}

/** Returns null for an event this client does not understand, which is then ignored. */
export function normalizeAiProgress(value: unknown): AiProgress | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.stage === 'requesting' && isNonEmptyString(value.model)) {
    return { stage: 'requesting', model: value.model }
  }
  if (value.stage === 'received') {
    return { stage: 'received' }
  }
  return null
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
    pricing: value.pricing === null ? null : normalizeAiModelPricing(value.pricing),
  }
}

function normalizeAiModelPricing(value: unknown): AiModelPricing {
  if (
    !isRecord(value)
    || !isNonNegativeNumber(value.inputPerMTok)
    || !isNonNegativeNumber(value.outputPerMTok)
    || !isNullableNonNegativeNumber(value.cacheReadPerMTok)
    || !isNullableNonNegativeNumber(value.cacheWritePerMTok)
  ) {
    throw new Error('The AI model list contained invalid pricing.')
  }
  return {
    inputPerMTok: value.inputPerMTok,
    outputPerMTok: value.outputPerMTok,
    cacheReadPerMTok: value.cacheReadPerMTok,
    cacheWritePerMTok: value.cacheWritePerMTok,
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

export function normalizeAiReviewResult(value: unknown): AiReviewResult {
  if (
    !isRecord(value)
    || !isAiOutcome(value.outcome)
    || !isNonEmptyString(value.servedModel)
    || typeof value.fellBack !== 'boolean'
    || (value.outcome === 'ok') !== (value.review !== null)
  ) {
    throw new Error('The AI review response was invalid.')
  }
  return {
    outcome: value.outcome,
    review: value.review === null ? null : normalizeAiReview(value.review),
    servedModel: value.servedModel,
    fellBack: value.fellBack,
    usage: normalizeAiRequestUsage(value.usage),
  }
}

function normalizeAiRequestUsage(value: unknown): AiRequestUsage {
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.inputTokens)
    || !isNonNegativeInteger(value.outputTokens)
    || !isNonNegativeInteger(value.cacheReadTokens)
    || !isNonNegativeInteger(value.cacheWriteTokens)
    || !isNullableNonNegativeNumber(value.costUsd)
  ) {
    throw new Error('The AI review response contained invalid usage.')
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    costUsd: value.costUsd,
  }
}

function normalizeAiReview(value: unknown): AiReview {
  if (
    !isRecord(value)
    || !isAiReviewVerdict(value.verdict)
    || typeof value.summary !== 'string'
    || !isNullableString(value.failureCause)
    || !isStringArray(value.issues)
    || !Array.isArray(value.missedCases)
    || !isRecord(value.efficiency)
    || typeof value.efficiency.time !== 'string'
    || typeof value.efficiency.space !== 'string'
    || typeof value.efficiency.assessment !== 'string'
    || !isStringArray(value.improvements)
  ) {
    throw new Error('The AI review response contained an invalid review.')
  }
  return {
    verdict: value.verdict,
    summary: value.summary,
    failureCause: value.failureCause,
    issues: value.issues,
    missedCases: value.missedCases.map(normalizeAiReviewMissedCase),
    efficiency: {
      time: value.efficiency.time,
      space: value.efficiency.space,
      assessment: value.efficiency.assessment,
    },
    improvements: value.improvements,
  }
}

function normalizeAiReviewMissedCase(value: unknown): AiReviewMissedCase {
  if (!isRecord(value) || typeof value.input !== 'string' || typeof value.reason !== 'string') {
    throw new Error('The AI review response contained an invalid missed case.')
  }
  return { input: value.input, reason: value.reason }
}

function isAiReviewVerdict(value: unknown): value is AiReview['verdict'] {
  return value === 'correct' || value === 'incorrect' || value === 'unsure'
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

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value)
}

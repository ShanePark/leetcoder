import type {
  AiStreamEvent,
  AiGenerateRequest,
  AiGenerateResult,
  AiKeySaveResult,
  AiModelList,
  AiModel,
  AiProgressHandler,
  AiReviewFollowUpRequest,
  AiReviewFollowUpResult,
  AiReviewRequest,
  AiReviewResult,
  AiStatus,
  AiUsageSummary,
  AiUsageTotals,
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitFileChange,
  GitPullResult,
  GitPushResult,
  ProblemFileEntry,
  PsLibraryMetadata,
  ProjectSearchMatch,
  ProjectSearchResult,
  ProjectValidation,
  UpdateBuild,
  UpdateStatus,
} from '../backend'
import type { ProblemFilePlan } from '../domain'
import {
  AI_DEFAULT_MODEL_ID,
  AI_EDIT_REQUEST,
  AI_FAILING_REVIEW,
  AI_FOLLOW_UP_ANSWER,
  AI_FOLLOW_UP_EDIT_ANSWER,
  AI_FOLLOW_UP_TOKENS,
  AI_GENERATION_USAGE,
  AI_MODELS,
  AI_PROBLEM_HELP,
  AI_REVIEW,
  AI_REVIEW_TOKENS,
  AI_STATEMENTS,
  DAILY_PROBLEM,
  MANUAL_PROBLEM,
  MODIFIED_DIFF,
  addedDiffFor,
  mockProposal,
  seedAiUsage,
  seedFiles,
  type AiUsageEntry,
} from './fixtures'
import { delay } from './runtime'
import { createMockTestRunner } from './test-runner'

export function createDevMockBackend(): BackendClient & {
  getGitStatus(repoPath: string): Promise<unknown>
} {
  const files = seedFiles()
  const originalFiles = new Map(files)
  const gitAddedPath = 'src/main/java/shane/leetcode/problems/easy/Q3618SplitArrayByPrimeIndices.java'
  let gitChanges: Array<GitFileChange & { additions: number | null; deletions: number | null }> = [
    {
      path: 'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      status: 'modified',
      indexStatus: '.',
      worktreeStatus: 'M',
      additions: 12,
      deletions: 4,
    },
    {
      path: gitAddedPath,
      status: 'added',
      indexStatus: 'A',
      worktreeStatus: '.',
      additions: 58,
      deletions: 0,
    },
    {
      path: 'notes/scratchpad.md',
      status: 'untracked',
      indexStatus: '?',
      worktreeStatus: '?',
      additions: null,
      deletions: null,
    },
  ]
  let unpushedCommits = 0

  return {
    async validateProject(): Promise<ProjectValidation> {
      return { valid: true }
    },

    async inspectPsLibrary(): Promise<PsLibraryMetadata> {
      return { fingerprint: 'preview', methods: [] }
    },

    async fetchDailyProblem(): Promise<DailyProblem> {
      await delay(350)
      return DAILY_PROBLEM
    },

    async fetchProblemBySlug(titleSlug: string): Promise<DailyProblem> {
      await delay(350)
      if (titleSlug === MANUAL_PROBLEM.titleSlug) {
        return MANUAL_PROBLEM
      }
      if (titleSlug === DAILY_PROBLEM.titleSlug) {
        return { ...DAILY_PROBLEM, date: '' }
      }
      throw new Error(`Problem ${titleSlug} was not found in the preview.`)
    },

    async listProblemFiles(): Promise<ProblemFileEntry[]> {
      return [...files.keys()].sort().map(entryFor)
    },

    async searchProject(
      _repoPath: string,
      query: string,
      caseSensitive: boolean,
      excludePaths: readonly string[] = [],
    ): Promise<ProjectSearchResult> {
      if (query.length === 0) {
        return { matches: [], truncated: false, skippedFiles: 0 }
      }
      const needle = caseSensitive ? query : query.toLowerCase()
      const matches: ProjectSearchMatch[] = []
      const excludedPaths = new Set(excludePaths)
      for (const [path, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (excludedPaths.has(path)) {
          continue
        }
        const lines = content.split(/\r?\n/)
        const matchIndex = lines.findIndex((line) => {
          const candidate = caseSensitive ? line : line.toLowerCase()
          return candidate.indexOf(needle) >= 0
        })
        if (matchIndex < 0) {
          continue
        }
        if (matches.length === 500) {
          return { matches, truncated: true, skippedFiles: 0 }
        }
        const line = lines[matchIndex] ?? ''
        const candidate = caseSensitive ? line : line.toLowerCase()
        const index = candidate.indexOf(needle)
        const column = index + 1
        matches.push({ path, line: matchIndex + 1, column, preview: line.slice(0, 240) })
      }
      return { matches, truncated: false, skippedFiles: 0 }
    },

    async readProblemFile(_repoPath: string, path: string): Promise<string> {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      return source
    },

    async createProblemFile(_repoPath: string, plan: ProblemFilePlan): Promise<void> {
      files.set(plan.path, plan.source)
    },

    async saveProblemFile(_repoPath: string, path: string, content: string): Promise<void> {
      await delay(120)
      files.set(path, content)
    },

    async deleteProblemFile(_repoPath: string, path: string): Promise<void> {
      files.delete(path)
    },

    async duplicateProblemFile(_repoPath: string, path: string) {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      const slash = path.lastIndexOf('/')
      const directory = slash >= 0 ? path.slice(0, slash) : ''
      const name = path.slice(slash + 1)
      const extensionIndex = name.lastIndexOf('.')
      const stem = extensionIndex >= 0 ? name.slice(0, extensionIndex) : name
      const extension = extensionIndex >= 0 ? name.slice(extensionIndex) : ''
      const names = new Set(
        [...files.keys()]
          .filter((candidate) => candidate.startsWith(`${directory}/`))
          .map((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')),
      )
      let suffix = 2
      let candidateStem = `${stem}${suffix}`
      while (names.has(candidateStem)) {
        suffix += 1
        candidateStem = `${stem}${suffix}`
      }
      const candidatePath = `${directory}/${candidateStem}${extension}`
      const copied = source.replace(new RegExp(`\\b${escapeRegExp(stem)}\\b`, 'g'), candidateStem)
      files.set(candidatePath, copied)
      return { relativePath: candidatePath, content: copied }
    },

    async renameProblemFile(_repoPath: string, path: string, newPath: string) {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      const slash = path.lastIndexOf('/')
      const directory = slash >= 0 ? path.slice(0, slash) : ''
      const name = path.slice(slash + 1)
      const extensionIndex = name.lastIndexOf('.')
      const extension = extensionIndex >= 0 ? name.slice(extensionIndex) : ''
      const targetName = newPath.includes('/') ? newPath.slice(newPath.lastIndexOf('/') + 1) : newPath
      const target = newPath.includes('/') ? newPath : `${directory}/${newPath}`
      const targetPath = /\.[^.]+$/.test(targetName) ? target : `${target}${extension}`
      if (files.has(targetPath)) {
        throw new Error(`File already exists: ${targetPath}`)
      }
      const oldStem = extensionIndex >= 0 ? name.slice(0, extensionIndex) : name
      const destinationName = targetPath.slice(targetPath.lastIndexOf('/') + 1)
      const destinationExtensionIndex = destinationName.lastIndexOf('.')
      const destinationStem = destinationExtensionIndex >= 0
        ? destinationName.slice(0, destinationExtensionIndex)
        : destinationName
      const renamed = source.replace(new RegExp(`\\b${escapeRegExp(oldStem)}\\b`, 'g'), destinationStem)
      files.delete(path)
      files.set(targetPath, renamed)
      return { relativePath: targetPath, content: renamed }
    },

    async getGitStatus(): Promise<unknown> {
      await delay(150)
      return { branch: 'main', files: gitChanges }
    },

    async listGitChanges(): Promise<GitFileChange[]> {
      return gitChanges
    },

    async discardGitChanges(_repoPath: string, path: string): Promise<void> {
      const change = gitChanges.find((entry) => entry.path === path)
      if (!change) {
        throw new Error(`The selected path is not currently changed: ${path}`)
      }
      const isNew = change.status === 'added' || change.status === 'untracked'
      if (isNew) {
        files.delete(path)
      } else {
        const original = originalFiles.get(path)
        if (original !== undefined) {
          files.set(path, original)
        }
      }
      gitChanges = gitChanges.filter((entry) => entry.path !== path)
    },

    async showInFileManager(): Promise<void> {
      // The browser preview has no native file manager to open.
    },

    async getGitDiff(_repoPath: string, paths: string[]): Promise<string> {
      await delay(150)
      return paths
        .map((path) => {
          if (path.endsWith('Q1TwoSum.java')) {
            return MODIFIED_DIFF
          }
          const source = files.get(path) ?? '# scratch notes\n\n- revisit DP problems\n'
          return addedDiffFor(path, source)
        })
        .join('')
    },

    async commitGit(_repoPath: string, paths: string[], message: string): Promise<GitCommitResult> {
      await delay(300)
      gitChanges = gitChanges.filter((change) => !paths.includes(change.path))
      unpushedCommits += 1
      return { commitHash: 'a1b2c3d4e5f60789', message, paths }
    },

    async pullGit(): Promise<GitPullResult> {
      await delay(300)
      return { updated: false, output: 'Already up to date with origin/main.' }
    },

    async pushGit(): Promise<GitPushResult> {
      await delay(500)
      unpushedCommits = 0
      return { output: 'To github.com:shane/ps.git', branch: 'main' }
    },

    async countUnpushedGitCommits(): Promise<number> {
      return unpushedCommits
    },

    ...createMockTestRunner(),

    // The browser preview has no filesystem watcher behind it.
    async watchRepository(): Promise<void> {},

    async stopWatchingRepository(): Promise<void> {},

    async onRepositoryFilesChanged(): Promise<() => void> {
      return () => {}
    },

    async checkForUpdate(): Promise<UpdateStatus> {
      return {
        supported: false,
        available: false,
        currentCommit: '',
        latestCommit: '',
      }
    },

    async buildUpdate(): Promise<UpdateBuild> {
      throw new Error('Updates are unavailable in the browser preview.')
    },

    async applyUpdate(): Promise<void> {
      throw new Error('Updates are unavailable in the browser preview.')
    },

    ...createMockAi(),
  }
}

type MockAi = Pick<
  BackendClient,
  | 'aiStatus'
  | 'aiSaveKey'
  | 'aiClearKey'
  | 'aiListModels'
  | 'aiGenerateTests'
  | 'reviewAiCode'
  | 'askAiReviewFollowUp'
  | 'aiUsage'
>

function createMockAi(): MockAi {
  const usage = seedAiUsage(Date.now())
  let configured = false
  let modelsFetchedAt: number | null = null

  return {
    async aiStatus(): Promise<AiStatus> {
      return { configured, provider: { id: 'anthropic', displayName: 'Claude' } }
    },

    // The key argument is deliberately not declared: the preview only records that one was saved.
    async aiSaveKey(): Promise<AiKeySaveResult> {
      await delay(250)
      configured = true
      return { verified: true }
    },

    async aiClearKey(): Promise<void> {
      configured = false
    },

    async aiListModels(refresh: boolean): Promise<AiModelList> {
      if (!configured) {
        return { models: [], defaultModelId: null, fetchedAt: null, error: null }
      }
      await delay(150)
      if (refresh || modelsFetchedAt === null) {
        modelsFetchedAt = Date.now()
      }
      return {
        models: [...AI_MODELS],
        defaultModelId: AI_DEFAULT_MODEL_ID,
        fetchedAt: modelsFetchedAt,
        error: null,
      }
    },

    async aiGenerateTests(
      request: AiGenerateRequest,
      onProgress?: AiProgressHandler,
    ): Promise<AiGenerateResult> {
      if (!configured) {
        throw new Error('No API key is configured.')
      }
      const { servedModel, fellBack } = mockServedModel(request.selectedModelId)
      await mockAiRequest(servedModel, 900, onProgress)
      usage.push({ ...AI_GENERATION_USAGE, ts: Date.now(), model: servedModel })
      return { outcome: 'ok', statements: mockAiStatements(request), servedModel, fellBack }
    },

    async reviewAiCode(
      request: AiReviewRequest,
      onProgress?: AiProgressHandler,
      onEvent?: (event: AiStreamEvent) => void,
    ): Promise<AiReviewResult> {
      if (!configured) {
        throw new Error('No API key is configured.')
      }
      if (request.source.trim() === '') {
        throw new Error('The solution file is empty.')
      }
      const { servedModel, fellBack } = mockServedModel(request.selectedModelId)
      const help = request.mode === 'help'
      const failed = !help && request.testRun !== null && !request.testRun.success
      const review = help ? null : failed ? AI_FAILING_REVIEW : AI_REVIEW
      await delay(100)
      onProgress?.({ stage: 'requesting', model: servedModel })
      await delay(400)
      onEvent?.(mockStreamUsage(AI_REVIEW_TOKENS, false))
      // A thinking pause, then the answer's JSON in small pieces over about 2.5 seconds.
      onEvent?.({ kind: 'thinking', chars: 0 })
      for (let step = 0; step < 6; step += 1) {
        await delay(250)
        onEvent?.({ kind: 'thinking', chars: 40 })
      }
      const pieces = JSON.stringify(review ?? AI_PROBLEM_HELP).match(/[\s\S]{1,16}/g) ?? []
      for (const piece of pieces) {
        onEvent?.({ kind: 'text', text: piece })
        await delay(Math.round(2_500 / pieces.length))
      }
      onEvent?.(mockStreamUsage(AI_REVIEW_TOKENS, true))
      onProgress?.({ stage: 'received' })
      await delay(100)
      const requestUsage = mockRequestUsage(servedModel, AI_REVIEW_TOKENS)
      usage.push({ ...requestUsage, approximate: false, refused: false, ts: Date.now(), model: servedModel })
      return {
        outcome: 'ok',
        review,
        help: help ? AI_PROBLEM_HELP : null,
        servedModel,
        fellBack,
        usage: requestUsage,
      }
    },

    async askAiReviewFollowUp(
      request: AiReviewFollowUpRequest,
      onEvent?: (event: AiStreamEvent) => void,
    ): Promise<AiReviewFollowUpResult> {
      if (!configured) {
        throw new Error('No API key is configured.')
      }
      if (request.question.trim() === '') {
        throw new Error('The question is empty.')
      }
      const help = request.review.mode === 'help'
      if ((help ? request.helpAnswer : request.reviewAnswer) === null
        || (help ? request.reviewAnswer : request.helpAnswer) !== null) {
        throw new Error('The follow-up answer does not match the request mode.')
      }
      const { servedModel, fellBack } = mockServedModel(request.selectedModelId)
      const editing = AI_EDIT_REQUEST.test(request.question)
      const answer = editing ? AI_FOLLOW_UP_EDIT_ANSWER : AI_FOLLOW_UP_ANSWER
      await delay(300)
      onEvent?.(mockStreamUsage(AI_FOLLOW_UP_TOKENS, false))
      // About 1.5 seconds of small pieces, as a streamed answer arrives.
      const pieces = answer.match(/[\s\S]{1,12}/g) ?? []
      for (const piece of pieces) {
        onEvent?.({ kind: 'text', text: piece })
        await delay(Math.round(1_500 / pieces.length))
      }
      if (editing) {
        // The change arrives whole after a moment, as a tool call's input does.
        onEvent?.({ kind: 'proposal-started' })
        await delay(1_200)
      }
      onEvent?.(mockStreamUsage(AI_FOLLOW_UP_TOKENS, true))
      const requestUsage = mockRequestUsage(servedModel, AI_FOLLOW_UP_TOKENS)
      usage.push({ ...requestUsage, approximate: false, refused: false, ts: Date.now(), model: servedModel })
      const proposal = editing ? { ...mockProposal(request.currentCode), baseCode: request.currentCode } : null
      return { outcome: 'ok', answer, proposal, servedModel, fellBack, usage: requestUsage }
    },

    async aiUsage(bucketStartsMs: number[]): Promise<AiUsageSummary> {
      return {
        buckets: bucketStartsMs.map((startMs, index) => {
          const end = bucketStartsMs[index + 1] ?? Number.POSITIVE_INFINITY
          const entries = usage.filter((entry) => entry.ts >= startMs && entry.ts < end)
          const models = [...new Set(entries.map((entry) => entry.model))].sort()
          return {
            startMs,
            totals: sumAiUsage(entries),
            perModel: models.map((model) => ({
              model,
              totals: sumAiUsage(entries.filter((entry) => entry.model === model)),
            })),
          }
        }),
        allTime: sumAiUsage(usage),
        skippedLines: 0,
      }
    },
  }
}

/** A pinned model that left the list falls back to the default, as the native command does. */
function mockServedModel(selectedModelId: string | null): { servedModel: string; fellBack: boolean } {
  const fellBack = selectedModelId !== null && !AI_MODELS.some((model) => model.id === selectedModelId)
  return { servedModel: selectedModelId === null || fellBack ? AI_DEFAULT_MODEL_ID : selectedModelId, fellBack }
}

/** Reports progress like the native commands; most of `totalMs` is spent waiting for the reply. */
async function mockAiRequest(
  model: string,
  totalMs: number,
  onProgress: AiProgressHandler | undefined,
): Promise<void> {
  await delay(100)
  onProgress?.({ stage: 'requesting', model })
  await delay(totalMs - 200)
  onProgress?.({ stage: 'received' })
  await delay(100)
}

/**
 * The counts a stream reports: the message start carries the input and cache
 * counts with a token of output, and the end carries the final counts.
 */
function mockStreamUsage(tokens: Omit<AiRequestUsage, 'costUsd'>, final: boolean): AiStreamEvent {
  return { kind: 'usage', usage: { ...tokens, outputTokens: final ? tokens.outputTokens : 1 }, final }
}

/** Prices tokens as the native ledger does: a used token class without a price leaves the cost unknown. */
type AiRequestUsage = AiReviewResult['usage']

function mockRequestUsage(model: string, tokens: Omit<AiRequestUsage, 'costUsd'>): AiRequestUsage {
  const pricing = AI_MODELS.find((entry) => entry.id === model)?.pricing ?? null
  return { ...tokens, costUsd: pricing === null ? null : mockCost(tokens, pricing) }
}

function mockCost(tokens: Omit<AiRequestUsage, 'costUsd'>, pricing: NonNullable<AiModel['pricing']>): number | null {
  const classes: [number, number | null][] = [
    [tokens.inputTokens, pricing.inputPerMTok],
    [tokens.outputTokens, pricing.outputPerMTok],
    [tokens.cacheReadTokens, pricing.cacheReadPerMTok],
    [tokens.cacheWriteTokens, pricing.cacheWritePerMTok],
  ]
  let cost = 0
  for (const [count, perMTok] of classes) {
    if (count === 0) {
      continue
    }
    if (perMTok === null) {
      return null
    }
    cost += (count / 1_000_000) * perMTok
  }
  return cost
}

function mockAiStatements(request: AiGenerateRequest): string[] {
  const signature = request.entryPoint ?? request.methodHeaders[0] ?? ''
  const method = /(\w+)\s*\(/.exec(signature)?.[1] ?? 'solve'
  const statements = AI_STATEMENTS.get(method) ?? [`assertThat(${method}()).isNotNull();`]
  // A failing case is a single case, so it gets a single statement.
  return request.failingCase === undefined ? [...statements] : statements.slice(0, 1)
}

function sumAiUsage(entries: readonly AiUsageEntry[]): AiUsageTotals {
  const totals: AiUsageTotals = {
    requests: entries.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    approximateRequests: 0,
    refusedRequests: 0,
  }
  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens
    totals.outputTokens += entry.outputTokens
    totals.cacheReadTokens += entry.cacheReadTokens
    totals.cacheWriteTokens += entry.cacheWriteTokens
    totals.costUsd += entry.costUsd ?? 0
    totals.unpricedRequests += entry.costUsd === null ? 1 : 0
    totals.approximateRequests += entry.approximate ? 1 : 0
    totals.refusedRequests += entry.refused ? 1 : 0
  }
  return totals
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function entryFor(path: string): ProblemFileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const segment = /\/easy\//.test(path)
    ? 'easy'
    : /\/medium\//.test(path)
      ? 'medium'
      : /\/xhard\//.test(path)
        ? 'xhard'
        : 'other'
  return { path, name, packageSegment: segment }
}

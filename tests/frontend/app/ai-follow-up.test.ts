import { describe, expect, it, vi } from 'vitest'

import type {
  AiStreamEvent,
  AiGenerateResult,
  AiProblemHelp,
  AiRequestUsage,
  AiReview,
  AiReviewFollowUpResult,
  AiReviewRequest,
  AiReviewResult,
} from '../../../src/backend'
import {
  createAiController,
  type AiControllerApi,
  type AiControllerUi,
  type StoredAiReview,
} from '../../../src/app/ai-controller'
import {
  aiFollowUpHistory,
  aiFollowUpProposal,
  type AiReviewFollowUp,
} from '../../../src/app/ai-follow-up'
import { emptyLiveUsage } from '../../../src/app/ai-usage-meter'

const provider = { id: 'anthropic', displayName: 'Claude' }

const usage: AiRequestUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 }

const review: AiReview = {
  verdict: 'incorrect',
  summary: 'Misses duplicates.',
  failureCause: null,
  issues: [],
  missedCases: [],
  efficiency: { time: 'O(n)', space: 'O(n)', assessment: '' },
  improvements: [],
}

const reviewRequest: AiReviewRequest = {
  mode: 'review',
  selectedModelId: 'model-picked',
  problemTitle: 'Two Sum',
  problemContent: '<p>Two Sum</p>',
  entryPoint: null,
  source: 'class Q1TwoSum { /* as reviewed */ }',
  testRun: null,
  language: 'korean',
}

const okResult: AiReviewFollowUpResult = {
  outcome: 'ok',
  answer: 'Full answer.',
  proposal: null,
  servedModel: 'model-served',
  fellBack: false,
  usage,
}

const turn = (overrides: Partial<AiReviewFollowUp>): AiReviewFollowUp => ({
  question: 'Q',
  answer: 'A',
  status: 'done',
  usage,
  preparingProposal: false,
  proposal: null,
  live: emptyLiveUsage(),
  ...overrides,
})

const target = { repoPath: '/repo', path: 'src/Q1TwoSum.java', repositoryGeneration: 1 }
// Written code, so the editor toolbar offers a review rather than help.
const editedSource = 'class Q1TwoSum { int solve() { return 0; /* edited since */ } }'

const pendingProposal = (baseCode = editedSource) => aiFollowUpProposal({
  summary: 'Return early',
  code: 'class Q1TwoSum { /* changed */ }',
  baseCode,
})

const storedReview = (followUps: AiReviewFollowUp[] = []): StoredAiReview => ({
  review,
  help: null,
  fileName: 'Q1TwoSum.java',
  servedModel: 'model-served',
  servedModelName: 'Served',
  testRunOmitted: 'no-run',
  usage,
  pricing: null,
  request: reviewRequest,
  target,
  followUps,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(api: Partial<AiControllerApi> = {}, ui: Partial<AiControllerUi> = {}) {
  const events: string[] = []
  const fullApi: AiControllerApi = {
    aiStatus: vi.fn(async () => ({ configured: true, provider })),
    aiListModels: vi.fn(async () => ({ models: [], defaultModelId: null, fetchedAt: null, error: null })),
    aiGenerateTests: vi.fn(async (): Promise<AiGenerateResult> => ({ outcome: 'ok', statements: [], servedModel: 'm', fellBack: false })),
    reviewAiCode: vi.fn(async (): Promise<AiReviewResult> => ({
      outcome: 'ok', review, help: null, servedModel: 'model-new', fellBack: false, usage,
    })),
    askAiReviewFollowUp: vi.fn(async () => okResult),
    currentTarget: () => target,
    headerProblem: () => ({
      date: '2026-09-10',
      frontendId: '1',
      title: 'Two Sum',
      titleSlug: 'two-sum',
      difficulty: 'Easy',
      url: 'https://example.test/two-sum',
      javaSnippet: null,
      content: '<p>Two Sum</p>',
    }),
    readContext: () => ({ stub: 'bare', methodHeaders: ['int f()'], canAddCase: true }),
    selectedModelId: () => null,
    psSignatures: () => [],
    applyStatements: vi.fn(() => ({ ok: true }) as never),
    applyCaseStatements: vi.fn(() => ({ ok: true, methodName: 'test2' }) as never),
    focusEditor: vi.fn(),
    readSource: () => editedSource,
    replaceSource: vi.fn(),
    reviewTestRun: () => ({ testRun: null, omitted: 'no-run' }),
    responseLanguage: () => 'english',
    ...api,
  }
  const fullUi: AiControllerUi = {
    requestChanged: vi.fn(() => events.push('request changed')),
    showMessage: vi.fn((message: string) => events.push(`message: ${message}`)),
    showMissingKey: vi.fn(() => events.push('missing key')),
    generationFinished: vi.fn(() => events.push('finished')),
    showProgress: vi.fn(),
    reviewed: vi.fn(),
    reviewStreamChanged: vi.fn(),
    usageChanged: vi.fn(() => events.push('usage changed')),
    proposalArrived: vi.fn(),
    chooseReviewModel: vi.fn(async () => ({ modelId: 'model-picked' })),
    followUpsChanged: vi.fn(() => events.push('follow-ups changed')),
    followUpAnswerChanged: vi.fn((changed: AiReviewFollowUp) => events.push(`answer: ${changed.answer}`)),
    ...ui,
  }
  return { controller: createAiController(fullApi, fullUi), api: fullApi, ui: fullUi, events }
}

describe('review follow-up flow', () => {
  it('sends the review as it was, the editor code, its served model, and the earlier answered turns, then streams the answer', async () => {
    const pending = deferred<AiReviewFollowUpResult>()
    let onEvent: ((event: AiStreamEvent) => void) | undefined
    const onText = (text: string) => onEvent?.({ kind: 'text', text })
    const { controller, api, ui, events } = setup({
      askAiReviewFollowUp: vi.fn((_request, handler) => {
        onEvent = handler
        return pending.promise
      }),
    })
    const stored = storedReview([
      turn({ question: 'Q1', answer: 'A1' }),
      turn({ question: 'Q2', answer: 'part', status: 'truncated' }),
      turn({ question: 'Q3', answer: '', status: 'refused' }),
    ])

    const asking = controller.askFollowUp(stored, 'Why O(n)?')
    expect(controller.requestKind).toBe('follow-up')
    expect(controller.requestPath).toBe('Q1TwoSum.java')
    expect(stored.followUps.at(-1)).toEqual(turn({ question: 'Why O(n)?', answer: '', status: 'streaming', usage: null }))
    await vi.waitFor(() => {
      expect(api.askAiReviewFollowUp).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(api.askAiReviewFollowUp).mock.calls[0][0]).toEqual({
      selectedModelId: 'model-served',
      review: reviewRequest,
      reviewAnswer: review,
      helpAnswer: null,
      history: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'part' }],
      question: 'Why O(n)?',
      currentCode: editedSource,
    })

    onText('Full ')
    onText('answer')
    expect(stored.followUps.at(-1)?.answer).toBe('Full answer')
    pending.resolve(okResult)
    await expect(asking).resolves.toBe(true)
    onText(' late')

    expect(stored.followUps.at(-1)).toEqual(turn({
      question: 'Why O(n)?',
      answer: 'Full answer.',
      live: { reported: null, final: false, chars: 'Full answer'.length },
    }))
    expect(stored.followUps).toHaveLength(4)
    expect(events).toEqual([
      'request changed',
      'follow-ups changed',
      'answer: Full ',
      'answer: Full answer',
      'finished',
      'follow-ups changed',
      'request changed',
    ])
    expect(controller.requestKind).toBeNull()
    expect(controller.requestPath).toBeNull()
    expect(ui.showProgress).not.toHaveBeenCalled()
    expect(ui.showMessage).not.toHaveBeenCalled()
    expect(ui.proposalArrived).not.toHaveBeenCalled()
  })

  it('sends the help answer instead of a review for help', async () => {
    const { controller, api } = setup({ askAiReviewFollowUp: vi.fn(async () => okResult) })
    const help: AiProblemHelp = { overview: 'Find two indices.', keyPoints: [], hints: ['Remember what you saw.'] }
    const stored: StoredAiReview = {
      ...storedReview(),
      review: null,
      help,
      request: { ...reviewRequest, mode: 'help' },
    }

    await expect(controller.askFollowUp(stored, 'What is the approach?')).resolves.toBe(true)
    expect(vi.mocked(api.askAiReviewFollowUp).mock.calls[0][0]).toMatchObject({
      review: { mode: 'help' },
      reviewAnswer: null,
      helpAnswer: help,
    })
  })

  it('counts streamed usage and thinking without redrawing the answer', async () => {
    const pending = deferred<AiReviewFollowUpResult>()
    let onEvent: ((event: AiStreamEvent) => void) | undefined
    const { controller, ui, events } = setup({
      askAiReviewFollowUp: vi.fn((_request, handler) => {
        onEvent = handler
        return pending.promise
      }),
    })
    const stored = storedReview()
    const asking = controller.askFollowUp(stored, 'Q')
    await vi.waitFor(() => {
      expect(onEvent).toBeDefined()
    })
    events.length = 0
    const started = { inputTokens: 900, outputTokens: 1, cacheReadTokens: 400, cacheWriteTokens: 0 }
    onEvent?.({ kind: 'usage', usage: started, final: false })
    onEvent?.({ kind: 'thinking', chars: 40 })
    onEvent?.({ kind: 'text', text: 'Hi' })
    expect(stored.followUps[0].live).toEqual({ reported: started, final: false, chars: 42 })
    onEvent?.({ kind: 'usage', usage: { ...started, outputTokens: 30 }, final: true })
    expect(stored.followUps[0].live).toMatchObject({ reported: { outputTokens: 30 }, final: true })
    expect(events).toEqual(['usage changed', 'usage changed', 'answer: Hi', 'usage changed'])
    expect(ui.followUpAnswerChanged).toHaveBeenCalledOnce()
    pending.resolve(okResult)
    await asking
  })

  it.each(['truncated', 'refused'] as const)('keeps a %s answer with its status and no message', async (outcome) => {
    const { controller, ui } = setup({
      askAiReviewFollowUp: vi.fn(async () => ({ ...okResult, outcome, answer: outcome === 'refused' ? '' : 'Partial' })),
    })
    const stored = storedReview()
    await expect(controller.askFollowUp(stored, 'Q')).resolves.toBe(true)
    expect(stored.followUps).toEqual([
      turn({ question: 'Q', answer: outcome === 'refused' ? '' : 'Partial', status: outcome }),
    ])
    expect(ui.showMessage).not.toHaveBeenCalled()
  })

  it('removes the turn and reports a failed request so the question goes back', async () => {
    const { controller, ui } = setup({
      askAiReviewFollowUp: vi.fn(async () => {
        throw new Error('The question is longer than 4000 characters.')
      }),
    })
    const stored = storedReview([turn({})])
    await expect(controller.askFollowUp(stored, 'Q')).resolves.toBe(false)
    expect(stored.followUps).toEqual([turn({})])
    expect(ui.showMessage).toHaveBeenCalledWith(
      'Could not answer the question: The question is longer than 4000 characters.',
      'error',
    )
    expect(ui.generationFinished).toHaveBeenCalledOnce()
    expect(ui.followUpsChanged).toHaveBeenCalledTimes(2)
    expect(controller.requestPath).toBeNull()
  })

  it('opens the key settings without a key and sends nothing', async () => {
    const { controller, api, ui } = setup({ aiStatus: vi.fn(async () => ({ configured: false, provider })) })
    const stored = storedReview()
    await expect(controller.askFollowUp(stored, 'Q')).resolves.toBe(false)
    expect(api.askAiReviewFollowUp).not.toHaveBeenCalled()
    expect(ui.showMissingKey).toHaveBeenCalledOnce()
    expect(stored.followUps).toEqual([])
  })

  it('reports a key status failure and removes the turn', async () => {
    const { controller, ui } = setup({ aiStatus: vi.fn(async () => { throw new Error('locked') }) })
    const stored = storedReview()
    await expect(controller.askFollowUp(stored, 'Q')).resolves.toBe(false)
    expect(ui.showMessage).toHaveBeenCalledWith('Could not read the API key status: locked', 'error')
    expect(stored.followUps).toEqual([])
  })

  it('names a substituted model in a message that stays', async () => {
    const { controller, ui } = setup({
      askAiReviewFollowUp: vi.fn(async () => ({ ...okResult, servedModel: 'model-default', fellBack: true })),
    })
    await controller.askFollowUp(storedReview(), 'Q')
    expect(ui.showMessage).toHaveBeenCalledWith('The selected model is unavailable, so model-default was used.', 'error')
  })

  it('sends nothing for a blank question', async () => {
    const { controller, api, ui } = setup()
    await expect(controller.askFollowUp(storedReview(), '  ')).resolves.toBe(false)
    expect(api.aiStatus).not.toHaveBeenCalled()
    expect(ui.requestChanged).not.toHaveBeenCalled()
  })

  it('shares one in-flight request with generation and review', async () => {
    const pending = deferred<AiReviewFollowUpResult>()
    const { controller, api } = setup({ askAiReviewFollowUp: vi.fn(() => pending.promise) })
    const stored = storedReview()
    const asking = controller.askFollowUp(stored, 'first')
    await controller.generate()
    await controller.review()
    await expect(controller.askFollowUp(stored, 'second')).resolves.toBe(false)
    expect(api.aiGenerateTests).not.toHaveBeenCalled()
    expect(api.reviewAiCode).not.toHaveBeenCalled()
    pending.resolve(okResult)
    await asking
    expect(stored.followUps.map((entry) => entry.question)).toEqual(['first'])
    expect(api.askAiReviewFollowUp).toHaveBeenCalledOnce()
  })

  it('sends no follow-up while a review runs or its model picker is open', async () => {
    const choice = deferred<{ modelId: string } | null>()
    const pendingReview = deferred<AiReviewResult>()
    const { controller, api } = setup(
      { reviewAiCode: vi.fn(() => pendingReview.promise) },
      { chooseReviewModel: vi.fn(() => choice.promise) },
    )
    const reviewing = controller.review()
    await vi.waitFor(() => {
      expect(controller.askFollowUp(storedReview(), 'Q')).resolves.toBe(false)
    })
    choice.resolve({ modelId: 'model-picked' })
    await vi.waitFor(() => {
      expect(controller.requestKind).toBe('review')
    })
    await expect(controller.askFollowUp(storedReview(), 'Q')).resolves.toBe(false)
    pendingReview.resolve({ outcome: 'ok', review, help: null, servedModel: 'model-new', fellBack: false, usage })
    await reviewing
    expect(api.askAiReviewFollowUp).not.toHaveBeenCalled()
  })

  it('starts a new review with an empty conversation and the request it sent', async () => {
    const { controller, api, ui } = setup()
    const stored = storedReview()
    await controller.askFollowUp(stored, 'Q')
    await controller.review()
    const next = vi.mocked(ui.reviewed).mock.calls[0][0]
    expect(next).not.toBe(stored)
    expect(next.followUps).toEqual([])
    expect(next.request).toEqual(vi.mocked(api.reviewAiCode).mock.calls[0][0])
    expect(next.request.source).toBe(editedSource)
    expect(stored.followUps).toHaveLength(1)
  })

  it('changes nothing once the app is torn down', async () => {
    const pending = deferred<AiReviewFollowUpResult>()
    let onEvent: ((event: AiStreamEvent) => void) | undefined
    const { controller, ui } = setup({
      askAiReviewFollowUp: vi.fn((_request, handler) => {
        onEvent = handler
        return pending.promise
      }),
    })
    const stored = storedReview()
    const asking = controller.askFollowUp(stored, 'Q')
    await vi.waitFor(() => {
      expect(onEvent).toBeDefined()
    })
    vi.mocked(ui.followUpsChanged).mockClear()
    vi.mocked(ui.requestChanged).mockClear()
    controller.dispose()
    onEvent?.({ kind: 'text', text: 'late' })
    onEvent?.({ kind: 'proposal-started' })
    pending.resolve(okResult)
    await asking
    expect(stored.followUps[0]).toMatchObject({ answer: '', status: 'streaming', preparingProposal: false })
    expect(ui.followUpsChanged).not.toHaveBeenCalled()
    expect(ui.followUpAnswerChanged).not.toHaveBeenCalled()
    expect(ui.generationFinished).not.toHaveBeenCalled()
    expect(ui.requestChanged).not.toHaveBeenCalled()
  })
})

describe('proposed code changes', () => {
  it('shows a change being prepared, then keeps the checked change with its line counts', async () => {
    const pending = deferred<AiReviewFollowUpResult>()
    let onEvent: ((event: AiStreamEvent) => void) | undefined
    const { controller, events } = setup({
      askAiReviewFollowUp: vi.fn((_request, handler) => {
        onEvent = handler
        return pending.promise
      }),
    })
    const stored = storedReview()
    const asking = controller.askFollowUp(stored, '코드를 수정해줘')
    await vi.waitFor(() => {
      expect(onEvent).toBeDefined()
    })
    onEvent?.({ kind: 'text', text: 'Here.' })
    onEvent?.({ kind: 'proposal-started' })
    expect(stored.followUps[0]).toMatchObject({ answer: 'Here.', preparingProposal: true, proposal: null })
    const proposal = { summary: 'Return early', code: 'a\nB\nC\n', baseCode: 'a\nb\n' }
    pending.resolve({ ...okResult, answer: 'Here.', proposal })
    await asking

    expect(stored.followUps[0]).toEqual(turn({
      question: '코드를 수정해줘',
      answer: 'Here.',
      proposal: { ...proposal, status: 'pending', added: 2, removed: 1 },
      live: { reported: null, final: false, chars: 'Here.'.length },
    }))
    expect(events).toContain('answer: Here.')
    expect(events.filter((event) => event === 'answer: Here.')).toHaveLength(2)
  })

  it('reports a newly arrived change once, after the turn settles', async () => {
    const proposal = { summary: 'Return early', code: 'a\nB\n', baseCode: 'a\nb\n' }
    const { controller, api, ui, events } = setup({
      askAiReviewFollowUp: vi.fn(async () => ({ ...okResult, answer: 'Here.', proposal })),
    }, {
      proposalArrived: vi.fn(() => events.push('proposal arrived')),
    })
    const stored = storedReview()
    await controller.askFollowUp(stored, '코드를 수정해줘')

    expect(ui.proposalArrived).toHaveBeenCalledOnce()
    expect(ui.proposalArrived).toHaveBeenCalledWith(stored, stored.followUps[0])
    expect(events.slice(events.indexOf('follow-ups changed', 2))).toEqual([
      'follow-ups changed', 'proposal arrived', 'request changed',
    ])
    vi.mocked(api.askAiReviewFollowUp).mockResolvedValue(okResult)
    await controller.askFollowUp(stored, 'Why?')
    expect(ui.proposalArrived).toHaveBeenCalledOnce()
  })

  it('sends the code as it was reviewed when the reviewed file is not open', async () => {
    const { controller, api } = setup({
      currentTarget: () => ({ ...target, path: 'src/Q2Other.java' }),
    })
    await controller.askFollowUp(storedReview(), 'Q')
    expect(vi.mocked(api.askAiReviewFollowUp).mock.calls[0][0].currentCode).toBe(reviewRequest.source)
  })

  it('sends what became of each earlier change with its turn', () => {
    const decided = (status: 'pending' | 'accepted' | 'rejected') => ({ ...pendingProposal(), status })
    expect(aiFollowUpHistory([
      turn({ question: 'a', proposal: decided('accepted') }),
      turn({ question: 'b', proposal: decided('rejected') }),
      turn({ question: 'c', proposal: decided('pending') }),
      turn({ question: 'd' }),
    ])).toEqual([
      { question: 'a', answer: 'A', proposal: { summary: 'Return early', outcome: 'accepted' } },
      { question: 'b', answer: 'A', proposal: { summary: 'Return early', outcome: 'rejected' } },
      { question: 'c', answer: 'A', proposal: { summary: 'Return early', outcome: 'pending' } },
      { question: 'd', answer: 'A' },
    ])
  })

  it('applies a pending change only while the reviewed file holds the code it was based on', () => {
    let source = editedSource
    let currentTarget = target
    const { controller, api, ui } = setup({ readSource: () => source, currentTarget: () => currentTarget })
    const change = turn({ proposal: pendingProposal() })
    const stored = storedReview([change])

    expect(controller.proposalState(stored, change)).toEqual({ canAccept: true, note: null })

    source = 'class Q1TwoSum { /* typed more */ }'
    expect(controller.proposalState(stored, change)).toEqual({
      canAccept: false,
      note: 'The file changed since this change was proposed. Ask again for a new one.',
    })
    expect(controller.acceptProposal(stored, change)).toBe(false)

    source = editedSource
    currentTarget = { ...target, repositoryGeneration: 2 }
    expect(controller.proposalState(stored, change)).toEqual({
      canAccept: false,
      note: 'Open Q1TwoSum.java to apply this change.',
    })
    expect(controller.acceptProposal(stored, change)).toBe(false)
    expect(api.replaceSource).not.toHaveBeenCalled()
    expect(ui.followUpsChanged).not.toHaveBeenCalled()

    currentTarget = target
    expect(controller.acceptProposal(stored, change)).toBe(true)
    expect(api.replaceSource).toHaveBeenCalledExactlyOnceWith('class Q1TwoSum { /* changed */ }')
    expect(change.proposal?.status).toBe('accepted')
    expect(ui.followUpsChanged).toHaveBeenCalledOnce()
    expect(controller.proposalState(stored, change)).toEqual({ canAccept: false, note: null })

    // A decided change is never applied or decided again.
    expect(controller.acceptProposal(stored, change)).toBe(false)
    controller.rejectProposal(stored, change)
    expect(change.proposal?.status).toBe('accepted')
    expect(api.replaceSource).toHaveBeenCalledOnce()
  })

  it('rejects a pending change without touching the editor', () => {
    const { controller, api, ui } = setup()
    const change = turn({ proposal: pendingProposal('stale base') })
    const stored = storedReview([change])
    controller.rejectProposal(stored, change)
    expect(change.proposal?.status).toBe('rejected')
    expect(ui.followUpsChanged).toHaveBeenCalledOnce()
    expect(api.replaceSource).not.toHaveBeenCalled()
    expect(controller.proposalState(stored, change)).toEqual({ canAccept: false, note: null })

    const other = turn({ proposal: pendingProposal() })
    controller.rejectProposal(stored, other)
    expect(controller.acceptProposal(stored, other)).toBe(false)
    expect(other.proposal?.status).toBe('pending')
  })

  it('applies nothing once the app is torn down', () => {
    const { controller, api } = setup()
    const change = turn({ proposal: pendingProposal() })
    const stored = storedReview([change])
    controller.dispose()
    expect(controller.acceptProposal(stored, change)).toBe(false)
    controller.rejectProposal(stored, change)
    expect(change.proposal?.status).toBe('pending')
    expect(api.replaceSource).not.toHaveBeenCalled()
  })
})

describe('follow-up helpers', () => {
  it('sends only settled answers as history, oldest first', () => {
    expect(aiFollowUpHistory([
      turn({ question: 'a', answer: '1' }),
      turn({ question: 'b', status: 'refused' }),
      turn({ question: 'c', answer: '3', status: 'truncated' }),
      turn({ question: 'd', status: 'streaming', usage: null }),
    ])).toEqual([{ question: 'a', answer: '1' }, { question: 'c', answer: '3' }])
  })
})

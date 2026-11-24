import {
  errorMessage,
  type AiCodeProposal,
  type AiCodeProposalOutcome,
  type AiRequestUsage,
  type AiReviewFollowUpTurn,
  type BackendClient,
} from '../backend'
import { diffLines, lineDiffStats } from '../line-diff'
import type { StoredAiReview } from './ai-controller'
import { emptyLiveUsage, recordStreamUsage, type AiLiveUsage } from './ai-usage-meter'

export type AiReviewFollowUpStatus = 'streaming' | 'done' | 'truncated' | 'refused'

/** A change an answer proposed, and what the user did with it. */
export interface AiFollowUpProposal extends AiCodeProposal {
  status: AiCodeProposalOutcome
  /** Lines the change adds and removes, counted once when it arrives. */
  added: number
  removed: number
}

/** One question about the shown review and its answer so far. */
export interface AiReviewFollowUp {
  question: string
  /** Grows while streaming; the final text once the request settles. */
  answer: string
  status: AiReviewFollowUpStatus
  /** Null until the answer settles. */
  usage: AiRequestUsage | null
  /** What the request reported while it streamed, for the usage meter. */
  live: AiLiveUsage
  /** The model started a code change that has not arrived yet. */
  preparingProposal: boolean
  proposal: AiFollowUpProposal | null
}

export function aiFollowUpProposal(proposal: AiCodeProposal): AiFollowUpProposal {
  return { ...proposal, status: 'pending', ...lineDiffStats(diffLines(proposal.baseCode, proposal.code)) }
}

/**
 * The earlier turns sent as context. Answers the model declined, or that are
 * still streaming, are left out.
 */
export function aiFollowUpHistory(turns: readonly AiReviewFollowUp[]): AiReviewFollowUpTurn[] {
  return turns
    .filter((turn) => turn.status === 'done' || turn.status === 'truncated')
    .map((turn) => ({
      question: turn.question,
      answer: turn.answer,
      ...(turn.proposal && { proposal: { summary: turn.proposal.summary, outcome: turn.proposal.status } }),
    }))
}

export interface AiFollowUpRunDeps extends Pick<BackendClient, 'aiStatus' | 'askAiReviewFollowUp'> {
  disposed: () => boolean
  showMessage: (message: string, tone: 'info' | 'success' | 'error') => void
  showMissingKey: () => void
  /** A paid call settled, whichever way. */
  generationFinished: () => void
  /** A turn was added, removed, or settled. */
  followUpsChanged: () => void
  /** Only the streaming answer of `turn` grew. */
  followUpAnswerChanged: (turn: AiReviewFollowUp) => void
  /** Only the live usage of the running turn moved. */
  usageChanged: () => void
  /** `turn` just settled with a proposed change. */
  proposalArrived: (turn: AiReviewFollowUp) => void
}

/**
 * Ask one question about `stored` and stream the answer into a new turn.
 * `currentCode` is the reviewed file as the editor holds it now. The caller
 * holds the shared in-flight flag. Resolves false when the turn was removed and
 * the question should go back to the input.
 */
export async function runAiReviewFollowUp(
  stored: StoredAiReview,
  question: string,
  currentCode: string,
  deps: AiFollowUpRunDeps,
): Promise<boolean> {
  const history = aiFollowUpHistory(stored.followUps)
  const turn: AiReviewFollowUp = {
    question,
    answer: '',
    status: 'streaming',
    usage: null,
    live: emptyLiveUsage(),
    preparingProposal: false,
    proposal: null,
  }
  stored.followUps.push(turn)
  deps.followUpsChanged()
  const remove = (): void => {
    const index = stored.followUps.indexOf(turn)
    if (index !== -1) stored.followUps.splice(index, 1)
    deps.followUpsChanged()
  }

  let action = 'read the API key status'
  try {
    const status = await deps.aiStatus()
    if (deps.disposed()) return false
    if (!status.configured) {
      remove()
      deps.showMissingKey()
      return false
    }
    action = 'answer the question'
    const result = await deps.askAiReviewFollowUp({
      selectedModelId: stored.servedModel,
      review: stored.request,
      reviewAnswer: stored.review,
      history,
      question,
      currentCode,
    }, (event) => {
      // Events that arrive after the result are already in it.
      if (turn.status !== 'streaming' || deps.disposed()) return
      recordStreamUsage(turn.live, event)
      if (event.kind === 'text') turn.answer += event.text
      else if (event.kind === 'proposal-started') turn.preparingProposal = true
      else {
        deps.usageChanged()
        return
      }
      deps.followUpAnswerChanged(turn)
    }).finally(() => {
      if (!deps.disposed()) deps.generationFinished()
    })
    if (deps.disposed()) return true
    turn.answer = result.answer
    turn.usage = result.usage
    turn.preparingProposal = false
    turn.proposal = result.proposal && aiFollowUpProposal(result.proposal)
    turn.status = result.outcome === 'ok' ? 'done' : result.outcome
    deps.followUpsChanged()
    if (turn.proposal) deps.proposalArrived(turn)
    if (result.fellBack) {
      deps.showMessage(`The selected model is unavailable, so ${result.servedModel} was used.`, 'error')
    }
    return true
  } catch (error) {
    if (deps.disposed()) return false
    remove()
    deps.showMessage(`Could not ${action}: ${errorMessage(error)}`, 'error')
    return false
  }
}

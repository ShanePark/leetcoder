import {
  errorMessage,
  type AiGenerateResult,
  type AiModelList,
  type AiModelPricing,
  type AiProgress,
  type AiProviderInfo,
  type AiRequestUsage,
  type AiResponseLanguage,
  type AiReview,
  type AiReviewRequest,
  type AiReviewResult,
  type AiReviewTestCase,
  type AiReviewTestRun,
  type AiStreamHandler,
  type BackendClient,
  type DailyProblem,
  type PsLibraryMetadata,
  type TestResult,
} from '../backend'
import { declaresJavaSolutionConstructor, extractJavaMethodSignature } from '../domain'
import type {
  AiCaseTestResult,
  AiTestContext,
  AiTestRejectionReason,
  AiTestResult,
  AiTestStub,
} from '../editor'
import type { AppIcon } from '../icons'
import { runAiReviewFollowUp, type AiReviewFollowUp } from './ai-follow-up'
import { emptyLiveUsage, recordStreamUsage, type AiLiveUsage } from './ai-usage-meter'
import { normalizeProblemNumber } from './layout'
import { sourceBasename } from './path-helpers'
import type { ProgressOverlayState } from './progress-overlay'
import type { TestRunSourceSnapshot } from './types'

/**
 * What a request does: write the examples into `test()`, write one failing case
 * into a new method, review the open solution, or answer a question about the
 * shown review. A review or a follow-up streams into the Review tab, shows no
 * progress popup, and leaves the editor usable.
 */
export type AiRequestKind = 'examples' | 'case' | 'review' | 'follow-up'

/** The requests that show the blocking progress popup. */
type AiPopupRequestKind = Exclude<AiRequestKind, 'review' | 'follow-up'>

/** Longer pasted text is refused before any request, as native code does. */
export const MAX_AI_FAILING_CASE_LENGTH = 32_768

/** The open document a request belongs to. */
export interface AiTarget {
  repoPath: string | null
  path: string | null
  repositoryGeneration: number
}

/** Why a review was sent without test results. */
export type AiReviewTestRunOmission = 'no-run' | 'changed'

export interface AiReviewTestRunSelection {
  testRun: AiReviewTestRun | null
  /** Null when `testRun` is sent. */
  omitted: AiReviewTestRunOmission | null
}

/** The last review the app shows, with what it was based on and what it cost. */
export interface StoredAiReview {
  review: AiReview
  fileName: string
  servedModel: string
  /** The served model's catalog name, or its id when the catalog does not list it. */
  servedModelName: string
  /** The served model's catalog prices, for estimating a follow-up while it runs. */
  pricing: AiModelPricing | null
  testRunOmitted: AiReviewTestRunOmission | null
  usage: AiRequestUsage
  /** The request the review answered; follow-ups resend it unchanged. */
  request: AiReviewRequest
  /** The document that was reviewed; proposed changes apply only to it. */
  target: AiTarget
  /** Questions about this review, oldest first. A new review starts an empty list. */
  followUps: AiReviewFollowUp[]
}

/** A review on its way, shown in the Review tab until its result replaces it. */
export interface AiReviewStream {
  fileName: string
  /** The model asked for, then the one the request names once it is sent. */
  modelId: string
  /** `modelId`'s catalog name, or the id when the catalog does not list it. */
  modelName: string
  pricing: AiModelPricing | null
  testRunOmitted: AiReviewTestRunOmission | null
  /** When the request was sent, as `Date.now()`. */
  startedAt: number
  /** The review's JSON so far. */
  text: string
  live: AiLiveUsage
}

/** What the review model picker shows. Nothing is sent until a model is chosen. */
export interface AiReviewModelRequest {
  fileName: string
  provider: AiProviderInfo | null
  /** The cached model catalog, or null when it could not be read. */
  models: AiModelList | null
  /** The test generation model, used when the catalog offers nothing to choose. */
  testModelId: string | null
  testRun: AiReviewTestRunSelection
}

/** The model to send the review to; null leaves the choice to the catalog default. */
export interface AiReviewModelChoice {
  modelId: string | null
}

export interface AiControllerApi
  extends Pick<
    BackendClient,
    'aiStatus' | 'aiGenerateTests' | 'reviewAiCode' | 'aiListModels' | 'askAiReviewFollowUp'
  > {
  currentTarget: () => AiTarget
  /** The problem the app has loaded, which may not be the open file's problem. */
  headerProblem: () => DailyProblem | null
  readContext: () => AiTestContext
  selectedModelId: () => string | null
  psSignatures: () => string[]
  applyStatements: (statements: readonly string[]) => AiTestResult
  applyCaseStatements: (statements: readonly string[]) => AiCaseTestResult
  /** Called once statements are in the document. */
  focusEditor: () => void
  /** The open document's current text. */
  readSource: () => string
  /**
   * Replace the open document's text with `code` as one undoable edit that
   * changes only the differing lines and keeps the cursor and scroll.
   */
  replaceSource: (code: string) => void
  /** The last test run, when it was made on exactly the open document. */
  reviewTestRun: () => AiReviewTestRunSelection
  responseLanguage: () => AiResponseLanguage
}

export interface AiControllerUi {
  requestChanged: () => void
  showMessage: (message: string, tone: 'info' | 'success' | 'error') => void
  showMissingKey: () => void
  /** A paid call settled, whichever way, so its usage record may be new. */
  generationFinished: () => void
  /** Show, update, or remove (with null) the blocking progress popup. */
  showProgress: (state: ProgressOverlayState | null) => void
  /** A failing case became a test method. */
  caseAdded?: () => void
  /** A review arrived; it replaces the previous one. */
  reviewed: (review: StoredAiReview) => void
  /**
   * A review started streaming, or its text grew; the same object until it
   * ends. Null when it ended, before `reviewed` when it succeeded.
   */
  reviewStreamChanged: (stream: AiReviewStream | null) => void
  /** Only the live usage of the running review or follow-up moved. */
  usageChanged: () => void
  /** Ask which model reviews the code. Resolves with null when the user cancels. */
  chooseReviewModel: (request: AiReviewModelRequest) => Promise<AiReviewModelChoice | null>
  /** A follow-up turn was added, removed, or settled. */
  followUpsChanged: () => void
  /** Only the streaming answer of `turn` grew. */
  followUpAnswerChanged: (turn: AiReviewFollowUp) => void
  /** `turn`, a follow-up of `stored`, just settled with a proposed change. */
  proposalArrived: (stored: StoredAiReview, turn: AiReviewFollowUp) => void
}

export interface AiController {
  /**
   * The file a request is running for, or null while idle. A follow-up holds the
   * reviewed file's name.
   */
  readonly requestPath: string | null
  readonly requestKind: AiRequestKind | null
  generate: () => Promise<void>
  /** Add one pasted failing case to the open file as a new test method. */
  generateCase: (failingCase: string) => Promise<void>
  /**
   * Ask for a review model, then review the open solution with its test
   * results when they are current. Cancelling the picker sends nothing.
   */
  review: () => Promise<void>
  /**
   * Ask about `stored`, with the reviewed file as the editor holds it now,
   * streaming the answer into its follow-ups. Resolves false when nothing was
   * answered and the question should go back to the input.
   */
  askFollowUp: (stored: StoredAiReview, question: string) => Promise<boolean>
  /** Whether the pending change of `turn` can be applied now, and why not. */
  proposalState: (stored: StoredAiReview, turn: AiReviewFollowUp) => AiProposalState
  /**
   * Apply the pending change of `turn` to the reviewed file when the editor
   * still holds the code it was based on. False when nothing was applied.
   */
  acceptProposal: (stored: StoredAiReview, turn: AiReviewFollowUp) => boolean
  rejectProposal: (stored: StoredAiReview, turn: AiReviewFollowUp) => void
  dispose: () => void
}

export interface AiProposalState {
  canAccept: boolean
  /** Why the change cannot be applied; null when it can, or once it was decided. */
  note: string | null
}

export const PROPOSAL_STALE_NOTE = 'The file changed since this change was proposed. Ask again for a new one.'

export interface AiButtonPresentation {
  icon: AppIcon
  busy: boolean
  hidden: boolean
  disabled: boolean
  /** Short visible caption; `label` stays the full accessible name. */
  text: string
  label: string
  title: string
}

const STILL_CHARGED = 'The call was still charged and is recorded in usage.'
const MAY_BE_CHARGED = 'The call may still have been charged and is recorded in usage.'

const REJECTION_REASONS: Readonly<Record<AiTestRejectionReason, string>> = {
  'stub-missing': 'test() no longer exists',
  'stub-filled': 'test() already has code',
  'no-statements': 'the model returned no statements, so the examples may be missing or need an API this app cannot build',
  'too-many-statements': 'the model returned too many statements',
  'statement-too-long': 'a statement was too long',
  'not-one-line': 'a statement spanned several lines',
  comment: 'a statement contained a comment',
  'unicode-escape': 'a statement contained a Unicode escape',
  'unterminated-literal': 'a statement had an unterminated literal',
  'unbalanced-brackets': 'a statement had unbalanced brackets',
  semicolon: 'a statement did not end in a single semicolon',
  'syntax-error': 'the statements were not valid Java',
  'not-one-statement': 'a line did not hold exactly one statement',
  'outside-test-body': 'the statements would change code outside test()',
  'class-missing': 'the file has no class to add a test method to',
}

const CASE_REJECTION_REASONS: Partial<Record<AiTestRejectionReason, string>> = {
  'no-statements': 'the model returned no statements, so the case may lack an input or Expected value without asking for a time-limit case, or need an API this app cannot build',
  'outside-test-body': 'the statements would change code outside the new test method',
}

/** The problem number of a Java `Q<number>...` source file. */
export function aiProblemNumber(path: string | null): string | null {
  const match = path === null ? null : /^Q(\d+).*\.java$/i.exec(sourceBasename(path))
  return match ? normalizeProblemNumber(match[1]) : null
}

/** Whether the open file's problem is loaded with its description, so a click could send a request. */
function problemReady(path: string | null, problem: DailyProblem | null): boolean {
  const problemNumber = aiProblemNumber(path)
  return problemNumber !== null
    && problem !== null
    && normalizeProblemNumber(problem.frontendId) === problemNumber
    && Boolean(problem.content?.trim())
}

export type AiButtonMode = Exclude<AiRequestKind, 'review' | 'follow-up'>

/**
 * What a click on the AI button does for the open file: fill a bare `test()`
 * with the examples, or add a pasted failing case as a new test method once
 * tests exist. Null hides the button.
 */
export function aiButtonMode(
  path: string | null,
  problem: DailyProblem | null,
  stub: AiTestStub,
  canAddCase: boolean,
): AiButtonMode | null {
  if (!problemReady(path, problem)) return null
  if (stub === 'bare') return 'examples'
  return canAddCase ? 'case' : null
}

const BUTTON_COPY: Readonly<Record<AiButtonMode, {
  icon: AppIcon
  text: string
  label: string
  busyLabel: string
  busyTitle: (name: string) => string
  title: (name: string) => string
}>> = {
  examples: {
    icon: 'sparkles',
    text: 'Fill test',
    label: 'Generate tests with AI',
    busyLabel: 'Generating tests with AI',
    busyTitle: (name) => `Generating tests for ${name}…`,
    title: (name) => `Generate tests for ${name} with AI`,
  },
  case: {
    icon: 'circlePlus',
    text: 'Add case',
    label: 'Add a failing case with AI',
    busyLabel: 'Adding a failing case with AI',
    busyTitle: (name) => `Adding a failing case to ${name}…`,
    title: (name) => `Add a failing case to ${name} as a new test with AI`,
  },
}

const AI_REQUEST_RUNNING = 'Available when the current AI request finishes'
const APP_BUSY = 'Available when the current operation finishes'

/** `requestPath` and `requestKind` describe a running request, if any. */
export function aiButtonPresentation(
  path: string | null,
  requestPath: string | null,
  requestKind: AiRequestKind | null,
  appBusy: boolean,
  problem: DailyProblem | null,
  stub: AiTestStub,
  canAddCase: boolean,
): AiButtonPresentation {
  if (requestPath !== null && requestKind !== 'review' && requestKind !== 'follow-up') {
    const copy = BUTTON_COPY[requestKind ?? 'examples']
    return {
      icon: 'loader',
      busy: true,
      hidden: false,
      disabled: true,
      text: copy.text,
      label: copy.busyLabel,
      title: copy.busyTitle(sourceBasename(requestPath)),
    }
  }
  const mode = path === null ? null : aiButtonMode(path, problem, stub, canAddCase)
  if (path === null || mode === null) {
    const copy = BUTTON_COPY.examples
    return { icon: copy.icon, busy: false, hidden: true, disabled: true, text: copy.text, label: copy.label, title: copy.label }
  }
  const copy = BUTTON_COPY[mode]
  return {
    icon: copy.icon,
    busy: false,
    hidden: false,
    disabled: appBusy || requestPath !== null,
    text: copy.text,
    label: copy.label,
    title: appBusy ? APP_BUSY : requestPath !== null ? AI_REQUEST_RUNNING : copy.title(sourceBasename(path)),
  }
}

const REVIEW_LABEL = 'Review code with AI'
const REVIEW_TEXT = 'AI review'

/** The review button: shown for the loaded problem's file, and disabled while anything else runs. */
export function aiReviewButtonPresentation(
  path: string | null,
  requestPath: string | null,
  requestKind: AiRequestKind | null,
  appBusy: boolean,
  problem: DailyProblem | null,
): AiButtonPresentation {
  if (requestPath !== null && requestKind === 'review') {
    return {
      icon: 'loader',
      busy: true,
      hidden: false,
      disabled: true,
      text: REVIEW_TEXT,
      label: 'Reviewing code with AI',
      title: `Reviewing ${sourceBasename(requestPath)}…`,
    }
  }
  const hidden = !problemReady(path, problem)
  return {
    icon: 'review',
    busy: false,
    hidden,
    disabled: hidden || appBusy || requestPath !== null,
    text: REVIEW_TEXT,
    label: REVIEW_LABEL,
    title: hidden || (!appBusy && requestPath === null)
      ? REVIEW_LABEL
      : appBusy ? APP_BUSY : AI_REQUEST_RUNNING,
  }
}

/** Longer fields of one test are cut, so a noisy test cannot crowd out the rest. */
export const MAX_AI_REVIEW_FIELD_LENGTH = 2_000
/** Native code refuses test results longer than this. */
export const MAX_AI_REVIEW_TEST_RUN_LENGTH = 64_000
/** Diagnostics may use at most this share of the test result budget. */
const MAX_AI_REVIEW_DIAGNOSTICS_LENGTH = 16_000
const CLIPPED = '… [truncated]'

/** Cut text to at most `max` UTF-16 units without splitting a surrogate pair. */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - CLIPPED.length
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end) + CLIPPED
}

function clipOptional(text: string | null | undefined): string | null {
  return text ? clipText(text, MAX_AI_REVIEW_FIELD_LENGTH) : null
}

/** Counted as native code counts it; a UTF-16 length is never below the character count. */
function reviewTestLength(test: AiReviewTestCase): number {
  return test.name.length + test.status.length + (test.message?.length ?? 0)
    + (test.expected?.length ?? 0) + (test.actual?.length ?? 0) + (test.stdout?.length ?? 0)
}

/**
 * The test results sent with a review. Each field is clipped, then diagnostics
 * and tests are kept in order while they fit the native limit. A test that does
 * not fit keeps only its name and status, so the model still sees every outcome.
 */
export function aiReviewTestRun(result: TestResult): AiReviewTestRun {
  let remaining = MAX_AI_REVIEW_TEST_RUN_LENGTH - result.phase.length
  const diagnostics: string[] = []
  let diagnosticsLength = 0
  for (const diagnostic of result.diagnostics) {
    const message = clipText(diagnostic.message, MAX_AI_REVIEW_FIELD_LENGTH)
    if (diagnosticsLength + message.length > MAX_AI_REVIEW_DIAGNOSTICS_LENGTH) break
    diagnostics.push(message)
    diagnosticsLength += message.length
  }
  remaining -= diagnosticsLength
  const tests: AiReviewTestCase[] = []
  for (const test of result.tests) {
    const full: AiReviewTestCase = {
      name: clipText(test.name, MAX_AI_REVIEW_FIELD_LENGTH),
      status: clipText(test.status, MAX_AI_REVIEW_FIELD_LENGTH),
      message: clipOptional(test.message),
      expected: clipOptional(test.expected),
      actual: clipOptional(test.actual),
      stdout: clipOptional(test.stdout),
    }
    const kept = reviewTestLength(full) <= remaining
      ? full
      : { name: full.name, status: full.status, message: null, expected: null, actual: null, stdout: null }
    const length = reviewTestLength(kept)
    if (length > remaining) break
    tests.push(kept)
    remaining -= length
  }
  return {
    success: result.success,
    phase: result.phase,
    summary: {
      total: result.summary.total,
      passed: result.summary.passed,
      failed: result.summary.failed,
      skipped: result.summary.skipped,
      errors: result.summary.errors,
    },
    tests,
    diagnostics,
  }
}

/**
 * Send the last result only when the run was made on exactly the open document;
 * otherwise say why it was left out.
 */
export function aiReviewTestRunSelection(
  result: TestResult | null,
  source: TestRunSourceSnapshot | null,
  sourceCurrent: boolean,
  target: { repoPath: string | null; path: string | null },
): AiReviewTestRunSelection {
  if (result === null || source === null) return { testRun: null, omitted: 'no-run' }
  if (sourceCurrent) return { testRun: aiReviewTestRun(result), omitted: null }
  const sameFile = source.repoPath === target.repoPath && source.filePath === target.path
  return { testRun: null, omitted: sameFile ? 'changed' : 'no-run' }
}

type AiProgressStep = 'reading' | 'asking' | 'writing'

const PROGRESS_COPY: Readonly<Record<AiPopupRequestKind, { kicker: string; title: string; reading: string; writing: string }>> = {
  examples: { kicker: 'AI tests', title: 'Generating tests', reading: 'Reading the problem', writing: 'Writing tests' },
  case: { kicker: 'AI tests', title: 'Adding failing case', reading: 'Reading the problem', writing: 'Writing tests' },
}

/** The progress popup for one request. The provider is unknown until the key status is read. */
export function aiProgressOverlayState(
  kind: AiPopupRequestKind,
  step: AiProgressStep,
  provider: AiProviderInfo | null,
  model: string | null,
): ProgressOverlayState {
  const copy = PROGRESS_COPY[kind]
  const asking = provider ? `Asking ${provider.displayName}` : 'Asking the model'
  return {
    kicker: copy.kicker,
    title: copy.title,
    stages: [copy.reading, model ? { label: asking, detail: model } : asking, copy.writing],
    current: step === 'reading' ? 0 : step === 'asking' ? 1 : 2,
  }
}

export function psSignatures(metadata: PsLibraryMetadata | null): string[] {
  return (metadata?.methods ?? []).map((method) => {
    const parameters = method.parameters.map((parameter) => parameter.typeName).join(', ')
    return `${method.returnType} Ps.${method.name}(${parameters})`
  })
}

/**
 * Whether a finished fill may take focus. The click leaves focus on the button
 * or, on some engines, the body, so anywhere else means the user moved on. A
 * dialog can be open with nothing in it focused.
 */
export function aiFillMayTakeFocus(root: HTMLElement, button: Element): boolean {
  const { activeElement, body } = root.ownerDocument
  return (activeElement === null || activeElement === body || activeElement === button)
    && root.querySelectorAll('.dialog-backdrop:not([hidden])').length === 0
}

/** How a problem's starting code identifies what the tests call. */
function problemEntryPoint(problem: DailyProblem): {
  javaSnippet: string | null
  entryPoint: string | null
  designProblem: boolean
} {
  const javaSnippet = problem.javaSnippet?.trim() ? problem.javaSnippet : null
  const signature = extractJavaMethodSignature(javaSnippet)
  // A design problem is driven through its class, which the snippet shows, so
  // no single method is the entry point and the file need not declare it yet.
  const designProblem = javaSnippet !== null && (!signature || declaresJavaSolutionConstructor(javaSnippet))
  return { javaSnippet, entryPoint: designProblem ? null : signature, designProblem }
}

/** A review's request: no popup, and a stream that starts once the request is sent. */
interface ReviewTracker extends ProgressTracker {
  startStream: (fileName: string, modelId: string | null, testRunOmitted: AiReviewTestRunOmission | null) => void
  onEvent: AiStreamHandler
}

/** The picked review model, with the catalog it was picked from for naming the served model. */
interface ReviewChoice {
  modelId: string | null
  models: AiModelList | null
}

/**
 * One request's progress popup, or a review's stream. Once closed, late
 * progress events are ignored.
 */
interface ProgressTracker {
  step: (step: AiProgressStep, model?: string) => void
  /** Called whenever the provider becomes known, so the asking step can name it. */
  refresh: () => void
  close: () => void
  onProgress: (progress: AiProgress) => void
}

/**
 * Run one AI request for the open file. The flag is set before anything
 * asynchronous, and every kind shares it, so a repeated click cannot pay for a
 * second call. A file switch is caught here and an edit by `applyStatements` or
 * `applyCaseStatements`, which plan against the document as it is when the
 * result arrives. The buttons are hidden unless a call could apply, but the
 * document and the loaded problem can still change while the key status is
 * read, so `run` checks them again. The progress popup closes before any
 * message, focus change, or settings dialog, and always when the request ends.
 */
export function createAiController(api: AiControllerApi, ui: AiControllerUi): AiController {
  let requestPath: string | null = null
  let requestKind: AiRequestKind | null = null
  let provider: AiProviderInfo | null = null
  let progress: ProgressTracker | null = null
  /** The review picker is being prepared or is open; no other request may start. */
  let choosingReview = false
  let disposed = false

  /**
   * Messages appear behind the popup, so it closes first. A review's stream
   * ends first too, so the panel is back to the last review behind the message.
   */
  const showMessage: AiControllerUi['showMessage'] = (text, tone) => {
    progress?.close()
    ui.showMessage(text, tone)
  }

  const trackProgress = (kind: AiPopupRequestKind): ProgressTracker => {
    let closed = false
    let step: AiProgressStep = 'reading'
    let model: string | null = null
    const show = (): void => {
      if (!closed && !disposed) ui.showProgress(aiProgressOverlayState(kind, step, provider, model))
    }
    const tracker: ProgressTracker = {
      step(next, nextModel) {
        step = next
        if (nextModel !== undefined) model = nextModel
        show()
      },
      refresh: show,
      /**
       * Every close ends the request. The buttons are re-enabled first so the
       * popup can return focus to the one that started it.
       */
      close() {
        if (closed) return
        closed = true
        progress = null
        requestPath = null
        requestKind = null
        if (disposed) return
        ui.requestChanged()
        ui.showProgress(null)
      },
      onProgress(event) {
        if (event.stage === 'requesting') tracker.step('asking', event.model)
        else tracker.step('writing')
      },
    }
    show()
    return tracker
  }

  /**
   * A review shows no popup: it streams into the Review tab once it is sent.
   * Closing it ends the request and the stream.
   */
  const trackReview = (models: AiModelList | null): ReviewTracker => {
    let closed = false
    let stream: AiReviewStream | null = null
    const modelEntry = (id: string) => models?.models.find((model) => model.id === id)
    const tracker: ReviewTracker = {
      step() {},
      refresh() {},
      close() {
        if (closed) return
        closed = true
        progress = null
        requestPath = null
        requestKind = null
        if (disposed) return
        // The button is enabled again before the stream ends, so the end can hand it focus.
        ui.requestChanged()
        if (stream) {
          stream = null
          ui.reviewStreamChanged(null)
        }
      },
      onProgress(event) {
        if (!stream || event.stage !== 'requesting' || disposed) return
        stream.modelId = event.model
        stream.modelName = modelEntry(event.model)?.displayName ?? event.model
        stream.pricing = modelEntry(event.model)?.pricing ?? null
        ui.reviewStreamChanged(stream)
      },
      startStream(fileName, modelId, testRunOmitted) {
        const id = modelId ?? models?.defaultModelId ?? ''
        stream = {
          fileName,
          modelId: id,
          modelName: modelEntry(id)?.displayName ?? (id || 'the default model'),
          pricing: modelEntry(id)?.pricing ?? null,
          testRunOmitted,
          startedAt: Date.now(),
          text: '',
          live: emptyLiveUsage(),
        }
        ui.reviewStreamChanged(stream)
      },
      onEvent(event) {
        if (!stream || disposed) return
        recordStreamUsage(stream.live, event)
        if (event.kind === 'text') {
          stream.text += event.text
          ui.reviewStreamChanged(stream)
        } else {
          ui.usageChanged()
        }
      },
    }
    return tracker
  }

  const isOpen = (target: AiTarget): boolean => {
    const current = api.currentTarget()
    return current.repoPath === target.repoPath
      && current.path === target.path
      && current.repositoryGeneration === target.repositoryGeneration
  }

  /** Read the key status and remember the provider. False after a missing key was handled. */
  const keyConfigured = async (progress: ProgressTracker): Promise<boolean> => {
    const status = await api.aiStatus()
    if (disposed) return false
    provider = status.provider ?? provider
    progress.refresh()
    if (status.configured) return true
    progress.close()
    ui.showMissingKey()
    return false
  }

  /** The current document's context, or null with a message when a call could not apply. */
  const fillableContext = (
    target: AiTarget,
    name: string,
    kind: AiButtonMode,
  ): AiTestContext | null => {
    if (!isOpen(target)) {
      showMessage(`${name} is no longer the active file, so no request was sent.`, 'info')
      return null
    }
    const context = api.readContext()
    if (kind === 'case') {
      if (context.canAddCase) return context
      showMessage(`${name} has no class to add a test method to. No request was sent.`, 'error')
      return null
    }
    if (context.stub === 'missing') {
      showMessage(`${name} has no test() method to fill. No request was sent.`, 'error')
      return null
    }
    if (context.stub === 'filled') {
      showMessage(
        `test() in ${name} already has code. Only an empty test() or a bare assertThat() can be filled.`,
        'error',
      )
      return null
    }
    return context
  }

  /** The loaded problem when it is the open file's, or null with a message. No request is sent. */
  const loadedProblem = (problemNumber: string): DailyProblem | null => {
    const loaded = api.headerProblem()
    if (loaded && normalizeProblemNumber(loaded.frontendId) === problemNumber) {
      return loaded
    }
    const current = loaded ? `problem #${loaded.frontendId} is loaded` : 'no problem is loaded'
    showMessage(
      `This file is problem #${problemNumber}, but ${current}. Paste the URL for #${problemNumber} in the header, then try again.`,
      'error',
    )
    return null
  }

  /** Apply the statements, naming what changed, or say why they were rejected. */
  const apply = (kind: AiButtonMode, name: string, statements: readonly string[]): { done: string } | { rejected: string } => {
    if (kind === 'case') {
      const added = api.applyCaseStatements(statements)
      return added.ok
        ? { done: `Added ${added.methodName}() to ${name}.` }
        : { rejected: CASE_REJECTION_REASONS[added.reason] ?? REJECTION_REASONS[added.reason] }
    }
    const filled = api.applyStatements(statements)
    return filled.ok ? { done: `Filled test() in ${name}.` } : { rejected: REJECTION_REASONS[filled.reason] }
  }

  const fellBackNotice = (result: { fellBack: boolean; servedModel: string }): string => result.fellBack
    ? ` The selected model is unavailable, so ${result.servedModel} was used.`
    : ''

  const finish = (
    target: AiTarget,
    name: string,
    kind: AiButtonMode,
    result: AiGenerateResult,
  ): void => {
    const notice = fellBackNotice(result)
    if (result.outcome === 'refused') {
      showMessage(
        `The model declined to generate tests, so ${name} was not changed. ${MAY_BE_CHARGED}${notice}`,
        'error',
      )
      return
    }
    if (result.outcome === 'truncated') {
      showMessage(
        `The response hit the output limit before it finished, so ${name} was not changed. ${STILL_CHARGED}${notice}`,
        'error',
      )
      return
    }
    if (!isOpen(target)) {
      showMessage(
        `${name} is no longer the active file, so the result was discarded. ${STILL_CHARGED}${notice}`,
        'error',
      )
      return
    }
    const applied = apply(kind, name, result.statements)
    if ('done' in applied) {
      if (kind === 'case') ui.caseAdded?.()
      // Only the error tone stays until dismissed, and a substituted model must not be missed.
      showMessage(`${applied.done}${notice}`, result.fellBack ? 'error' : 'success')
      api.focusEditor()
      return
    }
    showMessage(
      `The result was rejected because ${applied.rejected}. ${name} was not changed. ${STILL_CHARGED}${notice}`,
      'error',
    )
  }

  const run = async (
    target: AiTarget,
    name: string,
    problemNumber: string,
    failingCase: string | null,
    progress: ProgressTracker,
  ): Promise<void> => {
    const kind: AiButtonMode = failingCase === null ? 'examples' : 'case'
    let action = 'read the API key status'
    try {
      if (!await keyConfigured(progress)) return
      const context = fillableContext(target, name, kind)
      if (!context) return

      const problem = loadedProblem(problemNumber)
      if (!problem) return
      if (!problem.content?.trim()) {
        const purpose = kind === 'case' ? 'send with the case' : 'read examples from'
        showMessage(`Problem #${problemNumber} has no description to ${purpose}.`, 'error')
        return
      }
      const { javaSnippet, entryPoint, designProblem } = problemEntryPoint(problem)
      if (context.methodHeaders.length === 0 && !designProblem) {
        showMessage(`${name} has no method to test. No request was sent.`, 'error')
        return
      }

      action = 'generate tests'
      const result = await api.aiGenerateTests({
        selectedModelId: api.selectedModelId(),
        problemTitle: problem.title,
        problemContent: problem.content,
        entryPoint,
        javaSnippet,
        methodHeaders: context.methodHeaders,
        psSignatures: api.psSignatures(),
        ...(failingCase === null ? {} : { failingCase }),
      }, progress.onProgress).finally(() => {
        if (!disposed) ui.generationFinished()
      })
      if (!disposed) finish(target, name, kind, result)
    } catch (error) {
      if (!disposed) showMessage(`Could not ${action}: ${errorMessage(error)}`, 'error')
    }
  }

  const finishReview = (
    target: AiTarget,
    name: string,
    request: AiReviewRequest,
    result: AiReviewResult,
    omitted: AiReviewTestRunOmission | null,
    models: AiModelList | null,
    progress: ProgressTracker,
  ): void => {
    const notice = fellBackNotice(result)
    if (result.outcome === 'refused') {
      showMessage(`The model declined to review ${name}. ${MAY_BE_CHARGED}${notice}`, 'error')
      return
    }
    if (result.outcome === 'truncated' || result.review === null) {
      showMessage(
        `The response hit the output limit before it finished, so no review is shown. ${STILL_CHARGED}${notice}`,
        'error',
      )
      return
    }
    progress.close()
    const served = models?.models.find((model) => model.id === result.servedModel)
    ui.reviewed({
      review: result.review,
      fileName: name,
      servedModel: result.servedModel,
      servedModelName: served?.displayName ?? result.servedModel,
      pricing: served?.pricing ?? null,
      testRunOmitted: omitted,
      usage: result.usage,
      request,
      target,
      followUps: [],
    })
    if (notice) showMessage(notice.trim(), 'error')
  }

  const runReview = async (
    target: AiTarget,
    name: string,
    problemNumber: string,
    choice: ReviewChoice,
    progress: ReviewTracker,
  ): Promise<void> => {
    let action = 'read the API key status'
    try {
      if (!await keyConfigured(progress)) return
      if (!isOpen(target)) {
        showMessage(`${name} is no longer the active file, so no request was sent.`, 'info')
        return
      }
      const problem = loadedProblem(problemNumber)
      if (!problem) return
      if (!problem.content?.trim()) {
        showMessage(`Problem #${problemNumber} has no description to review against.`, 'error')
        return
      }
      const source = api.readSource()
      if (!source.trim()) {
        showMessage(`${name} is empty. No request was sent.`, 'error')
        return
      }
      const { testRun, omitted } = api.reviewTestRun()

      action = 'review the code'
      const request: AiReviewRequest = {
        selectedModelId: choice.modelId,
        problemTitle: problem.title,
        problemContent: problem.content,
        entryPoint: problemEntryPoint(problem).entryPoint,
        source,
        testRun,
        language: api.responseLanguage(),
      }
      progress.startStream(name, choice.modelId, omitted)
      const result = await api.reviewAiCode(request, progress.onProgress, progress.onEvent).finally(() => {
        if (!disposed) ui.generationFinished()
      })
      if (!disposed) finishReview(target, name, request, result, omitted, choice.models, progress)
    } catch (error) {
      if (!disposed) showMessage(`Could not ${action}: ${errorMessage(error)}`, 'error')
    }
  }

  const start = async (
    kind: AiPopupRequestKind | 'review',
    failingCase: string | null,
    reviewChoice: ReviewChoice | null = null,
  ): Promise<void> => {
    if (disposed || requestPath !== null || choosingReview) return
    const target = api.currentTarget()
    const problemNumber = aiProblemNumber(target.path)
    if (target.path === null || problemNumber === null) return
    requestPath = target.path
    requestKind = kind
    const name = sourceBasename(target.path)
    if (kind === 'review') {
      const tracker = trackReview(reviewChoice?.models ?? null)
      progress = tracker
      ui.requestChanged()
      try {
        if (reviewChoice) await runReview(target, name, problemNumber, reviewChoice, tracker)
      } finally {
        tracker.close()
      }
      return
    }
    // The popup opens while the clicked button is still enabled and focused,
    // so it records that button as the place to return focus.
    const tracker = trackProgress(kind)
    progress = tracker
    ui.requestChanged()
    try {
      await run(target, name, problemNumber, failingCase, tracker)
    } finally {
      tracker.close()
    }
  }

  /**
   * Check the key, then let the user pick the review model. Both reads are
   * local, so no popup is shown. Null means nothing is to be sent; any reason
   * has been shown already.
   */
  const chooseReview = async (target: AiTarget, name: string): Promise<ReviewChoice | null> => {
    let configured: boolean
    try {
      const status = await api.aiStatus()
      provider = status.provider ?? provider
      configured = status.configured
    } catch (error) {
      if (!disposed) ui.showMessage(`Could not read the API key status: ${errorMessage(error)}`, 'error')
      return null
    }
    if (disposed) return null
    if (!configured) {
      ui.showMissingKey()
      return null
    }
    // The cached catalog only; without it the picker falls back to the test model.
    const models = await api.aiListModels(false).catch(() => null)
    if (disposed) return null
    if (!isOpen(target)) {
      ui.showMessage(`${name} is no longer the active file, so no request was sent.`, 'info')
      return null
    }
    const choice = await ui.chooseReviewModel({
      fileName: name,
      provider,
      models,
      testModelId: api.selectedModelId(),
      testRun: api.reviewTestRun(),
    })
    return choice && !disposed ? { modelId: choice.modelId, models } : null
  }

  const review = async (): Promise<void> => {
    if (disposed || requestPath !== null || choosingReview) return
    const target = api.currentTarget()
    if (target.path === null || aiProblemNumber(target.path) === null) return
    choosingReview = true
    let choice: ReviewChoice | null
    try {
      choice = await chooseReview(target, sourceBasename(target.path))
    } finally {
      choosingReview = false
    }
    // `start` checks the open file and the problem again.
    if (choice) await start('review', null, choice)
  }

  const askFollowUp = async (stored: StoredAiReview, question: string): Promise<boolean> => {
    if (disposed || requestPath !== null || choosingReview || !question.trim()) return false
    requestPath = stored.fileName
    requestKind = 'follow-up'
    ui.requestChanged()
    try {
      // A file that is not open is sent as it was reviewed.
      const currentCode = isOpen(stored.target) ? api.readSource() : stored.request.source
      return await runAiReviewFollowUp(stored, question, currentCode, {
        aiStatus: api.aiStatus,
        askAiReviewFollowUp: api.askAiReviewFollowUp,
        disposed: () => disposed,
        showMessage: ui.showMessage,
        showMissingKey: ui.showMissingKey,
        generationFinished: ui.generationFinished,
        followUpsChanged: ui.followUpsChanged,
        followUpAnswerChanged: ui.followUpAnswerChanged,
        usageChanged: ui.usageChanged,
        proposalArrived: (turn) => ui.proposalArrived(stored, turn),
      })
    } finally {
      requestPath = null
      requestKind = null
      if (!disposed) ui.requestChanged()
    }
  }

  const proposalState = (stored: StoredAiReview, turn: AiReviewFollowUp): AiProposalState => {
    const proposal = turn.proposal
    if (!proposal || proposal.status !== 'pending') return { canAccept: false, note: null }
    if (!isOpen(stored.target)) {
      return { canAccept: false, note: `Open ${stored.fileName} to apply this change.` }
    }
    if (api.readSource() !== proposal.baseCode) return { canAccept: false, note: PROPOSAL_STALE_NOTE }
    return { canAccept: true, note: null }
  }

  const acceptProposal = (stored: StoredAiReview, turn: AiReviewFollowUp): boolean => {
    if (disposed || !turn.proposal || !stored.followUps.includes(turn)) return false
    if (!proposalState(stored, turn).canAccept) return false
    api.replaceSource(turn.proposal.code)
    turn.proposal.status = 'accepted'
    ui.followUpsChanged()
    return true
  }

  const rejectProposal = (stored: StoredAiReview, turn: AiReviewFollowUp): void => {
    if (disposed || turn.proposal?.status !== 'pending' || !stored.followUps.includes(turn)) return
    turn.proposal.status = 'rejected'
    ui.followUpsChanged()
  }

  return {
    get requestPath() {
      return requestPath
    },
    get requestKind() {
      return requestKind
    },
    generate: () => start('examples', null),
    generateCase: (failingCase) => start('case', failingCase),
    review,
    askFollowUp,
    proposalState,
    acceptProposal,
    rejectProposal,
    dispose() {
      disposed = true
    },
  }
}

import {
  errorMessage,
  type AiGenerateResult,
  type BackendClient,
  type DailyProblem,
  type PsLibraryMetadata,
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
import { normalizeProblemNumber } from './layout'
import { sourceBasename } from './path-helpers'

/** What a request writes: the examples into `test()`, or one failing case into a new method. */
export type AiRequestKind = 'examples' | 'case'

/** Longer pasted text is refused before any request, as native code does. */
export const MAX_AI_FAILING_CASE_LENGTH = 32_768

/** The open document a request belongs to. */
export interface AiTarget {
  repoPath: string | null
  path: string | null
  repositoryGeneration: number
}

export interface AiControllerApi
  extends Pick<BackendClient, 'aiStatus' | 'aiGenerateTests'> {
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
}

export interface AiControllerUi {
  requestChanged: () => void
  showMessage: (message: string, tone: 'info' | 'success' | 'error') => void
  showMissingKey: () => void
  /** A paid call settled, whichever way, so its usage record may be new. */
  generationFinished: () => void
}

export interface AiController {
  /** The file a request is running for, or null while idle. */
  readonly requestPath: string | null
  readonly requestKind: AiRequestKind | null
  generate: () => Promise<void>
  /** Add one pasted failing case to the open file as a new test method. */
  generateCase: (failingCase: string) => Promise<void>
  dispose: () => void
}

export interface AiButtonPresentation {
  icon: AppIcon
  busy: boolean
  hidden: boolean
  disabled: boolean
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
  'no-statements': 'the model returned no statements, so the case may lack an input or Expected value, or need an API this app cannot build',
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

export type AiButtonMode = AiRequestKind

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
  label: string
  busyLabel: string
  busyTitle: (name: string) => string
  title: (name: string) => string
}>> = {
  examples: {
    label: 'Generate tests with AI',
    busyLabel: 'Generating tests with AI',
    busyTitle: (name) => `Generating tests for ${name}…`,
    title: (name) => `Generate tests for ${name} with AI`,
  },
  case: {
    label: 'Add a failing case with AI',
    busyLabel: 'Adding a failing case with AI',
    busyTitle: (name) => `Adding a failing case to ${name}…`,
    title: (name) => `Add a failing case to ${name} as a new test with AI`,
  },
}

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
  if (requestPath !== null) {
    const copy = BUTTON_COPY[requestKind ?? 'examples']
    return {
      icon: 'loader',
      busy: true,
      hidden: false,
      disabled: true,
      label: copy.busyLabel,
      title: copy.busyTitle(sourceBasename(requestPath)),
    }
  }
  const mode = path === null ? null : aiButtonMode(path, problem, stub, canAddCase)
  if (path === null || mode === null) {
    return { icon: 'sparkles', busy: false, hidden: true, disabled: true, label: BUTTON_COPY.examples.label, title: BUTTON_COPY.examples.label }
  }
  const copy = BUTTON_COPY[mode]
  return {
    icon: 'sparkles',
    busy: false,
    hidden: false,
    disabled: appBusy,
    label: copy.label,
    title: appBusy ? 'Available when the current operation finishes' : copy.title(sourceBasename(path)),
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

/**
 * Run one test generation for the open file. The flag is set before anything
 * asynchronous, and both kinds share it, so a repeated click cannot pay for a
 * second call. A file switch is caught here and an edit by `applyStatements` or
 * `applyCaseStatements`, which plan against the document as it is when the
 * result arrives. The buttons are hidden unless a call could apply, but the
 * document and the loaded problem can still change while the key status is
 * read, so `run` checks them again.
 */
export function createAiController(api: AiControllerApi, ui: AiControllerUi): AiController {
  let requestPath: string | null = null
  let requestKind: AiRequestKind | null = null
  let disposed = false

  const isOpen = (target: AiTarget): boolean => {
    const current = api.currentTarget()
    return current.repoPath === target.repoPath
      && current.path === target.path
      && current.repositoryGeneration === target.repositoryGeneration
  }

  /** The current document's context, or null with a message when a call could not apply. */
  const fillableContext = (target: AiTarget, name: string, kind: AiRequestKind): AiTestContext | null => {
    if (!isOpen(target)) {
      ui.showMessage(`${name} is no longer the active file, so no request was sent.`, 'info')
      return null
    }
    const context = api.readContext()
    if (kind === 'case') {
      if (context.canAddCase) return context
      ui.showMessage(`${name} has no class to add a test method to. No request was sent.`, 'error')
      return null
    }
    if (context.stub === 'missing') {
      ui.showMessage(`${name} has no test() method to fill. No request was sent.`, 'error')
      return null
    }
    if (context.stub === 'filled') {
      ui.showMessage(
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
    ui.showMessage(
      `This file is problem #${problemNumber}, but ${current}. Paste the URL for #${problemNumber} in the header, then try again.`,
      'error',
    )
    return null
  }

  /** Apply the statements, naming what changed, or say why they were rejected. */
  const apply = (kind: AiRequestKind, name: string, statements: readonly string[]): { done: string } | { rejected: string } => {
    if (kind === 'case') {
      const added = api.applyCaseStatements(statements)
      return added.ok
        ? { done: `Added ${added.methodName}() to ${name}.` }
        : { rejected: CASE_REJECTION_REASONS[added.reason] ?? REJECTION_REASONS[added.reason] }
    }
    const filled = api.applyStatements(statements)
    return filled.ok ? { done: `Filled test() in ${name}.` } : { rejected: REJECTION_REASONS[filled.reason] }
  }

  const finish = (target: AiTarget, name: string, kind: AiRequestKind, result: AiGenerateResult): void => {
    const notice = result.fellBack
      ? ` The selected model is unavailable, so ${result.servedModel} was used.`
      : ''
    if (result.outcome === 'refused') {
      ui.showMessage(
        `The model declined to generate tests, so ${name} was not changed. ${MAY_BE_CHARGED}${notice}`,
        'error',
      )
      return
    }
    if (result.outcome === 'truncated') {
      ui.showMessage(
        `The response hit the output limit before it finished, so ${name} was not changed. ${STILL_CHARGED}${notice}`,
        'error',
      )
      return
    }
    if (!isOpen(target)) {
      ui.showMessage(
        `${name} is no longer the active file, so the result was discarded. ${STILL_CHARGED}${notice}`,
        'error',
      )
      return
    }
    const applied = apply(kind, name, result.statements)
    if ('done' in applied) {
      // Only the error tone stays until dismissed, and a substituted model must not be missed.
      ui.showMessage(`${applied.done}${notice}`, result.fellBack ? 'error' : 'success')
      api.focusEditor()
      return
    }
    ui.showMessage(
      `The result was rejected because ${applied.rejected}. ${name} was not changed. ${STILL_CHARGED}${notice}`,
      'error',
    )
  }

  const run = async (
    target: AiTarget,
    name: string,
    problemNumber: string,
    failingCase: string | null,
  ): Promise<void> => {
    const kind: AiRequestKind = failingCase === null ? 'examples' : 'case'
    let action = 'read the API key status'
    try {
      const { configured } = await api.aiStatus()
      if (disposed) return
      if (!configured) {
        ui.showMissingKey()
        return
      }
      const context = fillableContext(target, name, kind)
      if (!context) return

      const problem = loadedProblem(problemNumber)
      if (!problem) return
      if (!problem.content?.trim()) {
        const purpose = kind === 'case' ? 'send with the case' : 'read examples from'
        ui.showMessage(`Problem #${problemNumber} has no description to ${purpose}.`, 'error')
        return
      }
      const javaSnippet = problem.javaSnippet?.trim() ? problem.javaSnippet : null
      const signature = extractJavaMethodSignature(javaSnippet)
      // A design problem is driven through its class, which the snippet shows, so
      // no single method is the entry point and the file need not declare it yet.
      const designProblem = javaSnippet !== null && (!signature || declaresJavaSolutionConstructor(javaSnippet))
      const entryPoint = designProblem ? null : signature
      if (context.methodHeaders.length === 0 && !designProblem) {
        ui.showMessage(`${name} has no method to test. No request was sent.`, 'error')
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
      }).finally(() => {
        if (!disposed) ui.generationFinished()
      })
      if (!disposed) finish(target, name, kind, result)
    } catch (error) {
      if (!disposed) ui.showMessage(`Could not ${action}: ${errorMessage(error)}`, 'error')
    }
  }

  const start = async (failingCase: string | null): Promise<void> => {
    if (disposed || requestPath !== null) return
    const target = api.currentTarget()
    const problemNumber = aiProblemNumber(target.path)
    if (target.path === null || problemNumber === null) return
    requestPath = target.path
    requestKind = failingCase === null ? 'examples' : 'case'
    ui.requestChanged()
    try {
      await run(target, sourceBasename(target.path), problemNumber, failingCase)
    } finally {
      requestPath = null
      requestKind = null
      if (!disposed) ui.requestChanged()
    }
  }

  return {
    get requestPath() {
      return requestPath
    },
    get requestKind() {
      return requestKind
    },
    generate: () => start(null),
    generateCase: (failingCase) => start(failingCase),
    dispose() {
      disposed = true
    },
  }
}

import {
  errorMessage,
  type AiGenerateResult,
  type BackendClient,
  type DailyProblem,
  type PsLibraryMetadata,
} from '../backend'
import { declaresJavaSolutionConstructor, extractJavaMethodSignature } from '../domain'
import type { AiTestContext, AiTestRejectionReason, AiTestResult } from '../editor'
import type { AppIcon } from '../icons'
import { normalizeProblemNumber } from './layout'
import { sourceBasename } from './path-helpers'

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
  generate: () => Promise<void>
  dispose: () => void
}

export interface AiButtonPresentation {
  icon: AppIcon
  busy: boolean
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
}

/** The problem number of a Java `Q<number>...` source file. */
export function aiProblemNumber(path: string | null): string | null {
  const match = path === null ? null : /^Q(\d+).*\.java$/i.exec(sourceBasename(path))
  return match ? normalizeProblemNumber(match[1]) : null
}

export function aiButtonPresentation(
  path: string | null,
  requestPath: string | null,
  appBusy: boolean,
): AiButtonPresentation {
  const label = 'Generate tests with AI'
  const idle = { icon: 'sparkles', busy: false, label } as const
  if (requestPath !== null) {
    return {
      icon: 'loader',
      busy: true,
      disabled: true,
      label: 'Generating tests with AI',
      title: `Generating tests for ${sourceBasename(requestPath)}…`,
    }
  }
  if (path === null) {
    return { ...idle, disabled: true, title: 'Open a Java problem file to generate tests' }
  }
  const name = sourceBasename(path)
  if (!/\.java$/i.test(name)) {
    return { ...idle, disabled: true, title: `AI tests work only with Java files, and ${name} is not one` }
  }
  if (aiProblemNumber(path) === null) {
    return { ...idle, disabled: true, title: `AI tests need a file named Q<number>, and ${name} is not` }
  }
  return {
    ...idle,
    disabled: appBusy,
    title: appBusy ? 'Available when the current operation finishes' : `Generate tests for ${name} with AI`,
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
 * asynchronous, so a repeated click cannot pay for a second call. A file switch
 * is caught here and an edit by `applyStatements`, which re-checks the stub
 * against the document as it is when the result arrives.
 */
export function createAiController(api: AiControllerApi, ui: AiControllerUi): AiController {
  let requestPath: string | null = null
  let disposed = false

  const isOpen = (target: AiTarget): boolean => {
    const current = api.currentTarget()
    return current.repoPath === target.repoPath
      && current.path === target.path
      && current.repositoryGeneration === target.repositoryGeneration
  }

  /** The current document's context, or null with a message when a call could not apply. */
  const fillableContext = (target: AiTarget, name: string): AiTestContext | null => {
    if (!isOpen(target)) {
      ui.showMessage(`${name} is no longer the active file, so no request was sent.`, 'info')
      return null
    }
    const context = api.readContext()
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

  const finish = (target: AiTarget, name: string, result: AiGenerateResult): void => {
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
    const applied = api.applyStatements(result.statements)
    if (applied.ok) {
      // Only the error tone stays until dismissed, and a substituted model must not be missed.
      ui.showMessage(`Filled test() in ${name}.${notice}`, result.fellBack ? 'error' : 'success')
      api.focusEditor()
      return
    }
    ui.showMessage(
      `The result was rejected because ${REJECTION_REASONS[applied.reason]}. ${name} was not changed. ${STILL_CHARGED}${notice}`,
      'error',
    )
  }

  const run = async (target: AiTarget, name: string, problemNumber: string): Promise<void> => {
    let action = 'read the API key status'
    try {
      const { configured } = await api.aiStatus()
      if (disposed) return
      if (!configured) {
        ui.showMissingKey()
        return
      }
      const context = fillableContext(target, name)
      if (!context) return

      const problem = loadedProblem(problemNumber)
      if (!problem) return
      if (!problem.content?.trim()) {
        ui.showMessage(`Problem #${problemNumber} has no description to read examples from.`, 'error')
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
      }).finally(() => {
        if (!disposed) ui.generationFinished()
      })
      if (!disposed) finish(target, name, result)
    } catch (error) {
      if (!disposed) ui.showMessage(`Could not ${action}: ${errorMessage(error)}`, 'error')
    }
  }

  return {
    get requestPath() {
      return requestPath
    },
    async generate() {
      if (disposed || requestPath !== null) return
      const target = api.currentTarget()
      const problemNumber = aiProblemNumber(target.path)
      if (target.path === null || problemNumber === null) return
      requestPath = target.path
      ui.requestChanged()
      try {
        await run(target, sourceBasename(target.path), problemNumber)
      } finally {
        requestPath = null
        if (!disposed) ui.requestChanged()
      }
    },
    dispose() {
      disposed = true
    },
  }
}

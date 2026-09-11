import type { DailyProblem, ProblemFileEntry } from '../backend'
import { iconFor } from '../icons'
import { sanitizeProblemHtml } from '../sanitize'

export type DailyProblemSelection = 'daily' | 'manual'

/** The small set of state needed to render the daily-problem card. */
export interface DailyProblemViewModel {
  problem: DailyProblem | null
  existingFile: ProblemFileEntry | null
  projectValid: boolean
  busy: boolean
  dailyLoading: boolean
  dailyError: string | null
  problemSelection: DailyProblemSelection
  problemNumberDraft: string | null
  viewingToday: boolean
  dailyDescriptionOpen: boolean
}

/** User actions leave state changes and asynchronous work with the app. */
export interface DailyProblemViewCallbacks {
  onLookupInput: (value: string) => void
  onLookupSubmit: (value: string) => void
  onRetry: () => void
  onBackToToday: () => void
  onRefresh: () => void
  onToggleDescription: () => void
  onOpenFile: (file: ProblemFileEntry) => void
  onCreateFile: () => void
  onApplyDescriptionHeight: () => void
}

export interface DailyProblemViewElements {
  header: HTMLElement
  description: HTMLElement
  resizeHandle: HTMLElement
}

export type DailyProblemViewRenderer = (model: DailyProblemViewModel) => void

/**
 * Create a renderer for the daily-problem card.
 *
 * The renderer owns only the description DOM cache. The app owns all state,
 * persistence, and asynchronous work and receives those actions through the
 * callbacks above.
 */
export function createDailyProblemView(
  elements: DailyProblemViewElements,
  callbacks: DailyProblemViewCallbacks,
): DailyProblemViewRenderer {
  let sanitizedDescriptionSource: string | null = null
  let sanitizedDescriptionElement: HTMLElement | null = null

  return (model): void => {
    const activeElement = document.activeElement
    const focusedLookup = activeElement instanceof HTMLInputElement
      && activeElement.classList.contains('problem-lookup-input')
      && elements.header.contains(activeElement)
    const lookupSelectionStart = focusedLookup ? activeElement.selectionStart : null
    const lookupSelectionEnd = focusedLookup ? activeElement.selectionEnd : null

    elements.header.innerHTML = ''
    elements.header.append(renderProblemLookup(model, callbacks))
    if (focusedLookup) {
      const input = elements.header.querySelector<HTMLInputElement>('.problem-lookup-input')
      if (input) {
        input.focus()
        if (lookupSelectionStart !== null && lookupSelectionEnd !== null) {
          input.setSelectionRange(lookupSelectionStart, lookupSelectionEnd)
        }
      }
    }

    const problem = model.problem
    if (!problem) {
      elements.description.hidden = true
      elements.resizeHandle.hidden = true
      callbacks.onApplyDescriptionHeight()
      if (model.dailyLoading) {
        elements.header.append(renderDailySkeleton())
      } else if (model.dailyError) {
        elements.header.append(renderDailyError(model, callbacks))
      } else {
        const waiting = document.createElement('span')
        waiting.className = 'daily-waiting'
        waiting.textContent = 'Waiting for today’s problem…'
        elements.header.append(waiting)
      }
      return
    }

    const title = document.createElement('strong')
    title.className = 'problem-title'
    title.textContent = problem.title
    title.title = problem.title

    const difficulty = document.createElement('span')
    difficulty.className = `difficulty difficulty-${problem.difficulty.toLowerCase()}`
    difficulty.textContent = problem.difficulty

    const today = model.viewingToday
      ? document.createElement('span')
      : document.createElement('button')
    today.className = model.viewingToday
      ? 'daily-today-status'
      : 'secondary-button daily-today'
    if (model.viewingToday) {
      today.setAttribute('aria-label', 'Today’s problem')
      today.append(iconFor('calendarDays', 'button-icon'))
      today.append(document.createTextNode('Today’s problem'))
    } else {
      const todayButton = today as HTMLButtonElement
      todayButton.type = 'button'
      todayButton.title = 'Show today’s problem'
      todayButton.setAttribute('aria-label', 'Back to today')
      todayButton.disabled = model.busy || model.dailyLoading
      todayButton.append(iconFor('calendarDays', 'button-icon'))
      todayButton.append(document.createTextNode('Back to today'))
      todayButton.addEventListener('click', callbacks.onBackToToday)
    }

    const actions = document.createElement('div')
    actions.className = 'daily-actions'

    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'icon-button'
    const refreshLabel = model.problemSelection === 'manual'
      ? 'Refresh selected problem'
      : 'Refresh today’s problem'
    refresh.setAttribute('aria-label', refreshLabel)
    refresh.title = refreshLabel
    refresh.append(iconFor('refresh', 'button-icon'))
    refresh.disabled = model.busy || model.dailyLoading
    refresh.classList.toggle('is-spinning', model.dailyLoading)
    refresh.addEventListener('click', callbacks.onRefresh)
    actions.append(refresh)

    const link = document.createElement('a')
    link.className = 'icon-button'
    link.href = problem.url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.setAttribute('aria-label', 'Open on LeetCode')
    link.title = 'Open on LeetCode'
    link.append(iconFor('externalLink', 'button-icon'))
    actions.append(link)

    const hasContent = Boolean(problem.content && problem.content.trim().length > 0)
    if (hasContent) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'icon-button daily-description-toggle'
      toggle.setAttribute('aria-label', 'Toggle problem description')
      toggle.setAttribute('aria-expanded', String(model.dailyDescriptionOpen))
      toggle.setAttribute('aria-controls', 'daily-description')
      toggle.title = 'Description'
      toggle.append(iconFor('bookOpen', 'button-icon'))
      toggle.classList.toggle('is-active', model.dailyDescriptionOpen)
      toggle.addEventListener('click', callbacks.onToggleDescription)
      actions.append(toggle)
    }

    const primary = document.createElement('button')
    primary.type = 'button'
    primary.className = 'primary-button daily-primary'
    primary.textContent = model.existingFile ? 'Open file' : 'Create file'
    if (!model.projectValid) {
      primary.disabled = true
      primary.title = 'Choose a repository first'
    } else {
      primary.disabled = model.busy
    }
    if (model.existingFile) {
      primary.addEventListener('click', () => callbacks.onOpenFile(model.existingFile!))
    } else {
      primary.addEventListener('click', callbacks.onCreateFile)
    }
    actions.append(primary)
    elements.header.append(title, difficulty, today, actions)

    if (hasContent && model.dailyDescriptionOpen) {
      elements.description.hidden = false
      renderDailyDescription(elements.description, problem.content ?? '')
      elements.resizeHandle.hidden = false
      callbacks.onApplyDescriptionHeight()
    } else {
      elements.description.hidden = true
      elements.resizeHandle.hidden = true
      callbacks.onApplyDescriptionHeight()
    }
  }

  function renderDailyDescription(container: HTMLElement, content: string): void {
    if (sanitizedDescriptionSource !== content || !sanitizedDescriptionElement) {
      const body = document.createElement('div')
      body.className = 'daily-description-body'
      body.append(sanitizeProblemHtml(content))
      sanitizedDescriptionSource = content
      sanitizedDescriptionElement = body
    }
    if (sanitizedDescriptionElement.parentElement !== container) {
      container.innerHTML = ''
      container.append(sanitizedDescriptionElement)
    }
  }
}

function renderProblemLookup(
  model: DailyProblemViewModel,
  callbacks: DailyProblemViewCallbacks,
): HTMLElement {
  const form = document.createElement('form')
  form.className = 'problem-lookup'
  form.setAttribute('aria-label', 'Load a LeetCode problem by number')

  const field = document.createElement('label')
  field.className = 'problem-lookup-field'
  field.title = 'Load a LeetCode problem by number'

  const prefix = document.createElement('span')
  prefix.className = 'problem-lookup-prefix'
  prefix.textContent = '#'
  prefix.setAttribute('aria-hidden', 'true')

  const input = document.createElement('input')
  input.className = 'problem-lookup-input'
  input.type = 'text'
  input.inputMode = 'numeric'
  input.pattern = '[0-9]*'
  input.placeholder = 'number'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = model.problemNumberDraft ?? model.problem?.frontendId ?? ''
  input.setAttribute('aria-label', 'LeetCode problem number')
  input.addEventListener('input', () => callbacks.onLookupInput(input.value))
  input.addEventListener('focus', () => input.select())
  field.append(prefix, input)

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'icon-button problem-lookup-submit'
  submit.setAttribute('aria-label', 'Load problem')
  submit.title = 'Load problem'
  submit.append(iconFor('arrowRight', 'button-icon'))
  submit.disabled = model.busy || model.dailyLoading
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    callbacks.onLookupSubmit(input.value)
  })

  form.append(field, submit)
  return form
}

function renderDailySkeleton(): HTMLElement {
  const skeleton = document.createElement('div')
  skeleton.className = 'daily-skeleton'
  skeleton.setAttribute('aria-label', 'Loading today’s problem')
  skeleton.setAttribute('role', 'progressbar')
  skeleton.setAttribute('aria-busy', 'true')
  for (const width of ['48px', '220px', '52px']) {
    const bar = document.createElement('span')
    bar.className = 'skeleton-bar'
    bar.style.width = width
    skeleton.append(bar)
  }
  return skeleton
}

function renderDailyError(
  model: DailyProblemViewModel,
  callbacks: DailyProblemViewCallbacks,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'daily-error'

  const message = document.createElement('span')
  message.className = 'daily-error-copy'
  message.textContent = 'Couldn’t load this problem'
  if (model.dailyError) {
    message.title = model.dailyError
  }

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'text-button'
  retry.textContent = 'Retry'
  retry.disabled = model.dailyLoading
  retry.addEventListener('click', callbacks.onRetry)
  wrapper.append(message, retry)
  return wrapper
}

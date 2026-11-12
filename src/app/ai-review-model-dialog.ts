import type { AiModel, AiModelList, AiModelPricing } from '../backend'
import type {
  AiReviewModelChoice,
  AiReviewModelRequest,
  AiReviewTestRunSelection,
} from './ai-controller'
import { readReviewLlmModel, saveReviewLlmModel } from './llm-settings-controller'

const RADIO_NAME = 'ai-review-model'

/**
 * The models a review may use, cheapest first by output then input price, with
 * unpriced models last: deprecated ones never, and an older model of a line
 * only while it is the remembered choice, so that choice is not lost.
 */
export function aiReviewModelOptions(list: AiModelList | null, remembered: string | null): AiModel[] {
  return (list?.models ?? [])
    .filter((model) => !model.deprecated && (!model.superseded || model.id === remembered))
    .sort((a, b) => {
      if (!a.pricing || !b.pricing) return Number(!a.pricing) - Number(!b.pricing)
      return a.pricing.outputPerMTok - b.pricing.outputPerMTok || a.pricing.inputPerMTok - b.pricing.inputPerMTok
    })
}

/**
 * The model selected when the picker opens: the remembered one while it is
 * offered, else the top of the list. Null when nothing is offered.
 */
export function aiReviewModelPreselection(options: readonly AiModel[], remembered: string | null): string | null {
  if (remembered !== null && options.some((model) => model.id === remembered)) return remembered
  return options[0]?.id ?? null
}

function formatPerMTok(value: number): string {
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 4,
  })}`
}

/** "$3 / $15 per 1M tokens (in / out)", or "Price unknown". */
export function aiReviewModelPrice(pricing: AiModelPricing | null): string {
  return pricing
    ? `${formatPerMTok(pricing.inputPerMTok)} / ${formatPerMTok(pricing.outputPerMTok)} per 1M tokens (in / out)`
    : 'Price unknown'
}

/** Whether the review will carry the last test run, in the picker's words. */
export function aiReviewTestRunStatus(selection: AiReviewTestRunSelection): { included: boolean; text: string } {
  const { testRun } = selection
  if (!testRun) {
    return {
      included: false,
      text: selection.omitted === 'changed'
        ? 'Code changed since the last test run — results won’t be included'
        : 'No test run yet',
    }
  }
  const { passed, failed, errors, skipped, total } = testRun.summary
  const counts = [
    [passed, 'passed'],
    [failed, 'failed'],
    [errors, errors === 1 ? 'error' : 'errors'],
    [skipped, 'skipped'],
  ] as const
  const parts = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`)
  const outcome = parts.length > 0
    ? parts.join(', ')
    : total === 0 && !testRun.success && testRun.phase === 'compile' ? 'compilation failed' : 'no tests ran'
  return { included: true, text: `Includes the last test run (${outcome})` }
}

export interface AiReviewModelDialogOptions {
  root: HTMLElement
  storage?: Storage
}

interface OpenPicker {
  request: AiReviewModelRequest
  /** Null when the catalog offers no model; the test generation model is sent. */
  selected: string | null
  resolve: (choice: AiReviewModelChoice | null) => void
}

/**
 * The picker shown before a review. Opening it sends nothing; only Review
 * does, after the dialog has closed and returned focus. The chosen model is
 * remembered apart from the test generation model.
 */
export class AiReviewModelDialog {
  private readonly root: HTMLElement
  private readonly storage: Storage | undefined
  private readonly listeners: Array<() => void> = []
  private focusTarget: HTMLElement | null = null
  private picker: OpenPicker | null = null

  constructor(options: AiReviewModelDialogOptions) {
    this.root = options.root
    this.storage = options.storage
  }

  get isOpen(): boolean {
    return this.picker !== null
  }

  bindEvents(): void {
    const form = this.element('#ai-review-model-form')
    this.listen(form, 'submit', (event) => {
      event.preventDefault()
      this.submit()
    })
    // Enter on a model submits, as it does in a text field; buttons keep their own Enter.
    this.listen(form, 'keydown', (event) => {
      const key = event as KeyboardEvent
      if (key.key !== 'Enter' || key.isComposing || !this.isRadio(key.target)) return
      event.preventDefault()
      this.submit()
    })
    this.listen(this.element('#ai-review-model-list'), 'change', (event) => {
      if (this.picker && this.isRadio(event.target)) this.picker.selected = event.target.value
    })
    this.listen(this.element('#cancel-ai-review-model'), 'click', () => {
      this.close()
    })
    this.listen(this.element('#ai-review-model-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) this.close()
    })
  }

  /** Resolves with the chosen model, or null when cancelled or already open. */
  show(request: AiReviewModelRequest): Promise<AiReviewModelChoice | null> {
    if (this.picker) return Promise.resolve(null)
    const remembered = readReviewLlmModel(this.storage)
    const options = aiReviewModelOptions(request.models, remembered)
    const selected = aiReviewModelPreselection(options, remembered)
    this.focusTarget = this.root.ownerDocument.activeElement as HTMLElement | null
    const choice = new Promise<AiReviewModelChoice | null>((resolve) => {
      this.picker = { request, selected, resolve }
    })

    this.element('#ai-review-model-file').textContent = request.fileName
    this.element('#ai-review-model-provider').textContent = request.provider?.displayName ?? 'the model'
    const status = aiReviewTestRunStatus(request.testRun)
    const statusLine = this.element('#ai-review-model-test-run')
    statusLine.textContent = status.text
    statusLine.dataset.state = status.included ? 'included' : 'omitted'
    const focus = this.renderOptions(options, selected)
    this.element('#ai-review-model-dialog').hidden = false
    queueMicrotask(() => {
      if (this.picker?.request === request) focus.focus()
    })
    return choice
  }

  close(): void {
    this.finish(null)
  }

  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== 'Escape' || !this.picker) return false
    event.preventDefault()
    this.close()
    return true
  }

  dispose(): void {
    this.finish(null)
    for (const remove of this.listeners.splice(0)) remove()
  }

  private submit(): void {
    const picker = this.picker
    if (!picker) return
    if (picker.selected !== null) saveReviewLlmModel(this.storage, picker.selected)
    this.finish({ modelId: picker.selected ?? picker.request.testModelId })
  }

  /** Close, return focus, then settle, so a request starts with focus back on the button. */
  private finish(choice: AiReviewModelChoice | null): void {
    const picker = this.picker
    if (!picker) return
    this.picker = null
    this.element('#ai-review-model-dialog').hidden = true
    const target = this.focusTarget
    this.focusTarget = null
    if (target?.isConnected && !target.closest?.('[hidden]')) target.focus?.()
    picker.resolve(choice)
  }

  /** Build the radio rows and return what takes focus first: the selected model, or Review. */
  private renderOptions(options: readonly AiModel[], selected: string | null): HTMLElement {
    const documentRef = this.root.ownerDocument
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
      const element = documentRef.createElement(tag)
      element.className = className
      if (text !== undefined) element.textContent = text
      return element
    }
    const list = this.element('#ai-review-model-list')
    if (options.length === 0) {
      list.replaceChildren(make(
        'p',
        'ai-review-model-empty',
        'No model list is cached yet, so the test generation model reviews the code. Settings can refresh the list.',
      ))
      return this.element('#confirm-ai-review-model')
    }
    const radios: HTMLInputElement[] = []
    list.replaceChildren(...options.map((model) => {
      const row = make('label', 'ai-review-model-option')
      const radio = make('input', 'ai-review-model-radio')
      radio.type = 'radio'
      radio.name = RADIO_NAME
      radio.value = model.id
      radio.checked = model.id === selected
      radios.push(radio)
      const copy = make('span', 'ai-review-model-copy')
      copy.append(
        make('span', 'ai-review-model-name', model.displayName),
        make('span', model.pricing ? 'ai-review-model-price' : 'ai-review-model-price is-unknown', aiReviewModelPrice(model.pricing)),
      )
      row.append(radio, copy)
      return row
    }))
    return radios.find((radio) => radio.checked) ?? this.element('#confirm-ai-review-model')
  }

  private isRadio(target: EventTarget | null): target is HTMLInputElement {
    return (target as HTMLInputElement | null)?.name === RADIO_NAME
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing editor element: ${selector}`)
    return element
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener)
    this.listeners.push(() => target.removeEventListener(type, listener))
  }
}

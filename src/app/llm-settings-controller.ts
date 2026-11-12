import {
  errorMessage,
  type AiModelList,
  type AiResponseLanguage,
  type AiUsageSummary,
  type BackendClient,
} from '../backend'
import {
  renderLlmClearKeyDialog,
  renderLlmKey,
  renderLlmModels,
  renderLlmUsage,
  LLM_USAGE_PERIODS,
  type LlmMessage,
  type LlmUsagePeriod,
} from './llm-settings-view'

/** Provider-scoped so another provider's pin can sit beside this one. */
export const LLM_MODEL_STORAGE_KEY = 'leetcoder.llm-model.anthropic'

export type LlmSettingsBackend = Pick<
  BackendClient,
  'aiStatus' | 'aiSaveKey' | 'aiClearKey' | 'aiListModels' | 'aiUsage'
>

export interface LlmSettingsControllerOptions {
  root: HTMLElement
  backend: LlmSettingsBackend
  storage?: Storage
}

/** Not provider-scoped: it is the user's language, whichever provider answers. */
export const LLM_RESPONSE_LANGUAGE_STORAGE_KEY = 'leetcoder.llm-response-language'

const RESPONSE_LANGUAGES: readonly AiResponseLanguage[] = ['english', 'korean']

/** The language reviews are written in. English unless another supported one is stored. */
export function readLlmResponseLanguage(storage: Storage | undefined): AiResponseLanguage {
  const stored = storage?.getItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY)
  return RESPONSE_LANGUAGES.find((language) => language === stored) ?? 'english'
}

/** The pinned model, or null when the catalog default should be used. */
export function readSelectedLlmModel(storage: Storage | undefined): string | null {
  return storage?.getItem(LLM_MODEL_STORAGE_KEY) || null
}

/** The model last chosen for a review, kept apart from the test generation pin. */
export const LLM_REVIEW_MODEL_STORAGE_KEY = 'leetcoder.llm-review-model.anthropic'

/** The model last chosen for a review, or null when none was chosen yet. */
export function readReviewLlmModel(storage: Storage | undefined): string | null {
  return storage?.getItem(LLM_REVIEW_MODEL_STORAGE_KEY) || null
}

export function saveReviewLlmModel(storage: Storage | undefined, modelId: string): void {
  storage?.setItem(LLM_REVIEW_MODEL_STORAGE_KEY, modelId)
}

/** Ascending local-time starts, ending with the bucket holding `now`. Weeks start on Monday. */
export function llmUsageBucketStarts(period: LlmUsagePeriod, now: Date): number[] {
  const year = now.getFullYear()
  const month = now.getMonth()
  const date = now.getDate()
  const starts = (count: number, startOf: (back: number) => Date): number[] =>
    Array.from({ length: count }, (_, index) => startOf(count - 1 - index).getTime())
  if (period === 'day') {
    return starts(14, (back) => new Date(year, month, date - back))
  }
  const monday = date - (now.getDay() + 6) % 7
  return starts(8, (back) => new Date(year, month, monday - 7 * back))
}

/**
 * Own the LLM settings tab. It renders only when its own state changes, so an
 * overlay re-render cannot refetch or disturb the typed key. Each request kind
 * has a token: a response only applies while its token is still the latest.
 */
export class LlmSettingsController {
  private readonly root: HTMLElement
  private readonly backend: LlmSettingsBackend
  private readonly storage: Storage | undefined
  private readonly listeners: Array<() => void> = []
  private disposed = false

  private configured: boolean | null = null
  private statusLoading = false
  private statusRequest = 0
  private keyBusy = false
  private keyMessage: LlmMessage | null = null
  private clearDialogOpen = false
  private keyRevealed = false
  private replacingKey = false

  private modelList: AiModelList | null = null
  private modelsLoading = false
  private modelsFailure: string | null = null
  private modelsRequest = 0

  private usage: AiUsageSummary | null = null
  private usagePeriod: LlmUsagePeriod = 'day'
  private usageDataPeriod: LlmUsagePeriod = 'day'
  private selectedBucketStart: number | null = null
  private usageFailure: string | null = null
  private usageRequest = 0

  constructor(options: LlmSettingsControllerOptions) {
    this.root = options.root
    this.backend = options.backend
    this.storage = options.storage
    this.bindEvents()
    this.languageSelect().value = readLlmResponseLanguage(this.storage)
  }

  activate(): void {
    if (this.disposed) {
      return
    }
    void this.loadUsage()
    void this.loadStatus()
  }

  /** A generation may have added a usage record. Nothing is shown to update otherwise. */
  refreshUsageIfVisible(): void {
    if (this.disposed || this.element('#settings-dialog').hidden || this.element('#settings-llm-panel').hidden) {
      return
    }
    void this.loadUsage()
  }

  dialogClosed(): void {
    if (this.disposed) {
      return
    }
    // A half-typed secret should not outlive the dialog.
    this.keyInput().value = ''
    this.keyRevealed = false
    this.replacingKey = false
    this.closeClearDialog(false)
    if (!this.keyBusy) {
      this.keyMessage = null
    }
    this.renderKey()
  }

  handleEscape(): boolean {
    if (!this.clearDialogOpen) {
      return false
    }
    this.closeClearDialog(true)
    return true
  }

  dispose(): void {
    this.disposed = true
    for (const remove of this.listeners.splice(0)) {
      remove()
    }
  }

  private bindEvents(): void {
    const input = this.keyInput()
    this.listen(input, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault()
        void this.saveKey()
      }
    })
    this.listen(this.element('#llm-toggle-key'), 'click', () => {
      this.keyRevealed = !this.keyRevealed
      this.renderKey()
    })
    this.listen(this.element('#llm-save-key'), 'click', () => {
      void this.saveKey()
    })
    this.listen(this.element('#llm-replace-key'), 'click', () => {
      this.startReplacingKey()
    })
    this.listen(this.element('#llm-cancel-replace-key'), 'click', () => {
      this.cancelReplacingKey()
    })
    this.listen(this.element('#llm-clear-key'), 'click', () => {
      this.openClearDialog()
    })
    this.listen(this.element('#clear-llm-key-form'), 'submit', (event) => {
      event.preventDefault()
      void this.confirmClearKey()
    })
    this.listen(this.element('#cancel-clear-llm-key'), 'click', () => {
      this.closeClearDialog(true)
    })
    this.listen(this.element('#clear-llm-key-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeClearDialog(true)
      }
    })
    this.listen(this.element('#llm-model-select'), 'change', () => {
      this.selectModel(this.element<HTMLSelectElement>('#llm-model-select').value)
    })
    this.listen(this.languageSelect(), 'change', () => {
      this.selectResponseLanguage(this.languageSelect().value)
    })
    this.listen(this.element('#llm-refresh-models'), 'click', () => {
      if (this.configured === true && !this.modelsLoading) {
        void this.loadModels(true)
      }
    })
    for (const period of LLM_USAGE_PERIODS) {
      const tab = this.usageTab(period)
      this.listen(tab, 'click', () => {
        this.selectUsagePeriod(period)
      })
      this.listen(tab, 'keydown', (event) => {
        this.handleUsageTabKey(event as KeyboardEvent, period)
      })
    }
  }

  private async loadStatus(): Promise<void> {
    const request = ++this.statusRequest
    this.statusLoading = true
    this.renderKey()
    this.renderModels()
    try {
      const { configured } = await this.backend.aiStatus()
      if (this.disposed || request !== this.statusRequest) {
        return
      }
      // The field stays up until a saved key is known, so it can take the first focus.
      const keyFieldFocused = this.root.ownerDocument.activeElement === this.keyInput()
      this.statusLoading = false
      this.configured = configured
      this.renderKey()
      if (configured && keyFieldFocused && !this.replacingKey) {
        this.element('#llm-replace-key').focus()
      }
      if (configured) {
        void this.loadModels(true)
      } else {
        this.resetModels()
      }
    } catch (error) {
      if (this.disposed || request !== this.statusRequest) {
        return
      }
      this.statusLoading = false
      this.keyMessage = { tone: 'error', text: `Could not read the key status: ${errorMessage(error)}` }
      this.renderKey()
    }
  }

  private async loadModels(refresh: boolean): Promise<void> {
    const request = ++this.modelsRequest
    this.modelsLoading = true
    this.modelsFailure = null
    this.renderModels()
    try {
      const list = await this.backend.aiListModels(refresh)
      if (this.disposed || request !== this.modelsRequest) {
        return
      }
      this.modelList = list
    } catch (error) {
      if (this.disposed || request !== this.modelsRequest) {
        return
      }
      this.modelsFailure = errorMessage(error)
    }
    this.modelsLoading = false
    this.renderModels()
    // Usage names its models from this list.
    this.renderUsage()
  }

  /** The current data stays up until the response, so a tab switch does not flash. */
  private async loadUsage(): Promise<void> {
    const request = ++this.usageRequest
    const period = this.usagePeriod
    try {
      const usage = await this.backend.aiUsage(llmUsageBucketStarts(period, new Date()))
      if (this.disposed || request !== this.usageRequest) {
        return
      }
      if (period !== this.usageDataPeriod) {
        this.selectedBucketStart = null
      }
      this.usage = usage
      this.usageDataPeriod = period
      this.usageFailure = null
    } catch (error) {
      if (this.disposed || request !== this.usageRequest) {
        return
      }
      this.usageFailure = errorMessage(error)
    }
    this.renderUsage()
  }

  private selectUsagePeriod(period: LlmUsagePeriod, focus = false): void {
    if (focus) {
      this.usageTab(period).focus()
    }
    if (period === this.usagePeriod) {
      return
    }
    this.usagePeriod = period
    this.renderUsage()
    void this.loadUsage()
  }

  private handleUsageTabKey(event: KeyboardEvent, period: LlmUsagePeriod): void {
    const last = LLM_USAGE_PERIODS.length - 1
    const index = LLM_USAGE_PERIODS.indexOf(period)
    const target = event.key === 'ArrowLeft'
      ? (index + last) % LLM_USAGE_PERIODS.length
      : event.key === 'ArrowRight'
        ? (index + 1) % LLM_USAGE_PERIODS.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null
    if (target === null) {
      return
    }
    event.preventDefault()
    this.selectUsagePeriod(LLM_USAGE_PERIODS[target], true)
  }

  private selectBucket(startMs: number): void {
    this.selectedBucketStart = startMs
    this.renderUsage()
  }

  private async saveKey(): Promise<void> {
    if (this.keyBusy) {
      return
    }
    const input = this.keyInput()
    const apiKey = input.value.trim()
    if (!apiKey) {
      this.keyMessage = { tone: 'error', text: 'Enter an API key.' }
      this.renderKey()
      return
    }
    this.keyBusy = true
    this.keyMessage = null
    this.renderKey()
    try {
      const { verified } = await this.backend.aiSaveKey(apiKey)
      if (this.disposed) {
        return
      }
      input.value = ''
      this.keyRevealed = false
      this.replacingKey = false
      this.statusRequest += 1
      this.statusLoading = false
      this.configured = true
      this.keyMessage = verified
        ? { tone: 'success', text: 'Key saved.' }
        : { tone: 'warning', text: 'Key saved, but it could not be verified.' }
      void this.loadModels(true)
      this.keyBusy = false
      this.renderKey()
      // The field and Save button that held focus are now hidden.
      this.element('#llm-replace-key').focus()
      return
    } catch (error) {
      if (this.disposed) {
        return
      }
      this.keyMessage = { tone: 'error', text: `Could not save the key: ${errorMessage(error)}` }
    }
    this.keyBusy = false
    this.renderKey()
  }

  private startReplacingKey(): void {
    if (this.configured !== true || this.keyBusy) {
      return
    }
    this.replacingKey = true
    this.keyMessage = null
    this.renderKey()
    this.keyInput().focus()
  }

  private cancelReplacingKey(): void {
    if (this.keyBusy) {
      return
    }
    this.keyInput().value = ''
    this.keyRevealed = false
    this.replacingKey = false
    this.keyMessage = null
    this.renderKey()
    this.element('#llm-replace-key').focus()
  }

  private openClearDialog(): void {
    if (this.configured !== true || this.keyBusy || this.clearDialogOpen) {
      return
    }
    this.clearDialogOpen = true
    renderLlmClearKeyDialog(this.root, true)
    queueMicrotask(() => {
      if (!this.disposed && this.clearDialogOpen) {
        this.element('#cancel-clear-llm-key').focus()
      }
    })
  }

  private closeClearDialog(restoreFocus: boolean): void {
    if (!this.clearDialogOpen) {
      return
    }
    this.clearDialogOpen = false
    renderLlmClearKeyDialog(this.root, false)
    if (restoreFocus) {
      this.element('#llm-clear-key').focus()
    }
  }

  private async confirmClearKey(): Promise<void> {
    if (!this.clearDialogOpen || this.keyBusy) {
      return
    }
    this.closeClearDialog(false)
    this.keyBusy = true
    this.keyMessage = null
    this.renderKey()
    let focusAfter = '#llm-clear-key'
    try {
      await this.backend.aiClearKey()
      if (this.disposed) {
        return
      }
      this.statusRequest += 1
      this.statusLoading = false
      this.configured = false
      this.keyMessage = { tone: 'info', text: 'Key removed. Your model choice and usage history are kept.' }
      this.resetModels()
      focusAfter = '#llm-api-key'
    } catch (error) {
      if (this.disposed) {
        return
      }
      this.keyMessage = { tone: 'error', text: `Could not remove the key: ${errorMessage(error)}` }
    }
    this.keyBusy = false
    this.renderKey()
    this.element(focusAfter).focus()
  }

  private selectModel(value: string): void {
    if (value) {
      this.storage?.setItem(LLM_MODEL_STORAGE_KEY, value)
    } else {
      this.storage?.removeItem(LLM_MODEL_STORAGE_KEY)
    }
    this.renderModels()
  }

  private selectResponseLanguage(value: string): void {
    if (value === 'english') {
      this.storage?.removeItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY)
    } else if (RESPONSE_LANGUAGES.includes(value as AiResponseLanguage)) {
      this.storage?.setItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY, value)
    }
    this.languageSelect().value = readLlmResponseLanguage(this.storage)
  }

  /** Forget the list without a request, and invalidate any request in flight. */
  private resetModels(): void {
    this.modelsRequest += 1
    this.modelList = null
    this.modelsLoading = false
    this.modelsFailure = null
    this.renderModels()
  }

  private renderKey(): void {
    renderLlmKey(this.root, {
      revealed: this.keyRevealed,
      replacing: this.replacingKey,
      configured: this.configured,
      statusLoading: this.statusLoading,
      busy: this.keyBusy,
      message: this.keyMessage,
    })
  }

  private renderModels(): void {
    renderLlmModels(this.root, {
      configured: this.configured,
      list: this.modelList,
      loading: this.modelsLoading,
      failure: this.modelsFailure,
      selectedModelId: readSelectedLlmModel(this.storage),
    })
  }

  private renderUsage(): void {
    const body = this.element('#llm-usage-body')
    const focusInside = body.contains(this.root.ownerDocument.activeElement)
    const selectedBar = renderLlmUsage(this.root, {
      period: this.usagePeriod,
      usage: this.usage,
      dataPeriod: this.usageDataPeriod,
      selectedStartMs: this.selectedBucketStart,
      modelList: this.modelList,
      failure: this.usageFailure,
      onSelectBucket: (startMs) => {
        this.selectBucket(startMs)
      },
    })
    // Rendering replaced the bar that held focus.
    if (focusInside) {
      selectedBar?.focus()
    }
  }

  private usageTab(period: LlmUsagePeriod): HTMLButtonElement {
    return this.element<HTMLButtonElement>(`#llm-usage-${period}-tab`)
  }

  private languageSelect(): HTMLSelectElement {
    return this.element<HTMLSelectElement>('#llm-language-select')
  }

  private keyInput(): HTMLInputElement {
    return this.element<HTMLInputElement>('#llm-api-key')
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`Missing editor element: ${selector}`)
    }
    return element
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    const bound = listener as EventListener
    target.addEventListener(type, bound)
    this.listeners.push(() => target.removeEventListener(type, bound))
  }
}

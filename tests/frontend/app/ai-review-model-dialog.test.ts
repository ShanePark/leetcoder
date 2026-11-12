import { describe, expect, it, vi } from 'vitest'

import type { AiModel, AiModelList, AiModelPricing, AiReviewTestRun } from '../../../src/backend'
import type { AiReviewModelRequest } from '../../../src/app/ai-controller'
import {
  AiReviewModelDialog,
  aiReviewModelOptions,
  aiReviewModelPreselection,
  aiReviewModelPrice,
  aiReviewTestRunStatus,
} from '../../../src/app/ai-review-model-dialog'
import { LLM_REVIEW_MODEL_STORAGE_KEY } from '../../../src/app/llm-settings-controller'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const pricing = (inputPerMTok: number, outputPerMTok: number): AiModelPricing => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: null,
  cacheWritePerMTok: null,
})

const model = (id: string, extra: Partial<AiModel> = {}): AiModel => ({
  id,
  displayName: `${id} name`,
  deprecated: false,
  superseded: false,
  pricing: null,
  ...extra,
})

const catalog: AiModelList = {
  models: [
    model('small', { pricing: pricing(1, 5) }),
    model('large', { pricing: pricing(5, 25) }),
    model('mid', { pricing: pricing(3, 15) }),
    model('retired', { deprecated: true, pricing: pricing(15, 75) }),
    model('older', { superseded: true, pricing: pricing(15, 75) }),
  ],
  defaultModelId: 'small',
  fetchedAt: 1,
  error: null,
}

const ids = (models: readonly AiModel[]): string[] => models.map((entry) => entry.id)

describe('review model options', () => {
  it('hides deprecated models and keeps a superseded one only while it is remembered', () => {
    expect(ids(aiReviewModelOptions(catalog, null))).toEqual(['small', 'mid', 'large'])
    expect(ids(aiReviewModelOptions(catalog, 'older'))).toEqual(['small', 'mid', 'large', 'older'])
    expect(ids(aiReviewModelOptions(catalog, 'retired'))).toEqual(['small', 'mid', 'large'])
    expect(aiReviewModelOptions(null, 'small')).toEqual([])
  })

  it('lists the cheapest model first, breaks output ties by input price, and puts unpriced models last', () => {
    const list: AiModelList = {
      ...catalog,
      models: [
        model('unpriced'),
        model('pricey', { pricing: pricing(5, 25) }),
        model('tie-high-input', { pricing: pricing(2, 10) }),
        model('tie-low-input', { pricing: pricing(1, 10) }),
      ],
    }
    expect(ids(aiReviewModelOptions(list, null))).toEqual(['tie-low-input', 'tie-high-input', 'pricey', 'unpriced'])
  })

  it('formats per-million prices', () => {
    expect(aiReviewModelPrice(pricing(3, 15))).toBe('$3 / $15 per 1M tokens (in / out)')
    expect(aiReviewModelPrice(pricing(0.8, 4))).toBe('$0.80 / $4 per 1M tokens (in / out)')
    expect(aiReviewModelPrice(pricing(0.075, 1.25))).toBe('$0.075 / $1.25 per 1M tokens (in / out)')
    expect(aiReviewModelPrice(null)).toBe('Price unknown')
  })
})

describe('review model preselection', () => {
  const options = aiReviewModelOptions(catalog, 'older')

  it('keeps the remembered model while it is offered', () => {
    expect(aiReviewModelPreselection(options, 'mid')).toBe('mid')
    expect(aiReviewModelPreselection(options, 'older')).toBe('older')
  })

  it('otherwise picks the top of the list', () => {
    expect(aiReviewModelPreselection(options, null)).toBe('small')
    expect(aiReviewModelPreselection(options, 'gone')).toBe('small')
    expect(aiReviewModelPreselection([], null)).toBeNull()
  })
})

describe('review test run status', () => {
  const run = (summary: Partial<AiReviewTestRun['summary']>, extra: Partial<AiReviewTestRun> = {}): AiReviewTestRun => ({
    success: false,
    phase: 'test',
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, ...summary },
    tests: [],
    diagnostics: [],
    ...extra,
  })

  it('names the counts of an included run', () => {
    expect(aiReviewTestRunStatus({ testRun: run({ total: 4, passed: 3, failed: 1 }), omitted: null })).toEqual({
      included: true,
      text: 'Includes the last test run (3 passed, 1 failed)',
    })
    expect(aiReviewTestRunStatus({ testRun: run({ total: 3, passed: 1, errors: 1, skipped: 1 }), omitted: null }).text)
      .toBe('Includes the last test run (1 passed, 1 error, 1 skipped)')
    expect(aiReviewTestRunStatus({ testRun: run({}, { phase: 'compile' }), omitted: null }).text)
      .toBe('Includes the last test run (compilation failed)')
  })

  it('says why a run is left out', () => {
    expect(aiReviewTestRunStatus({ testRun: null, omitted: 'no-run' })).toEqual({
      included: false,
      text: 'No test run yet',
    })
    expect(aiReviewTestRunStatus({ testRun: null, omitted: 'changed' }).text)
      .toBe('Code changed since the last test run — results won’t be included')
  })
})

class FakeNode {
  hidden = false
  textContent = ''
  className = ''
  value = ''
  name = ''
  type = ''
  checked = false
  isConnected = true
  readonly dataset: Record<string, string> = {}
  readonly children: FakeNode[] = []
  readonly listeners = new Map<string, (event: unknown) => void>()

  constructor(private readonly doc: FakeDocument, readonly tagName = 'div') {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }

  dispatch(type: string, event: object = {}): void {
    this.listeners.get(type)?.({ currentTarget: this, ...event })
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  focus(): void {
    this.doc.activeElement = this
  }

  closest(): null {
    return null
  }
}

class FakeDocument {
  activeElement: FakeNode | null = null

  createElement(tagName: string): FakeNode {
    return new FakeNode(this, tagName)
  }
}

function setup(storage = new MemoryStorage()) {
  const document = new FakeDocument()
  const controls = new Map<string, FakeNode>()
  const element = (selector: string): FakeNode => {
    let control = controls.get(selector)
    if (!control) {
      control = new FakeNode(document)
      controls.set(selector, control)
    }
    return control
  }
  const root = { ownerDocument: document, querySelector: element } as unknown as HTMLElement
  const dialog = new AiReviewModelDialog({ root, storage: storage as unknown as Storage })
  dialog.bindEvents()
  const button = new FakeNode(document, 'button')
  button.focus()
  const radios = (): FakeNode[] => element('#ai-review-model-list').children
    .filter((row) => row.tagName === 'label')
    .map((row) => row.children[0])
  return {
    dialog,
    storage,
    document,
    button,
    element,
    radios,
    submit: () => element('#ai-review-model-form').dispatch('submit', { preventDefault: vi.fn() }),
  }
}

const request = (extra: Partial<AiReviewModelRequest> = {}): AiReviewModelRequest => ({
  fileName: 'Q1TwoSum.java',
  provider: { id: 'anthropic', displayName: 'Claude' },
  models: catalog,
  testModelId: 'small',
  testRun: { testRun: null, omitted: 'changed' },
  ...extra,
})

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

describe('review model dialog', () => {
  it('shows the file, provider, test run status, and current models with prices', async () => {
    const { dialog, element, radios, document } = setup()
    void dialog.show(request())
    await flush()

    expect(element('#ai-review-model-dialog').hidden).toBe(false)
    expect(element('#ai-review-model-file').textContent).toBe('Q1TwoSum.java')
    expect(element('#ai-review-model-provider').textContent).toBe('Claude')
    expect(element('#ai-review-model-test-run')).toMatchObject({
      textContent: 'Code changed since the last test run — results won’t be included',
      dataset: { state: 'omitted' },
    })
    expect(radios().map((radio) => [radio.value, radio.type, radio.name, radio.checked])).toEqual([
      ['small', 'radio', 'ai-review-model', true],
      ['mid', 'radio', 'ai-review-model', false],
      ['large', 'radio', 'ai-review-model', false],
    ])
    const prices = element('#ai-review-model-list').children.map((row) => row.children[1].children[1].textContent)
    expect(prices).toEqual([
      '$1 / $5 per 1M tokens (in / out)',
      '$3 / $15 per 1M tokens (in / out)',
      '$5 / $25 per 1M tokens (in / out)',
    ])
    expect(document.activeElement).toBe(radios()[0])
  })

  it('resolves with the chosen model after closing and remembers it', async () => {
    const { dialog, element, radios, storage, document, button, submit } = setup()
    const choice = dialog.show(request())
    await flush()
    const mid = radios().find((radio) => radio.value === 'mid')!
    mid.checked = true
    element('#ai-review-model-list').dispatch('change', { target: mid })
    submit()

    await expect(choice).resolves.toEqual({ modelId: 'mid' })
    expect(element('#ai-review-model-dialog').hidden).toBe(true)
    expect(document.activeElement).toBe(button)
    expect(storage.getItem(LLM_REVIEW_MODEL_STORAGE_KEY)).toBe('mid')
    expect(dialog.isOpen).toBe(false)
  })

  it('preselects the remembered model on the next opening', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_REVIEW_MODEL_STORAGE_KEY, 'small')
    const { dialog, radios, submit } = setup(storage)
    const choice = dialog.show(request())
    expect(radios().find((radio) => radio.checked)?.value).toBe('small')
    submit()
    await expect(choice).resolves.toEqual({ modelId: 'small' })
  })

  it('resolves with null on Cancel, Escape, or a backdrop click, and remembers nothing', async () => {
    const { dialog, element, storage } = setup()
    const cancelled = dialog.show(request())
    element('#cancel-ai-review-model').dispatch('click')
    await expect(cancelled).resolves.toBeNull()

    const escaped = dialog.show(request())
    const escape = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(dialog.handleEscape(escape)).toBe(true)
    await expect(escaped).resolves.toBeNull()
    expect(dialog.handleEscape(escape)).toBe(false)

    const backdrop = element('#ai-review-model-dialog')
    const dismissed = dialog.show(request())
    backdrop.dispatch('pointerdown', { target: backdrop })
    await expect(dismissed).resolves.toBeNull()
    expect(storage.getItem(LLM_REVIEW_MODEL_STORAGE_KEY)).toBeNull()
  })

  it('submits on Enter from a model but not from a button', async () => {
    const { dialog, element, radios } = setup()
    const choice = dialog.show(request())
    const form = element('#ai-review-model-form')
    const fromButton = { key: 'Enter', target: element('#cancel-ai-review-model'), preventDefault: vi.fn() }
    form.dispatch('keydown', fromButton)
    expect(fromButton.preventDefault).not.toHaveBeenCalled()
    expect(dialog.isOpen).toBe(true)

    const fromRadio = { key: 'Enter', target: radios()[0], preventDefault: vi.fn() }
    form.dispatch('keydown', fromRadio)
    expect(fromRadio.preventDefault).toHaveBeenCalled()
    await expect(choice).resolves.toEqual({ modelId: 'small' })
  })

  it('uses the test model without remembering it when no model is listed', async () => {
    const { dialog, element, storage, document, submit } = setup()
    const choice = dialog.show(request({
      models: null,
      testRun: { testRun: { success: true, phase: 'test', summary: { total: 2, passed: 2, failed: 0, skipped: 0, errors: 0 }, tests: [], diagnostics: [] }, omitted: null },
    }))
    await flush()
    expect(element('#ai-review-model-list').children.map((child) => child.className)).toEqual(['ai-review-model-empty'])
    expect(element('#ai-review-model-test-run')).toMatchObject({
      textContent: 'Includes the last test run (2 passed)',
      dataset: { state: 'included' },
    })
    expect(document.activeElement).toBe(element('#confirm-ai-review-model'))
    submit()
    await expect(choice).resolves.toEqual({ modelId: 'small' })
    expect(storage.getItem(LLM_REVIEW_MODEL_STORAGE_KEY)).toBeNull()
  })

  it('refuses a second opening and settles an open picker on dispose', async () => {
    const { dialog } = setup()
    const first = dialog.show(request())
    await expect(dialog.show(request())).resolves.toBeNull()
    dialog.dispose()
    await expect(first).resolves.toBeNull()
  })
})

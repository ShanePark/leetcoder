import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiKeySaveResult, AiModelList, AiStatus, AiUsageSummary, AiUsageTotals } from '../../../src/backend'
import {
  LLM_MODEL_STORAGE_KEY,
  LLM_RESPONSE_LANGUAGE_STORAGE_KEY,
  LlmSettingsController,
  llmUsageBucketStarts,
  readLlmResponseLanguage,
  readSelectedLlmModel,
  type LlmSettingsBackend,
} from '../../../src/app/llm-settings-controller'
import { OverlayController, type LlmSettingsPanel } from '../../../src/app/overlay-controller'
import { renderShellView } from '../../../src/app/shell-view'
import { deferred } from './lifecycle-harness'

vi.mock('../../../src/icons', () => ({
  iconFor: (name: string) => ({ dataset: { icon: name }, text: () => '', dump: () => '' }),
}))

type Listener = (event: Event) => void

class FakeElement {
  readonly listeners = new Map<string, Set<Listener>>()
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly classes = new Set<string>()
  readonly style: Record<string, string> = {}
  readonly classList = {
    toggle: (name: string, force?: boolean): void => {
      if (force ?? !this.classes.has(name)) this.classes.add(name)
      else this.classes.delete(name)
    },
  }
  readonly tagName: string
  ownerDocument: FakeDocument
  className = ''
  textContent = ''
  title = ''
  value = ''
  placeholder = ''
  innerHTML = ''
  hidden = false
  disabled = false
  readOnly = false
  checked = false
  tabIndex = 0
  isConnected = true

  constructor(ownerDocument: FakeDocument, tagName = 'div') {
    this.ownerDocument = ownerDocument
    this.tagName = tagName
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, values: Record<string, unknown> = {}): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { preventDefault: vi.fn(), currentTarget: this, target: this, ...values }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as unknown as Event)
    }
    return event
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0
    this.children.push(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  closest(): FakeElement | null {
    return null
  }

  contains(node: FakeElement | null): boolean {
    return node === this || this.children.some((child) => child.contains(node))
  }

  querySelectorAll(): FakeElement[] {
    return []
  }

  /** This element's visible text, including descendants. */
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join(' ')
  }

  /** Everything this element could expose, for checks that a secret is absent. */
  dump(): string {
    return JSON.stringify([
      this.textContent,
      this.value,
      this.title,
      this.placeholder,
      this.innerHTML,
      this.dataset,
      [...this.attributes],
      this.children.map((child) => child.dump()),
    ])
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null
  readonly documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: '' } }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName)
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement(this, '#text')
    node.textContent = text
    return node
  }
}

class FakeRoot extends FakeElement {
  readonly elements = new Map<string, FakeElement>()

  querySelector(selector: string): FakeElement {
    let element = this.elements.get(selector)
    if (!element) {
      element = new FakeElement(this.ownerDocument)
      this.elements.set(selector, element)
    }
    return element
  }

  dumpAll(): string {
    return [...this.elements.values()].map((element) => element.dump()).join('\n')
  }
}

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function installRoot(): FakeRoot {
  const fakeDocument = new FakeDocument()
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  return new FakeRoot(fakeDocument)
}

const emptyTotals: AiUsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedRequests: 0,
  approximateRequests: 0,
  refusedRequests: 0,
}

const emptyUsage: AiUsageSummary = {
  buckets: [],
  allTime: emptyTotals,
  skippedLines: 0,
}

/** One newest bucket holding everything. */
function usageOf(totals: AiUsageTotals): AiUsageSummary {
  return { ...emptyUsage, buckets: [{ startMs: 0, totals, perModel: [] }], allTime: totals }
}

const provider = { id: 'anthropic', displayName: 'Claude' }

const modelList: AiModelList = {
  models: [
    { id: 'model-opus', displayName: 'Opus Name', deprecated: false, superseded: false, pricing: null },
    { id: 'model-haiku', displayName: 'Haiku Name', deprecated: false, superseded: false, pricing: null },
    { id: 'model-old', displayName: 'Old Name', deprecated: true, superseded: false, pricing: null },
  ],
  defaultModelId: 'model-haiku',
  fetchedAt: Date.UTC(2026, 10, 3, 12),
  error: null,
}

function createBackend() {
  return {
    aiStatus: vi.fn<() => Promise<AiStatus>>().mockResolvedValue({ configured: false, provider }),
    aiSaveKey: vi.fn<(apiKey: string) => Promise<AiKeySaveResult>>().mockResolvedValue({ verified: true }),
    aiClearKey: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    aiListModels: vi.fn<(refresh: boolean) => Promise<AiModelList>>().mockResolvedValue(modelList),
    aiUsage: vi.fn<(bucketStartsMs: number[]) => Promise<AiUsageSummary>>().mockResolvedValue(emptyUsage),
  } satisfies LlmSettingsBackend
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve))
}

interface Harness {
  root: FakeRoot
  backend: ReturnType<typeof createBackend>
  storage: MemoryStorage
  controller: LlmSettingsController
  el: (selector: string) => FakeElement
  input: FakeElement
}

function createHarness(backend = createBackend(), storage = new MemoryStorage()): Harness {
  const root = installRoot()
  const controller = new LlmSettingsController({
    root: root as unknown as HTMLElement,
    backend,
    storage: storage as unknown as Storage,
  })
  return {
    root,
    backend,
    storage,
    controller,
    el: (selector) => root.querySelector(selector),
    input: root.querySelector('#llm-api-key'),
  }
}

async function activated(backend = createBackend(), storage = new MemoryStorage()): Promise<Harness> {
  const harness = createHarness(backend, storage)
  harness.controller.activate()
  await settle()
  return harness
}

function configuredBackend(): ReturnType<typeof createBackend> {
  const backend = createBackend()
  backend.aiStatus.mockResolvedValue({ configured: true, provider })
  return backend
}

function optionLabels(harness: Harness): string[] {
  return harness.el('#llm-model-select').children.map((option) => option.textContent)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument)
  } else {
    Reflect.deleteProperty(globalThis, 'document')
  }
})

describe('settings section switching', () => {
  function overlayHarness() {
    const root = installRoot()
    const panel: { [K in keyof LlmSettingsPanel]: ReturnType<typeof vi.fn> } = {
      activate: vi.fn(),
      dialogClosed: vi.fn(),
      handleEscape: vi.fn().mockReturnValue(false),
      dispose: vi.fn(),
    }
    const overlay = new OverlayController({
      root: root as unknown as HTMLElement,
      macPlatform: false,
      llmSettings: panel as unknown as LlmSettingsPanel,
    })
    return { root, panel, overlay }
  }

  function visibleSections(root: FakeRoot): string[] {
    return ['appearance', 'keymap', 'llm']
      .filter((section) => !root.querySelector(`#settings-${section}-panel`).hidden)
  }

  it('shows exactly the selected panel and marks its tab', () => {
    const { root, overlay } = overlayHarness()
    overlay.openSettingsDialog('appearance')
    expect(visibleSections(root)).toEqual(['appearance'])

    for (const section of ['llm', 'keymap', 'appearance']) {
      root.querySelector(`#settings-${section}-nav`).dispatch('click')
      expect(visibleSections(root)).toEqual([section])
      expect(root.querySelector(`#settings-${section}-nav`).attributes.get('aria-selected')).toBe('true')
      expect(root.querySelector(`#settings-${section}-nav`).tabIndex).toBe(0)
      expect(root.querySelector(`#settings-${section}-nav`).classes.has('is-active')).toBe(true)
    }
    expect(root.querySelector('#settings-llm-nav').attributes.get('aria-selected')).toBe('false')
    expect(root.querySelector('#settings-llm-nav').tabIndex).toBe(-1)
  })

  it('moves through all sections with the keyboard and stops at the ends', () => {
    const { root, overlay } = overlayHarness()
    overlay.openSettingsDialog('appearance')
    const press = (section: string, key: string) =>
      root.querySelector(`#settings-${section}-nav`).dispatch('keydown', { key })

    expect(press('appearance', 'ArrowDown').preventDefault).toHaveBeenCalledOnce()
    expect(visibleSections(root)).toEqual(['keymap'])
    press('keymap', 'ArrowRight')
    expect(visibleSections(root)).toEqual(['llm'])
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('#settings-llm-nav'))
    press('llm', 'ArrowDown')
    expect(visibleSections(root)).toEqual(['llm'])
    press('llm', 'ArrowUp')
    expect(visibleSections(root)).toEqual(['keymap'])
    press('keymap', 'End')
    expect(visibleSections(root)).toEqual(['llm'])
    press('llm', 'Home')
    expect(visibleSections(root)).toEqual(['appearance'])
    press('appearance', 'ArrowUp')
    expect(visibleSections(root)).toEqual(['appearance'])
    expect(press('appearance', 'a').preventDefault).not.toHaveBeenCalled()
  })

  it('focuses the key field when opened on the LLM section', async () => {
    const { root, overlay } = overlayHarness()
    overlay.openSettingsDialog('llm')
    await Promise.resolve()
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('#llm-api-key'))
  })

  it('focuses Replace when opened on the LLM section with the key field hidden', async () => {
    const { root, overlay } = overlayHarness()
    root.querySelector('#llm-key-entry').hidden = true
    overlay.openSettingsDialog('llm')
    await Promise.resolve()
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('#llm-replace-key'))
  })

  it('activates the tab only on the transition to visible', () => {
    const { root, panel, overlay } = overlayHarness()
    overlay.openSettingsDialog('appearance')
    expect(panel.activate).not.toHaveBeenCalled()

    root.querySelector('#settings-llm-nav').dispatch('click')
    expect(panel.activate).toHaveBeenCalledOnce()
    overlay.render()
    overlay.render()
    overlay.openSettingsDialog('llm')
    expect(panel.activate).toHaveBeenCalledOnce()

    root.querySelector('#settings-keymap-nav').dispatch('click')
    root.querySelector('#settings-llm-nav').dispatch('click')
    expect(panel.activate).toHaveBeenCalledTimes(2)

    overlay.closeSettingsDialog()
    expect(panel.dialogClosed).toHaveBeenCalledOnce()
    overlay.openSettingsDialog('llm')
    expect(panel.activate).toHaveBeenCalledTimes(3)
  })

  it('lets the tab handle Escape before the dialog closes', () => {
    const { panel, overlay } = overlayHarness()
    overlay.openSettingsDialog('llm')

    panel.handleEscape.mockReturnValueOnce(true)
    const escape = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(overlay.handleEscape(escape)).toBe(true)
    expect(overlay.isSettingsDialogOpen).toBe(true)

    expect(overlay.handleEscape(escape)).toBe(true)
    expect(overlay.isSettingsDialogOpen).toBe(false)
  })

  it('never lets the settings form submit', () => {
    const { root } = overlayHarness()
    const submit = root.querySelector('#settings-form').dispatch('submit')
    expect(submit.preventDefault).toHaveBeenCalledOnce()
  })

  it('disposes the tab with the overlay', () => {
    const { panel, overlay } = overlayHarness()
    overlay.dispose()
    expect(panel.dispose).toHaveBeenCalledOnce()
  })
})

describe('shell markup', () => {
  function shellMarkup(): string {
    const root = { innerHTML: '' } as HTMLElement
    renderShellView(root, {
      appVersion: '0',
      macPlatform: false,
      minSidebarWidth: 0,
      maxSidebarWidth: 0,
      minDailyDescriptionHeight: 0,
      maxDailyDescriptionHeight: 0,
      minBottomPanelHeight: 0,
      maxBottomPanelHeight: 0,
      minGitFileListWidth: 0,
      maxGitFileListWidth: 0,
    })
    return root.innerHTML
  }

  it('declares the key field as an unnamed password input with no stored value', () => {
    const input = /<input id="llm-api-key"[^>]*>/.exec(shellMarkup())?.[0] ?? ''
    expect(input).toContain('type="password"')
    expect(input).toContain('autocomplete="off"')
    expect(input).not.toContain('name=')
    expect(input).not.toContain('value=')
  })

  it('uses button-type controls so Enter has one path to saving', () => {
    const markup = shellMarkup()
    const form = markup.slice(markup.indexOf('id="settings-form"'), markup.indexOf('id="clear-llm-key-dialog"'))
    expect(form).not.toContain('type="submit"')
  })

  it.each(['llm-console-link', 'llm-keys-link'])('opens %s like other external links', (id) => {
    const link = new RegExp(`<a id="${id}"[^>]*>`).exec(shellMarkup())?.[0] ?? ''
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noreferrer noopener"')
    expect(link).toMatch(/href="https:\/\//)
  })

  it('offers English and Korean review languages, English first', () => {
    const select = /<select id="llm-language-select"[^>]*>([\s\S]*?)<\/select>/.exec(shellMarkup())?.[1] ?? ''
    expect([...select.matchAll(/value="([^"]*)"/g)].map((match) => match[1])).toEqual(['english', 'korean'])
    expect(select).toContain('lang="ko"')
  })
})

describe('LLM review language', () => {
  it('defaults to English and ignores unknown stored values', () => {
    const storage = new MemoryStorage()
    expect(readLlmResponseLanguage(undefined)).toBe('english')
    expect(readLlmResponseLanguage(storage as unknown as Storage)).toBe('english')
    storage.setItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY, 'klingon')
    expect(readLlmResponseLanguage(storage as unknown as Storage)).toBe('english')
  })

  it('shows the stored language and persists a change without a key', () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY, 'korean')
    const harness = createHarness(createBackend(), storage)
    const select = harness.el('#llm-language-select')
    expect(select.value).toBe('korean')

    select.value = 'english'
    select.dispatch('change')
    expect(storage.getItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY)).toBeNull()
    expect(readLlmResponseLanguage(storage as unknown as Storage)).toBe('english')

    select.value = 'korean'
    select.dispatch('change')
    expect(storage.getItem(LLM_RESPONSE_LANGUAGE_STORAGE_KEY)).toBe('korean')
    expect(harness.backend.aiStatus).not.toHaveBeenCalled()
  })
})

describe('LLM key entry', () => {
  it('saves once on Enter and blocks the form submission', async () => {
    const { input, backend } = await activated()
    input.value = '  typed-key  '

    const enter = input.dispatch('keydown', { key: 'Enter' })
    input.dispatch('keydown', { key: 'Enter' })
    expect(enter.preventDefault).toHaveBeenCalledOnce()
    await settle()

    expect(backend.aiSaveKey).toHaveBeenCalledOnce()
    expect(backend.aiSaveKey).toHaveBeenCalledWith('typed-key')
  })

  it('ignores other keys and reports an empty field without calling the backend', async () => {
    const { input, backend, el } = await activated()
    input.value = 'partial'
    expect(input.dispatch('keydown', { key: 'a' }).preventDefault).not.toHaveBeenCalled()
    input.value = '   '
    input.dispatch('keydown', { key: 'Enter' })
    await settle()

    expect(backend.aiSaveKey).not.toHaveBeenCalled()
    expect(el('#llm-key-message').textContent).toBe('Enter an API key.')
  })

  it('clears the input, loads models, and renders no key value after saving', async () => {
    const secret = 'sk-very-secret-value'
    const { input, backend, el, root, storage } = await activated()
    expect(el('#llm-key-status').textContent).toBe('No key saved')
    input.value = secret

    el('#llm-save-key').dispatch('click')
    expect(input.readOnly).toBe(true)
    expect(el('#llm-save-key').disabled).toBe(true)
    await settle()

    expect(input.value).toBe('')
    expect(input.readOnly).toBe(false)
    expect(el('#llm-key-status').textContent).toBe('Key saved')
    expect(el('#llm-key-message').textContent).toBe('Key saved.')
    expect(el('#llm-clear-key').hidden).toBe(false)
    expect(el('#llm-replace-key').hidden).toBe(false)
    expect(el('#llm-key-entry').hidden).toBe(true)
    expect(root.ownerDocument.activeElement).toBe(el('#llm-replace-key'))
    expect(backend.aiListModels).toHaveBeenCalledWith(true)
    expect(root.dumpAll()).not.toContain(secret)
    expect(JSON.stringify([...storage.values])).not.toContain(secret)
  })

  it('says when a saved key could not be verified', async () => {
    const backend = createBackend()
    backend.aiSaveKey.mockResolvedValue({ verified: false })
    const { input, el } = await activated(backend)
    input.value = 'key'
    el('#llm-save-key').dispatch('click')
    await settle()

    expect(input.value).toBe('')
    expect(el('#llm-key-status').textContent).toBe('Key saved')
    expect(el('#llm-key-message').textContent).toBe('Key saved, but it could not be verified.')
    expect(el('#llm-key-message').className).toContain('is-warning')
  })

  it('shows a rejected key as an error and leaves the previous state', async () => {
    const backend = createBackend()
    backend.aiSaveKey.mockRejectedValue(new Error('The provider rejected this key (401).'))
    const { input, el } = await activated(backend)
    input.value = 'bad-key'
    el('#llm-save-key').dispatch('click')
    await settle()

    expect(el('#llm-key-status').textContent).toBe('No key saved')
    expect(el('#llm-key-message').textContent).toBe('Could not save the key: The provider rejected this key (401).')
    expect(el('#llm-key-message').className).toContain('is-error')
    expect(input.value).toBe('bad-key')
    expect(input.readOnly).toBe(false)
    expect(backend.aiListModels).not.toHaveBeenCalled()
  })

  it('keeps a saved key and its models when a replacement is rejected', async () => {
    const backend = configuredBackend()
    backend.aiSaveKey.mockRejectedValue(new Error('401'))
    const harness = await activated(backend)
    backend.aiListModels.mockClear()
    harness.el('#llm-replace-key').dispatch('click')
    harness.input.value = 'bad-key'
    harness.el('#llm-save-key').dispatch('click')
    await settle()

    expect(harness.el('#llm-key-status').textContent).toBe('Key saved')
    expect(harness.el('#llm-key-entry').hidden).toBe(false)
    expect(harness.input.value).toBe('bad-key')
    expect(optionLabels(harness)).toContain('Opus Name')
    expect(backend.aiListModels).not.toHaveBeenCalled()

    harness.el('#llm-cancel-replace-key').dispatch('click')

    expect(harness.el('#llm-clear-key').hidden).toBe(false)
    expect(harness.input.value).toBe('')
  })

  it('hides the key field behind Replace once a key is saved', async () => {
    const { el, input, root } = await activated(configuredBackend())
    const entry = el('#llm-key-entry')
    const replace = el('#llm-replace-key')
    expect(entry.hidden).toBe(true)
    expect(replace.hidden).toBe(false)
    expect(el('#llm-cancel-replace-key').hidden).toBe(true)

    replace.dispatch('click')

    expect(entry.hidden).toBe(false)
    expect(replace.hidden).toBe(true)
    expect(el('#llm-clear-key').hidden).toBe(true)
    expect(el('#llm-cancel-replace-key').hidden).toBe(false)
    expect(root.ownerDocument.activeElement).toBe(input)

    input.value = 'half-typed'
    el('#llm-toggle-key').dispatch('click')
    el('#llm-cancel-replace-key').dispatch('click')

    expect(entry.hidden).toBe(true)
    expect(input.value).toBe('')
    expect((input as unknown as { type?: string }).type).toBe('password')
    expect(root.ownerDocument.activeElement).toBe(replace)
  })

  it('returns to the saved view after a replacement and when the dialog closes', async () => {
    const { el, input, controller } = await activated(configuredBackend())
    const entry = el('#llm-key-entry')

    el('#llm-replace-key').dispatch('click')
    input.value = 'new-key'
    el('#llm-save-key').dispatch('click')
    await settle()
    expect(entry.hidden).toBe(true)
    expect(el('#llm-key-message').textContent).toBe('Key saved.')

    el('#llm-replace-key').dispatch('click')
    controller.dialogClosed()
    expect(entry.hidden).toBe(true)
  })

  it('keeps the key field up with no saved key and when the status is unknown', async () => {
    const { el } = await activated()
    expect(el('#llm-key-entry').hidden).toBe(false)
    expect(el('#llm-replace-key').hidden).toBe(true)

    const backend = createBackend()
    backend.aiStatus.mockRejectedValue(new Error('disk error'))
    const failed = await activated(backend)
    expect(failed.el('#llm-key-entry').hidden).toBe(false)
  })

  it('moves focus off the key field when the status finds a saved key', async () => {
    const backend = configuredBackend()
    const status = deferred<AiStatus>()
    backend.aiStatus.mockReturnValueOnce(status.promise)
    const { input, el, root, controller } = createHarness(backend)
    controller.activate()
    input.focus()

    status.resolve({ configured: true, provider })
    await settle()

    expect(el('#llm-key-entry').hidden).toBe(true)
    expect(root.ownerDocument.activeElement).toBe(el('#llm-replace-key'))
  })

  it('reports a failed status request', async () => {
    const backend = createBackend()
    backend.aiStatus.mockRejectedValue(new Error('disk error'))
    const { el } = await activated(backend)

    expect(el('#llm-key-status').textContent).toBe('Key status unavailable')
    expect(el('#llm-key-message').textContent).toContain('disk error')
    expect(backend.aiListModels).not.toHaveBeenCalled()
  })

  it('drops a typed key and transient message when the dialog closes', async () => {
    const { input, el, controller } = await activated()
    input.value = ''
    el('#llm-save-key').dispatch('click')
    input.value = 'half-typed'

    controller.dialogClosed()

    expect(input.value).toBe('')
    expect(el('#llm-key-message').hidden).toBe(true)
  })
})

describe('LLM key removal', () => {
  it('asks for confirmation and removes only after it', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_MODEL_STORAGE_KEY, 'model-opus')
    const backend = configuredBackend()
    const harness = await activated(backend, storage)
    const { el } = harness
    const dialog = el('#clear-llm-key-dialog')

    el('#llm-clear-key').dispatch('click')
    await Promise.resolve()
    expect(dialog.hidden).toBe(false)
    expect(harness.root.ownerDocument.activeElement).toBe(el('#cancel-clear-llm-key'))
    expect(backend.aiClearKey).not.toHaveBeenCalled()

    const submit = el('#clear-llm-key-form').dispatch('submit')
    expect(submit.preventDefault).toHaveBeenCalledOnce()
    expect(dialog.hidden).toBe(true)
    await settle()

    expect(backend.aiClearKey).toHaveBeenCalledOnce()
    expect(el('#llm-key-status').textContent).toBe('No key saved')
    expect(el('#llm-clear-key').hidden).toBe(true)
    expect(el('#llm-model-select').disabled).toBe(true)
    expect(el('#llm-model-notes').text()).toContain('Add a key to load models.')
    expect(optionLabels(harness)).toEqual(['Default (newest Haiku)', 'model-opus'])
    expect(storage.getItem(LLM_MODEL_STORAGE_KEY)).toBe('model-opus')
    expect(el('#llm-key-entry').hidden).toBe(false)
    expect(harness.root.ownerDocument.activeElement).toBe(harness.input)
  })

  it('cancels from the button, the backdrop, and Escape', async () => {
    const backend = configuredBackend()
    const { el, controller, root } = await activated(backend)
    const dialog = el('#clear-llm-key-dialog')
    const remove = el('#llm-clear-key')

    remove.dispatch('click')
    el('#cancel-clear-llm-key').dispatch('click')
    expect(dialog.hidden).toBe(true)
    expect(root.ownerDocument.activeElement).toBe(remove)

    remove.dispatch('click')
    dialog.dispatch('pointerdown')
    expect(dialog.hidden).toBe(true)

    remove.dispatch('click')
    expect(controller.handleEscape()).toBe(true)
    expect(dialog.hidden).toBe(true)
    expect(controller.handleEscape()).toBe(false)

    await settle()
    expect(backend.aiClearKey).not.toHaveBeenCalled()
  })

  it('shows a failed removal and keeps the key state', async () => {
    const backend = configuredBackend()
    backend.aiClearKey.mockRejectedValue(new Error('read-only file'))
    const harness = await activated(backend)
    harness.el('#llm-clear-key').dispatch('click')
    harness.el('#clear-llm-key-form').dispatch('submit')
    await settle()

    expect(harness.el('#llm-key-status').textContent).toBe('Key saved')
    expect(harness.el('#llm-key-message').textContent).toBe('Could not remove the key: read-only file')
    expect(optionLabels(harness)).toContain('Opus Name')
    expect(harness.root.ownerDocument.activeElement).toBe(harness.el('#llm-clear-key'))
  })
})

describe('LLM stale responses and re-renders', () => {
  it('ignores an older model list that arrives after a newer one', async () => {
    const backend = configuredBackend()
    const older = deferred<AiModelList>()
    const newer = deferred<AiModelList>()
    backend.aiListModels.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const harness = await activated(backend)

    // Reopening the tab supersedes the request still in flight.
    harness.controller.activate()
    await settle()
    newer.resolve({ ...modelList, models: [{ id: 'new', displayName: 'New Name', deprecated: false, superseded: false, pricing: null }] })
    await settle()
    older.resolve({ ...modelList, models: [{ id: 'old', displayName: 'Stale Name', deprecated: false, superseded: false, pricing: null }] })
    await settle()

    expect(optionLabels(harness)).toContain('New Name')
    expect(optionLabels(harness)).not.toContain('Stale Name')
    expect(harness.el('#llm-refresh-models').disabled).toBe(false)
  })

  it('ignores an older status response after a save', async () => {
    const backend = createBackend()
    const status = deferred<AiStatus>()
    backend.aiStatus.mockReturnValueOnce(status.promise)
    const { input, el, controller } = createHarness(backend)
    controller.activate()
    input.value = 'key'
    el('#llm-save-key').dispatch('click')
    await settle()
    expect(el('#llm-key-status').textContent).toBe('Key saved')

    status.resolve({ configured: false, provider })
    await settle()

    expect(el('#llm-key-status').textContent).toBe('Key saved')
    expect(el('#llm-model-select').disabled).toBe(false)
  })

  it('ignores a model list that arrives after the key was removed', async () => {
    const backend = configuredBackend()
    const list = deferred<AiModelList>()
    backend.aiListModels.mockReturnValueOnce(list.promise)
    const harness = await activated(backend)
    harness.el('#llm-clear-key').dispatch('click')
    harness.el('#clear-llm-key-form').dispatch('submit')
    await settle()

    list.resolve(modelList)
    await settle()

    expect(optionLabels(harness)).toEqual(['Default (newest Haiku)'])
    expect(harness.el('#llm-model-notes').text()).toContain('Add a key to load models.')
  })

  it('ignores an older usage response', async () => {
    const backend = createBackend()
    const older = deferred<AiUsageSummary>()
    const totals = { ...emptyTotals, requests: 7 }
    backend.aiUsage.mockReturnValueOnce(older.promise)
    backend.aiUsage.mockResolvedValueOnce(usageOf(totals))
    const { el, controller } = createHarness(backend)
    controller.activate()
    controller.activate()
    await settle()
    expect(el('#llm-usage-body').text()).toContain('7 requests')

    older.resolve(emptyUsage)
    await settle()

    expect(el('#llm-usage-body').text()).toContain('7 requests')
    expect(el('#llm-usage-body').text()).not.toContain('No usage yet.')
  })

  it('applies nothing after disposal', async () => {
    const backend = configuredBackend()
    const status = deferred<AiStatus>()
    backend.aiStatus.mockReturnValueOnce(status.promise)
    const { el, controller, input } = createHarness(backend)
    controller.activate()
    controller.dispose()
    status.resolve({ configured: true, provider })
    await settle()

    expect(el('#llm-key-status').textContent).not.toBe('Key saved')
    expect(backend.aiListModels).not.toHaveBeenCalled()
    expect(input.listeners.get('keydown')?.size).toBe(0)
  })

  it('keeps typed key text through overlay renders and async results', async () => {
    const root = installRoot()
    const backend = configuredBackend()
    const list = deferred<AiModelList>()
    const usage = deferred<AiUsageSummary>()
    backend.aiListModels.mockReturnValueOnce(list.promise)
    backend.aiUsage.mockReturnValueOnce(usage.promise)
    const overlay = new OverlayController({
      root: root as unknown as HTMLElement,
      macPlatform: false,
      llmSettings: new LlmSettingsController({ root: root as unknown as HTMLElement, backend }),
    })
    overlay.openSettingsDialog('llm')
    const input = root.querySelector('#llm-api-key')
    input.value = 'half-typed'

    overlay.render()
    await settle()
    list.resolve(modelList)
    usage.resolve(emptyUsage)
    await settle()
    overlay.render()

    expect(root.querySelector('#llm-api-key')).toBe(input)
    expect(input.value).toBe('half-typed')
    expect(backend.aiStatus).toHaveBeenCalledOnce()
    expect(backend.aiListModels).toHaveBeenCalledOnce()
    expect(backend.aiUsage).toHaveBeenCalledOnce()
  })
})

describe('LLM key visibility', () => {
  const inputType = (harness: Harness): unknown => (harness.input as unknown as { type?: string }).type
  const toggleIcon = (harness: Harness): unknown =>
    (harness.el('#llm-toggle-key').children[0] as unknown as { dataset: { icon: string } }).dataset.icon

  it('toggles the typed key between masked and plain text', async () => {
    const harness = await activated()
    const toggle = harness.el('#llm-toggle-key')
    expect(inputType(harness)).toBe('password')
    expect(toggleIcon(harness)).toBe('eye')

    harness.input.value = 'typed-key'
    toggle.dispatch('click')

    expect(inputType(harness)).toBe('text')
    expect(harness.input.value).toBe('typed-key')
    expect(toggle.attributes.get('aria-label')).toBe('Hide API key')
    expect(toggle.attributes.get('aria-pressed')).toBe('true')
    expect(toggleIcon(harness)).toBe('eyeOff')

    toggle.dispatch('click')

    expect(inputType(harness)).toBe('password')
    expect(toggle.attributes.get('aria-label')).toBe('Show API key')
    expect(toggle.attributes.get('aria-pressed')).toBe('false')
  })

  it('masks again after a successful save', async () => {
    const harness = await activated()
    harness.el('#llm-toggle-key').dispatch('click')
    harness.input.value = 'typed-key'

    harness.el('#llm-save-key').dispatch('click')
    await settle()

    expect(harness.input.value).toBe('')
    expect(inputType(harness)).toBe('password')
  })

  it('stays revealed after a failed save so the key can be corrected', async () => {
    const backend = createBackend()
    backend.aiSaveKey.mockRejectedValueOnce(new Error('The API key was rejected.'))
    const harness = await activated(backend)
    harness.el('#llm-toggle-key').dispatch('click')
    harness.input.value = 'typed-key'

    harness.el('#llm-save-key').dispatch('click')
    await settle()

    expect(harness.input.value).toBe('typed-key')
    expect(inputType(harness)).toBe('text')
  })

  it('masks again when the dialog closes', async () => {
    const harness = await activated()
    harness.el('#llm-toggle-key').dispatch('click')

    harness.controller.dialogClosed()

    expect(inputType(harness)).toBe('password')
  })
})

describe('LLM model selection', () => {
  it('needs a key before it requests or enables anything', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_MODEL_STORAGE_KEY, 'model-opus')
    const harness = await activated(createBackend(), storage)

    expect(harness.backend.aiListModels).not.toHaveBeenCalled()
    expect(harness.el('#llm-model-select').disabled).toBe(true)
    expect(harness.el('#llm-refresh-models').disabled).toBe(true)
    expect(harness.el('#llm-model-notes').text()).toBe('Add a key to load models.')
    expect(harness.el('#llm-model-select').value).toBe('model-opus')

    harness.el('#llm-refresh-models').dispatch('click')
    await settle()
    expect(harness.backend.aiListModels).not.toHaveBeenCalled()
  })

  it('offers the listed models and shows what the default resolves to', async () => {
    const harness = await activated(configuredBackend())

    expect(optionLabels(harness)).toEqual([
      'Default (newest Haiku): Haiku Name',
      'Opus Name',
      'Haiku Name',
      'Old Name (deprecated)',
    ])
    expect(harness.el('#llm-model-select').value).toBe('')
    expect(harness.el('#llm-model-select').disabled).toBe(false)
    expect(harness.el('#llm-model-notes').text()).toBe('')
    expect(harness.backend.aiListModels).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('offers an older version of a line only while it is the pin', async () => {
    const backend = configuredBackend()
    backend.aiListModels.mockResolvedValue({
      ...modelList,
      models: [
        ...modelList.models,
        { id: 'model-older', displayName: 'Older Name', deprecated: false, superseded: true, pricing: null },
      ],
    })
    const storage = new MemoryStorage()
    const harness = await activated(backend, storage)
    const select = harness.el('#llm-model-select')
    expect(optionLabels(harness)).not.toContain('Older Name')

    storage.setItem(LLM_MODEL_STORAGE_KEY, 'model-older')
    select.value = 'model-older'
    select.dispatch('change')

    expect(optionLabels(harness)).toContain('Older Name')
    expect(select.value).toBe('model-older')
    expect(harness.el('#llm-model-notes').text()).toBe('')

    select.value = 'model-opus'
    select.dispatch('change')

    expect(optionLabels(harness)).not.toContain('Older Name')
  })

  it('persists a pin and returns to the default by removing it', async () => {
    const storage = new MemoryStorage()
    const harness = await activated(configuredBackend(), storage)
    const select = harness.el('#llm-model-select')

    select.value = 'model-opus'
    select.dispatch('change')
    expect(storage.getItem(LLM_MODEL_STORAGE_KEY)).toBe('model-opus')
    expect(readSelectedLlmModel(storage as unknown as Storage)).toBe('model-opus')
    expect(harness.el('#llm-model-notes').text()).toBe('')

    select.value = ''
    select.dispatch('change')
    expect(storage.getItem(LLM_MODEL_STORAGE_KEY)).toBeNull()
    expect(readSelectedLlmModel(storage as unknown as Storage)).toBeNull()
    expect(harness.el('#llm-model-notes').text()).toBe('')
  })

  it('keeps a pin that left the list visible with a note', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_MODEL_STORAGE_KEY, 'model-gone')
    const harness = await activated(configuredBackend(), storage)

    expect(optionLabels(harness)).toContain('model-gone (no longer listed)')
    expect(harness.el('#llm-model-select').value).toBe('model-gone')
    expect(harness.el('#llm-model-notes').text()).toContain('model-gone is no longer in the model list.')
    expect(storage.getItem(LLM_MODEL_STORAGE_KEY)).toBe('model-gone')
  })

  it('does not call a pin unlisted while the list is empty', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LLM_MODEL_STORAGE_KEY, 'model-opus')
    const backend = configuredBackend()
    backend.aiListModels.mockResolvedValue({
      models: [],
      defaultModelId: null,
      fetchedAt: null,
      error: 'provider unavailable',
    })
    const harness = await activated(backend, storage)

    expect(optionLabels(harness)).toEqual(['Default (newest Haiku)', 'model-opus'])
    expect(harness.el('#llm-model-select').value).toBe('model-opus')
    expect(harness.el('#llm-model-notes').text()).toBe('Could not load the model list: provider unavailable')
    expect(harness.el('#llm-refresh-models').textContent).toBe('Retry')
  })

  it('shows a cached-list message with a retry when the refresh failed', async () => {
    const backend = configuredBackend()
    backend.aiListModels.mockResolvedValueOnce({ ...modelList, error: 'HTTP 503.' })
    const harness = await activated(backend)

    expect(optionLabels(harness)).toContain('Opus Name')
    expect(harness.el('#llm-model-notes').text())
      .toBe('Could not refresh the model list: HTTP 503. Showing the cached list.')
    expect(harness.el('#llm-refresh-models').textContent).toBe('Retry')

    harness.el('#llm-refresh-models').dispatch('click')
    expect(harness.el('#llm-refresh-models').disabled).toBe(true)
    expect(harness.el('#llm-refresh-models').textContent).toBe('Refreshing…')
    await settle()

    expect(backend.aiListModels).toHaveBeenLastCalledWith(true)
    expect(harness.el('#llm-model-notes').text()).not.toContain('Could not refresh')
    expect(harness.el('#llm-refresh-models').textContent).toBe('Refresh')
  })

  it('keeps the last list when a request rejects', async () => {
    const backend = configuredBackend()
    const harness = await activated(backend)
    backend.aiListModels.mockRejectedValueOnce(new Error('bridge failure'))
    harness.el('#llm-refresh-models').dispatch('click')
    await settle()

    expect(optionLabels(harness)).toContain('Opus Name')
    expect(harness.el('#llm-model-notes').text()).toContain('Could not load the model list: bridge failure')
  })

  it('asks for a choice when no default exists', async () => {
    const backend = configuredBackend()
    backend.aiListModels.mockResolvedValue({ ...modelList, defaultModelId: null })
    const harness = await activated(backend)

    expect(optionLabels(harness)[0]).toBe('Default (newest Haiku)')
    expect(harness.el('#llm-model-notes').text()).toBe('No Haiku model is available. Choose a model to generate tests.')
  })

  it('does not rebuild unchanged options, which would close an open dropdown', async () => {
    const backend = configuredBackend()
    const harness = await activated(backend)
    const select = harness.el('#llm-model-select')
    const first = select.children[0]

    harness.el('#llm-refresh-models').dispatch('click')
    await settle()

    expect(select.children[0]).toBe(first)
  })

  it('renders provider text and model names only as text', async () => {
    const backend = configuredBackend()
    const hostile = '<img src=x onerror=alert(1)>'
    backend.aiListModels.mockResolvedValue({
      ...modelList,
      models: [{ id: 'x', displayName: hostile, deprecated: false, superseded: false, pricing: null }],
      error: hostile,
    })
    const harness = await activated(backend)

    expect(optionLabels(harness)).toContain(hostile)
    for (const element of harness.root.elements.values()) {
      expect(element.innerHTML).toBe('')
    }
  })
})

describe('LLM usage refresh after a generation', () => {
  function overlayWithPanel(backend = createBackend()) {
    const root = installRoot()
    const llmSettings = new LlmSettingsController({ root: root as unknown as HTMLElement, backend })
    const overlay = new OverlayController({
      root: root as unknown as HTMLElement,
      macPlatform: false,
      llmSettings,
    })
    return { root, backend, llmSettings, overlay }
  }

  it('reloads usage while the LLM tab is visible and leaves the rest alone', async () => {
    const backend = configuredBackend()
    const { root, llmSettings, overlay } = overlayWithPanel(backend)
    overlay.openSettingsDialog('llm')
    await settle()
    expect(backend.aiUsage).toHaveBeenCalledOnce()
    const totals = { ...emptyTotals, requests: 3 }
    backend.aiUsage.mockResolvedValueOnce(usageOf(totals))

    llmSettings.refreshUsageIfVisible()
    await settle()

    expect(backend.aiUsage).toHaveBeenCalledTimes(2)
    expect(root.querySelector('#llm-usage-body').text()).toContain('3 requests')
    expect(backend.aiStatus).toHaveBeenCalledOnce()
    expect(backend.aiListModels).toHaveBeenCalledOnce()
  })

  it('does nothing while the dialog is closed or shows another tab', async () => {
    const { backend, llmSettings, overlay } = overlayWithPanel()
    overlay.openSettingsDialog('llm')
    await settle()
    backend.aiUsage.mockClear()

    overlay.setSettingsSection('keymap')
    llmSettings.refreshUsageIfVisible()
    overlay.setSettingsSection('llm')
    overlay.closeSettingsDialog()
    backend.aiUsage.mockClear()
    llmSettings.refreshUsageIfVisible()
    await settle()

    expect(backend.aiUsage).not.toHaveBeenCalled()
  })

  it('does nothing after disposal', async () => {
    const { backend, llmSettings, overlay } = overlayWithPanel()
    overlay.openSettingsDialog('llm')
    await settle()
    backend.aiUsage.mockClear()

    llmSettings.dispose()
    llmSettings.refreshUsageIfVisible()

    expect(backend.aiUsage).not.toHaveBeenCalled()
  })

  it('supersedes a usage request still in flight, which predates the new record', async () => {
    const backend = createBackend()
    const older = deferred<AiUsageSummary>()
    const totals = { ...emptyTotals, requests: 7 }
    backend.aiUsage.mockReturnValueOnce(older.promise)
    backend.aiUsage.mockResolvedValueOnce(usageOf(totals))
    const { root, llmSettings, overlay } = overlayWithPanel(backend)
    overlay.openSettingsDialog('llm')

    llmSettings.refreshUsageIfVisible()
    await settle()
    older.resolve(emptyUsage)
    await settle()

    expect(root.querySelector('#llm-usage-body').text()).toContain('7 requests')
    expect(root.querySelector('#llm-usage-body').text()).not.toContain('No usage yet.')
  })
})

describe('LLM usage buckets', () => {
  const local = (...parts: [number, number, number]): number => new Date(...parts).getTime()

  it('covers 14 days ending today, across a month boundary', () => {
    const starts = llmUsageBucketStarts('day', new Date(2026, 2, 3, 15, 30))
    expect(starts).toHaveLength(14)
    expect(starts[0]).toBe(local(2026, 1, 18))
    expect(starts[10]).toBe(local(2026, 1, 28))
    expect(starts[11]).toBe(local(2026, 2, 1))
    expect(starts[13]).toBe(local(2026, 2, 3))
  })

  it.each([
    ['a Monday', new Date(2026, 10, 2, 0, 0)],
    ['a Wednesday', new Date(2026, 10, 4, 12, 0)],
    ['a Sunday', new Date(2026, 10, 8, 23, 59)],
  ])('starts weeks on Monday, seen from %s', (_name, now) => {
    const starts = llmUsageBucketStarts('week', now)
    expect(starts).toHaveLength(8)
    expect(starts[7]).toBe(local(2026, 10, 2))
    expect(starts[6]).toBe(local(2026, 9, 26))
    expect(starts[0]).toBe(local(2026, 8, 14))
    expect(starts.every((start) => new Date(start).getDay() === 1)).toBe(true)
  })

  it('always starts at local midnight and ascends', () => {
    for (const period of ['day', 'week'] as const) {
      const starts = llmUsageBucketStarts(period, new Date(2026, 2, 29, 18, 45))
      expect(starts.every((start) => new Date(start).getHours() === 0)).toBe(true)
      expect(starts).toEqual([...starts].sort((left, right) => left - right))
    }
  })
})

describe('LLM usage', () => {
  const NOW = new Date(2026, 9, 28, 15, 30)
  const today = new Date(2026, 9, 28).getTime()
  const yesterday = new Date(2026, 9, 27).getTime()
  const totals = (values: Partial<AiUsageTotals>): AiUsageTotals => ({ ...emptyTotals, ...values })
  const haiku = totals({ requests: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.5 })
  const opus = totals({ requests: 2, inputTokens: 5663, outputTokens: 224, costUsd: 1.5 })

  /** Yesterday used one model, today two, and earlier days nothing. */
  function dayUsage(starts: number[]): AiUsageSummary {
    return {
      buckets: starts.map((startMs) => {
        if (startMs === today) {
          return {
            startMs,
            totals: totals({ requests: 3, inputTokens: 5763, outputTokens: 234, costUsd: 2 }),
            perModel: [{ model: 'model-haiku', totals: haiku }, { model: 'model-opus', totals: opus }],
          }
        }
        if (startMs === yesterday) {
          return {
            startMs,
            totals: totals({ requests: 1, inputTokens: 40, outputTokens: 4, costUsd: 1 }),
            perModel: [{ model: 'model-unlisted', totals: totals({ requests: 1, costUsd: 1 }) }],
          }
        }
        return { startMs, totals: emptyTotals, perModel: [] }
      }),
      allTime: totals({ requests: 9, costUsd: 12.5, unpricedRequests: 1 }),
      skippedLines: 0,
    }
  }

  async function withDayUsage(backend = createBackend()): Promise<Harness> {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    backend.aiUsage.mockImplementation(async (starts) => dayUsage(starts))
    return activated(backend)
  }

  function part(harness: Harness, className: string): FakeElement {
    const match = harness.el('#llm-usage-body').children.find((child) => child.className === className)
    if (!match) {
      throw new Error(`Missing usage part: ${className}`)
    }
    return match
  }

  const bars = (harness: Harness): FakeElement[] => part(harness, 'llm-usage-chart').children
  const pressed = (bar: FakeElement): string | undefined => bar.attributes.get('aria-pressed')
  const modelRows = (harness: Harness): string[] =>
    part(harness, 'llm-usage-models').children.map((row) => row.text())

  async function usageText(summary: AiUsageSummary): Promise<string> {
    const backend = createBackend()
    backend.aiUsage.mockResolvedValue(summary)
    const { el } = await activated(backend)
    return el('#llm-usage-body').text()
  }

  it('asks for the day buckets first, even without a key', async () => {
    const { backend } = await withDayUsage()
    expect(backend.aiUsage).toHaveBeenCalledExactlyOnceWith(llmUsageBucketStarts('day', NOW))
  })

  it('shows only an empty state when nothing was ever recorded', async () => {
    const harness = await activated()
    expect(harness.el('#llm-usage-body').text()).toBe('No usage yet.')
    expect(harness.el('#llm-usage-controls').hidden).toBe(true)
  })

  it('shows skipped records even in the empty state', async () => {
    expect(await usageText({ ...emptyUsage, skippedLines: 1 }))
      .toBe('No usage yet. 1 usage record could not be read and is not counted.')
  })

  it('leads with the newest bucket and the all-time total beside the tabs', async () => {
    const harness = await withDayUsage()
    const headline = part(harness, 'llm-usage-headline').children.map((child) => child.textContent)

    expect(headline).toEqual(['Today', '$2.00', '3 requests · 5,763 in · 234 out'])
    expect(harness.el('#llm-usage-controls').hidden).toBe(false)
    expect(harness.el('#llm-usage-all-time').textContent).toBe('All time $12.50 + 1 unpriced')
    expect(harness.el('#llm-usage-body').text()).not.toContain('could not be read')
  })

  it('adds cache and refused counts only when they are not zero', async () => {
    const text = await usageText(usageOf(totals({
      requests: 2,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      refusedRequests: 1,
    })))
    expect(text).toContain('2 requests · 1 in · 1 out · 30 cache · 1 refused')
    expect(await usageText(usageOf(totals({ requests: 1 })))).toContain('1 request · 0 in · 0 out')
    expect(await usageText(usageOf(totals({ requests: 1 })))).not.toMatch(/cache|refused/)
  })

  it('shows price gaps only where they apply', async () => {
    expect(await usageText(usageOf(totals({ requests: 2, unpricedRequests: 2 })))).toContain('Price unknown')
    expect(await usageText(usageOf(totals({ requests: 2, unpricedRequests: 1, costUsd: 0.0158 }))))
      .toContain('$0.0158 + 1 unpriced')
    expect(await usageText(usageOf(totals({ requests: 2, costUsd: 0.5 })))).not.toMatch(/unknown|unpriced/)
  })

  it('never describes amounts as estimates', async () => {
    const harness = await withDayUsage()
    const wording = /estimat|approximate|list price|undercount/i
    expect(harness.root.dumpAll()).not.toMatch(wording)
    const backend = createBackend()
    backend.aiUsage.mockResolvedValue(usageOf(totals({ requests: 4, approximateRequests: 4, costUsd: 1 })))
    expect((await activated(backend)).root.dumpAll()).not.toMatch(wording)
  })

  it('draws one labelled button per bucket, scaled to the largest cost', async () => {
    const harness = await withDayUsage()
    const all = bars(harness)

    expect(all).toHaveLength(14)
    expect(all.every((bar) => bar.tagName === 'button')).toBe(true)
    expect(all.map(pressed).filter((value) => value === 'true')).toHaveLength(1)
    expect(pressed(all[13])).toBe('true')
    expect(all[13].attributes.get('aria-label')).toBe('Today: $2.00, 3 requests')
    expect(all[13].title).toBe('Today: $2.00, 3 requests')
    expect(all[12].attributes.get('aria-label')).toBe('Oct 27: $1.00, 1 request')
    expect(all[13].children[0].style.height).toBe('100%')
    expect(all[12].children[0].style.height).toBe('50%')
    expect(all[0].attributes.get('aria-label')).toBe('Oct 15: $0.00, 0 requests')
    expect(all[0].children[0].className).toContain('is-empty')
    expect(all[0].children[0].style.height).toBeUndefined()
  })

  it('keeps a priced-out bucket visible with the minimum bar height', async () => {
    const backend = createBackend()
    backend.aiUsage.mockResolvedValue(usageOf(totals({ requests: 1, unpricedRequests: 1 })))
    const harness = await activated(backend)
    expect(bars(harness)[0].children[0].style.height).toBe('6%')
  })

  it('labels only the first and last bucket on the axis', async () => {
    const harness = await withDayUsage()
    expect(part(harness, 'llm-usage-axis').children.map((label) => label.textContent)).toEqual(['Oct 15', 'Today'])
  })

  it('selects a bucket from its bar, and the headline and models follow', async () => {
    const harness = await withDayUsage()
    bars(harness)[12].dispatch('click')

    expect(pressed(bars(harness)[12])).toBe('true')
    expect(pressed(bars(harness)[13])).toBe('false')
    expect(part(harness, 'llm-usage-headline').children[0].textContent).toBe('Oct 27')
    expect(part(harness, 'llm-usage-headline').children[1].textContent).toBe('$1.00')
    expect(modelRows(harness)).toEqual(['model-unlisted 1 request $1.00'])
    expect(harness.backend.aiUsage).toHaveBeenCalledOnce()
  })

  it('keeps keyboard focus on the bar when selecting replaces it', async () => {
    const harness = await withDayUsage()
    const { ownerDocument } = harness.root
    bars(harness)[12].focus()
    bars(harness)[12].dispatch('click')

    expect(ownerDocument.activeElement).toBe(bars(harness)[12])
  })

  it('leaves focus alone when it is outside the usage body', async () => {
    const harness = await withDayUsage()
    harness.input.focus()
    bars(harness)[12].dispatch('click')
    expect(harness.root.ownerDocument.activeElement).toBe(harness.input)
  })

  it('lists models by cost with a share bar, using names once the list arrives', async () => {
    const backend = configuredBackend()
    const list = deferred<AiModelList>()
    backend.aiListModels.mockReturnValueOnce(list.promise)
    const harness = await withDayUsage(backend)
    expect(modelRows(harness)).toEqual(['model-opus 2 requests $1.50', 'model-haiku 1 request $0.5000'])

    list.resolve(modelList)
    await settle()

    expect(modelRows(harness)).toEqual(['Opus Name 2 requests $1.50', 'Haiku Name 1 request $0.5000'])
    const shares = part(harness, 'llm-usage-models').children
      .map((row) => row.children[1].children[0].style.width)
    expect(shares).toEqual(['75%', '25%'])

    bars(harness)[12].dispatch('click')
    expect(modelRows(harness)).toEqual(['model-unlisted 1 request $1.00'])
  })

  it('shares by requests when a bucket has no cost at all', async () => {
    const backend = createBackend()
    const unpriced = (requests: number) => totals({ requests, unpricedRequests: requests })
    backend.aiUsage.mockResolvedValue({
      ...usageOf(unpriced(4)),
      buckets: [{
        startMs: 0,
        totals: unpriced(4),
        perModel: [{ model: 'a', totals: unpriced(1) }, { model: 'b', totals: unpriced(3) }],
      }],
    })
    const harness = await activated(backend)
    const rows = part(harness, 'llm-usage-models').children

    expect(rows.map((row) => row.children[0].textContent)).toEqual(['b', 'a'])
    expect(rows.map((row) => row.children[1].children[0].style.width)).toEqual(['75%', '25%'])
  })

  it('shows an unused bucket with no model rows', async () => {
    const harness = await withDayUsage()
    bars(harness)[0].dispatch('click')
    expect(part(harness, 'llm-usage-headline').text()).toBe('Oct 15 $0.00 No requests')
    expect(modelRows(harness)).toEqual([])
  })

  describe('period tabs', () => {
    const summaryFor = (starts: number[]): AiUsageSummary => ({
      ...emptyUsage,
      buckets: starts.map((startMs) => ({ startMs, totals: totals({ requests: 1, costUsd: 1 }), perModel: [] })),
      allTime: totals({ requests: starts.length }),
    })

    function tabState(harness: Harness): Array<[string | undefined, number, boolean]> {
      return ['day', 'week'].map((period) => {
        const tab = harness.el(`#llm-usage-${period}-tab`)
        return [tab.attributes.get('aria-selected'), tab.tabIndex, tab.classes.has('is-active')]
      })
    }

    async function periodHarness(): Promise<Harness> {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      const backend = createBackend()
      backend.aiUsage.mockImplementation(async (starts) => summaryFor(starts))
      return activated(backend)
    }

    it('starts on Day', async () => {
      const harness = await periodHarness()
      expect(tabState(harness)).toEqual([['true', 0, true], ['false', -1, false]])
      expect(harness.el('#llm-usage-body').attributes.get('aria-labelledby')).toBe('llm-usage-day-tab')
    })

    it('requests the new buckets and selects the newest', async () => {
      const harness = await periodHarness()
      bars(harness)[3].dispatch('click')
      harness.el('#llm-usage-week-tab').dispatch('click')
      await settle()

      expect(harness.backend.aiUsage).toHaveBeenLastCalledWith(llmUsageBucketStarts('week', NOW))
      expect(tabState(harness)[1]).toEqual(['true', 0, true])
      expect(bars(harness)).toHaveLength(8)
      expect(pressed(bars(harness)[7])).toBe('true')
      expect(part(harness, 'llm-usage-headline').children[0].textContent).toBe('This week')
      expect(bars(harness)[6].attributes.get('aria-label')).toBe('Week of Oct 19: $1.00, 1 request')
      expect(harness.el('#llm-usage-body').attributes.get('aria-labelledby')).toBe('llm-usage-week-tab')
    })

    it('keeps the previous data and selection up until the response arrives', async () => {
      const harness = await periodHarness()
      bars(harness)[3].dispatch('click')
      const before = harness.el('#llm-usage-body').text()
      const pending = deferred<AiUsageSummary>()
      harness.backend.aiUsage.mockReturnValueOnce(pending.promise)

      harness.el('#llm-usage-week-tab').dispatch('click')

      expect(tabState(harness)[1]).toEqual(['true', 0, true])
      expect(harness.el('#llm-usage-body').text()).toBe(before)
      expect(harness.el('#llm-usage-body').text()).not.toMatch(/loading/i)
      expect(pressed(bars(harness)[3])).toBe('true')

      pending.resolve(summaryFor(llmUsageBucketStarts('week', NOW)))
      await settle()
      expect(bars(harness)).toHaveLength(8)
    })

    it('ignores the response of a tab left behind', async () => {
      const harness = await periodHarness()
      const pending = deferred<AiUsageSummary>()
      harness.backend.aiUsage.mockReturnValueOnce(pending.promise)
      harness.el('#llm-usage-week-tab').dispatch('click')
      harness.el('#llm-usage-day-tab').dispatch('click')
      await settle()

      pending.resolve(summaryFor(llmUsageBucketStarts('week', NOW)))
      await settle()

      expect(bars(harness)).toHaveLength(14)
    })

    it('does not refetch the tab already showing', async () => {
      const harness = await periodHarness()
      harness.el('#llm-usage-day-tab').dispatch('click')
      expect(harness.backend.aiUsage).toHaveBeenCalledOnce()
    })

    it('moves between tabs with the arrow, Home, and End keys', async () => {
      const harness = await periodHarness()
      const key = (period: string, name: string) => harness.el(`#llm-usage-${period}-tab`).dispatch('keydown', { key: name })

      expect(key('day', 'ArrowRight').preventDefault).toHaveBeenCalled()
      expect(harness.root.ownerDocument.activeElement).toBe(harness.el('#llm-usage-week-tab'))
      expect(tabState(harness)[1][0]).toBe('true')
      key('week', 'ArrowRight')
      expect(tabState(harness)[0][0]).toBe('true')
      key('day', 'ArrowLeft')
      expect(tabState(harness)[1][0]).toBe('true')
      key('week', 'Home')
      expect(tabState(harness)[0][0]).toBe('true')
      key('day', 'End')
      expect(tabState(harness)[1][0]).toBe('true')
      key('week', 'Home')
      expect(harness.root.ownerDocument.activeElement).toBe(harness.el('#llm-usage-day-tab'))
      expect(tabState(harness)[0][0]).toBe('true')

      expect(key('day', 'a').preventDefault).not.toHaveBeenCalled()
    })

    it('keeps the tab and the selected bucket through a refresh', async () => {
      const root = installRoot()
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      const backend = createBackend()
      backend.aiUsage.mockImplementation(async (starts) => summaryFor(starts))
      const llmSettings = new LlmSettingsController({ root: root as unknown as HTMLElement, backend })
      const harness = { el: (selector: string) => root.querySelector(selector) } as unknown as Harness
      llmSettings.activate()
      await settle()
      harness.el('#llm-usage-week-tab').dispatch('click')
      await settle()
      bars(harness)[2].dispatch('click')

      llmSettings.refreshUsageIfVisible()
      await settle()

      expect(backend.aiUsage).toHaveBeenLastCalledWith(llmUsageBucketStarts('week', NOW))
      expect(tabState(harness)[1][0]).toBe('true')
      expect(pressed(bars(harness)[2])).toBe('true')
    })
  })

  it('reports a failed request and keeps earlier totals on the next failure', async () => {
    const backend = createBackend()
    backend.aiUsage.mockRejectedValueOnce(new Error('ledger locked'))
    const { el, controller } = await activated(backend)
    expect(el('#llm-usage-body').text()).toBe('Could not load usage: ledger locked')

    backend.aiUsage.mockResolvedValueOnce(usageOf(totals({ requests: 5 })))
    controller.activate()
    await settle()
    expect(el('#llm-usage-body').text()).not.toContain('Could not load usage')

    backend.aiUsage.mockRejectedValueOnce(new Error('ledger locked'))
    controller.activate()
    await settle()

    expect(el('#llm-usage-body').text()).toContain('Could not load usage: ledger locked')
    expect(el('#llm-usage-body').text()).toContain('5 requests')
  })

  it('warns about skipped records beside the data', async () => {
    expect(await usageText({ ...usageOf(totals({ requests: 1 })), skippedLines: 2 }))
      .toContain('2 usage records could not be read and are not counted.')
  })

  it('tolerates all-time usage with no buckets', async () => {
    const backend = createBackend()
    backend.aiUsage.mockResolvedValue({ ...emptyUsage, allTime: totals({ requests: 1, costUsd: 1 }) })
    const harness = await activated(backend)
    expect(harness.el('#llm-usage-body').text()).toBe('')
    expect(harness.el('#llm-usage-all-time').textContent).toBe('All time $1.00')
  })
})

describe('LLM key storage note', () => {
  it('is shown only while the key field is', async () => {
    const harness = await activated(configuredBackend())
    expect(harness.el('#llm-key-entry').hidden).toBe(true)
    expect(harness.el('#llm-key-note').hidden).toBe(true)

    harness.el('#llm-replace-key').dispatch('click')
    expect(harness.el('#llm-key-entry').hidden).toBe(false)
    expect(harness.el('#llm-key-note').hidden).toBe(false)

    harness.el('#llm-cancel-replace-key').dispatch('click')
    expect(harness.el('#llm-key-note').hidden).toBe(true)
  })

  it('is shown when no key is saved', async () => {
    const harness = await activated()
    expect(harness.el('#llm-key-note').hidden).toBe(false)
  })
})

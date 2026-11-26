import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/icons', () => ({
  iconFor: (_name: string, className?: string) => {
    const icon = (globalThis.document as unknown as FakeDocument).createElement('svg')
    icon.className = className ?? ''
    return icon
  },
}))

vi.mock('../../../src/sanitize', () => ({
  sanitizeProblemHtml: vi.fn(() => (globalThis.document as unknown as FakeDocument).createElement('div')),
}))

import {
  createDailyProblemView,
  type DailyProblemViewModel,
} from '../../../src/app/daily-view'
import type { DailyProblem, ProblemFileEntry } from '../../../src/backend'
import { sanitizeProblemHtml } from '../../../src/sanitize'

class FakeClassList {
  private readonly values = new Set<string>()

  add(...names: string[]): void {
    names.forEach((name) => this.values.add(name))
  }

  remove(...names: string[]): void {
    names.forEach((name) => this.values.delete(name))
  }

  contains(name: string): boolean {
    return this.values.has(name)
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name)
    if (next) this.values.add(name)
    else this.values.delete(name)
    return next
  }

  replace(value: string): void {
    this.values.clear()
    value.split(/\s+/).filter(Boolean).forEach((name) => this.values.add(name))
  }
}

type FakeChild = FakeElement | FakeText

class FakeText {
  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly children: FakeChild[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly classList = new FakeClassList()
  readonly style: Record<string, string> = {}
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  parentElement: FakeElement | null = null
  private rawClassName = ''
  hidden = false
  disabled = false
  type = ''
  value = ''
  title = ''
  href = ''
  target = ''
  rel = ''
  inputMode = ''
  pattern = ''
  placeholder = ''
  autocomplete = ''
  spellcheck = false
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
  focusCount = 0

  get className(): string {
    return this.rawClassName
  }

  set className(value: string) {
    this.rawClassName = value
    this.classList.replace(value)
  }

  set innerHTML(value: string) {
    if (value !== '') throw new Error('The fake DOM only supports clearing innerHTML')
    this.children.splice(0).forEach((child) => {
      if (child instanceof FakeElement) child.parentElement = null
    })
  }

  append(...nodes: FakeChild[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this
      this.children.push(node)
    }
  }

  set textContent(value: string) {
    this.children.splice(0).forEach((child) => {
      if (child instanceof FakeElement) child.parentElement = null
    })
    if (value) this.children.push(new FakeText(value))
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join('')
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  focus(): void {
    this.focusCount += 1
    ;(globalThis.document as unknown as FakeDocument).activeElement = this
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  select(): void {
    this.selectionStart = 0
    this.selectionEnd = this.value.length
  }

  contains(target: FakeElement | null): boolean {
    if (!target) return false
    if (target === this) return true
    return this.children.some((child) => child instanceof FakeElement && child.contains(target))
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const result: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue
        if (child.matches(selector)) result.push(child)
        visit(child)
      }
    }
    visit(this)
    return result as T[]
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    return false
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null

  createElement(_tagName: string): FakeElement {
    return new FakeElement()
  }

  createTextNode(value: string): FakeText {
    return new FakeText(value)
  }
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>()

function installFakeDocument(): void {
  const document = new FakeDocument()
  for (const [key, value] of Object.entries({
    document,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLButtonElement: FakeElement,
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
}

function restoreGlobals(): void {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  originalGlobals.clear()
}

const problem: DailyProblem = {
  date: '2026-09-12',
  frontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  difficulty: 'Easy',
  url: 'https://leetcode.com/problems/two-sum/',
  javaSnippet: 'class Q1TwoSum {}',
  content: null,
}

const file: ProblemFileEntry = {
  path: 'src/main/java/easy/Q1TwoSum.java',
  name: 'Q1TwoSum.java',
  packageSegment: 'easy',
}

function model(overrides: Partial<DailyProblemViewModel> = {}): DailyProblemViewModel {
  return {
    problem,
    existingFile: file,
    existingFileOpen: false,
    projectValid: true,
    busy: false,
    dailyLoading: false,
    dailyError: null,
    problemSelection: 'daily',
    problemUrlDraft: '',
    viewingToday: true,
    ...overrides,
  }
}

function callbacks() {
  return {
    onLookupInput: vi.fn(),
    onLookupSubmit: vi.fn(),
    onRetry: vi.fn(),
    onBackToToday: vi.fn(),
    onOpenFile: vi.fn(),
    onCreateFile: vi.fn(),
  }
}

beforeEach(() => {
  installFakeDocument()
  vi.mocked(sanitizeProblemHtml).mockClear()
})

afterEach(() => {
  restoreGlobals()
})

describe('createDailyProblemView', () => {
  it('skips unchanged header DOM while keeping the current file callback', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const callbacksRef = callbacks()
    const renderer = createDailyProblemView(
      { header, description },
      callbacksRef,
    )
    renderer(model())
    const firstChild = header.children[0]
    const firstHeaderText = header.textContent
    const replacement = { ...file }
    renderer(model({ existingFile: replacement }))

    expect(header.children[0]).toBe(firstChild)
    expect(header.textContent).toBe(firstHeaderText)
    const primary = header.querySelector('.daily-primary')
    primary?.dispatch('click')
    expect(callbacksRef.onOpenFile).toHaveBeenCalledWith(replacement)
  })

  it('shows a disabled Opened button while the problem file is already open', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const callbacksRef = callbacks()
    const renderer = createDailyProblemView(
      { header, description },
      callbacksRef,
    )
    renderer(model({ existingFileOpen: true }))

    const primary = header.querySelector('.daily-primary')!
    expect(primary.textContent).toBe('Opened')
    expect(primary.disabled).toBe(true)
    // Busy-state refreshes re-enable the button unless it carries this marker.
    expect(primary.dataset.fileOpen).toBe('true')

    renderer(model({ existingFileOpen: false }))

    const reopened = header.querySelector('.daily-primary')!
    expect(reopened.textContent).toBe('Open file')
    expect(reopened.disabled).toBe(false)
    expect(reopened.dataset.fileOpen).toBeUndefined()
    reopened.dispatch('click')
    expect(callbacksRef.onOpenFile).toHaveBeenCalledWith(file)
  })

  it('rebuilds when the lookup draft or state changes and preserves focused input selection', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const firstCallbacks = callbacks()
    const renderer = createDailyProblemView(
      { header, description },
      firstCallbacks,
    )
    renderer(model())
    const input = header.querySelector('.problem-lookup-input')!
    input.focus()
    input.value = 'leetcode.com/problems/two-sum'
    input.selectionStart = 1
    input.selectionEnd = 2

    renderer(model({ problemUrlDraft: 'leetcode.com/problems/two-sum', problemSelection: 'manual' }))

    const nextInput = header.querySelector('.problem-lookup-input')!
    expect(nextInput).not.toBe(input)
    expect(nextInput.value).toBe('leetcode.com/problems/two-sum')
    expect(nextInput.focusCount).toBe(1)
    expect(nextInput.selectionStart).toBe(1)
    expect(nextInput.selectionEnd).toBe(2)
  })

  it('shows the problem number as plain text beside a blank URL input', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const renderer = createDailyProblemView(
      { header, description },
      callbacks(),
    )
    renderer(model())

    expect(header.querySelector('.problem-number')?.textContent).toBe('#1')
    const input = header.querySelector('.problem-lookup-input')!
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Paste problem URL')
    expect(input.getAttribute('aria-label')).toBe('LeetCode problem URL')
    expect(input.inputMode).toBe('')
    expect(input.pattern).toBe('')
  })

  it('shows no number and still offers the URL input while no problem is loaded', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const renderer = createDailyProblemView(
      { header, description },
      callbacks(),
    )
    renderer(model({ problem: null, existingFile: null }))

    expect(header.querySelector('.problem-number')).toBeNull()
    expect(header.querySelector('.problem-lookup-input')).not.toBeNull()
  })

  it('submits a pasted URL exactly as it was pasted', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const callbacksRef = callbacks()
    const renderer = createDailyProblemView(
      { header, description },
      callbacksRef,
    )
    renderer(model())
    const pasted = ' https://leetcode.com/problems/minimum-moves-to-equal-array-elements-iii/description/ '
    const input = header.querySelector('.problem-lookup-input')!
    input.value = pasted
    input.dispatch('input')
    const preventDefault = vi.fn()
    header.querySelector('.problem-lookup')!.dispatch('submit', { preventDefault })

    expect(callbacksRef.onLookupInput).toHaveBeenCalledWith(pasted)
    expect(callbacksRef.onLookupSubmit).toHaveBeenCalledWith(pasted)
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('keeps dynamic input handlers attached to the latest callbacks', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const firstCallbacks = callbacks()
    const renderer = createDailyProblemView(
      { header, description },
      firstCallbacks,
    )
    renderer(model())

    const input = header.querySelector('.problem-lookup-input')!
    input.value = 'leetcode.com/problems/42'
    input.dispatch('input')
    expect(firstCallbacks.onLookupInput).toHaveBeenCalledWith('leetcode.com/problems/42')
  })

  it('renders the sanitized description into the sidebar panel once and reuses it', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const renderer = createDailyProblemView({ header, description }, callbacks())
    const content = '<p>Given an array.</p>'
    renderer(model({ problem: { ...problem, content } }))

    const body = description.children[0] as FakeElement
    expect(body.classList.contains('daily-description-body')).toBe(true)
    expect(sanitizeProblemHtml).toHaveBeenCalledTimes(1)
    // The panel's visibility belongs to the tab strip, not this renderer.
    expect(description.hidden).toBe(false)

    renderer(model({ problem: { ...problem, content }, existingFileOpen: true }))
    expect(description.children[0]).toBe(body)
    expect(sanitizeProblemHtml).toHaveBeenCalledTimes(1)

    renderer(model({ problem: null, existingFile: null, dailyLoading: true }))
    renderer(model({ problem: { ...problem, content } }))
    expect(description.children[0]).toBe(body)
    expect(sanitizeProblemHtml).toHaveBeenCalledTimes(1)
  })

  it('shows a short empty state while the description is unavailable', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const renderer = createDailyProblemView({ header, description }, callbacks())
    const emptyText = (): string => {
      const empty = description.querySelector('.daily-description-empty')
      expect(empty?.classList.contains('muted-copy')).toBe(true)
      return empty?.textContent ?? ''
    }

    renderer(model({ problem: null, existingFile: null, dailyLoading: true }))
    expect(emptyText()).toBe('Loading description…')
    renderer(model({ problem: null, existingFile: null, dailyError: 'offline' }))
    expect(emptyText()).toBe('Couldn’t load this problem')
    renderer(model({ problem: null, existingFile: null }))
    expect(emptyText()).toBe('No problem loaded')
    renderer(model({ problem: { ...problem, content: '   ' } }))
    expect(emptyText()).toBe('No description available')
    expect(description.children).toHaveLength(1)
  })

  it('places the LeetCode link beside the today status and leaves only the primary action at the end', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const renderer = createDailyProblemView({ header, description }, callbacks())
    const identityClasses = (): string[] => {
      const identity = header.querySelector('.daily-problem')!
      return identity.children.map((child) => (child as FakeElement).className)
    }

    renderer(model({ problem: { ...problem, content: '<p>Text</p>' } }))
    expect(identityClasses().slice(-2)).toEqual(['daily-today-status', 'icon-button daily-link'])
    const link = header.querySelector('.daily-link')!
    expect(link.href).toBe(problem.url)
    expect(link.getAttribute('aria-label')).toBe('Open on LeetCode')
    const actions = header.querySelector('.daily-actions')!
    expect(actions.children).toHaveLength(1)
    expect((actions.children[0] as FakeElement).classList.contains('daily-primary')).toBe(true)
    expect(header.querySelector('.daily-description-toggle')).toBeNull()

    renderer(model({ problem: { ...problem, content: '<p>Text</p>' }, viewingToday: false }))
    expect(identityClasses().slice(-2)).toEqual(['secondary-button daily-today', 'icon-button daily-link'])
  })
})

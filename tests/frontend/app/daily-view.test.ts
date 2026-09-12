import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/icons', () => ({
  iconFor: (_name: string, className?: string) => {
    const icon = (globalThis.document as unknown as FakeDocument).createElement('svg')
    icon.className = className ?? ''
    return icon
  },
}))

import {
  createDailyProblemView,
  type DailyProblemViewModel,
} from '../../../src/app/daily-view'
import type { DailyProblem, ProblemFileEntry } from '../../../src/backend'

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
  readonly classList = new FakeClassList()
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
    projectValid: true,
    busy: false,
    dailyLoading: false,
    dailyError: null,
    problemSelection: 'daily',
    problemNumberDraft: '1',
    viewingToday: true,
    dailyDescriptionOpen: false,
    ...overrides,
  }
}

function callbacks() {
  return {
    onLookupInput: vi.fn(),
    onLookupSubmit: vi.fn(),
    onRetry: vi.fn(),
    onBackToToday: vi.fn(),
    onRefresh: vi.fn(),
    onToggleDescription: vi.fn(),
    onOpenFile: vi.fn(),
    onCreateFile: vi.fn(),
    onApplyDescriptionHeight: vi.fn(),
  }
}

beforeEach(() => {
  installFakeDocument()
})

afterEach(() => {
  restoreGlobals()
})

describe('createDailyProblemView', () => {
  it('skips unchanged header DOM while keeping the current file callback', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const resizeHandle = new FakeElement()
    const callbacksRef = callbacks()
    const renderer = createDailyProblemView(
      { header, description, resizeHandle },
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

  it('rebuilds when the lookup draft or state changes and preserves focused input selection', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const resizeHandle = new FakeElement()
    const firstCallbacks = callbacks()
    const renderer = createDailyProblemView(
      { header, description, resizeHandle },
      firstCallbacks,
    )
    renderer(model())
    const input = header.querySelector('.problem-lookup-input')!
    input.focus()
    input.value = '12'
    input.selectionStart = 1
    input.selectionEnd = 2

    renderer(model({ problemNumberDraft: '12', problemSelection: 'manual' }))

    const nextInput = header.querySelector('.problem-lookup-input')!
    expect(nextInput).not.toBe(input)
    expect(nextInput.value).toBe('12')
    expect(nextInput.focusCount).toBe(1)
    expect(nextInput.selectionStart).toBe(1)
    expect(nextInput.selectionEnd).toBe(2)
  })

  it('distinguishes an empty draft from the null draft fallback value', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const resizeHandle = new FakeElement()
    const renderer = createDailyProblemView(
      { header, description, resizeHandle },
      callbacks(),
    )
    renderer(model({ problemNumberDraft: null }))
    const fallbackInput = header.querySelector('.problem-lookup-input')

    renderer(model({ problemNumberDraft: '' }))
    const emptyInput = header.querySelector('.problem-lookup-input')

    expect(emptyInput).not.toBe(fallbackInput)
    expect(emptyInput?.value).toBe('')
  })

  it('keeps dynamic input handlers attached to the latest callbacks', () => {
    const header = new FakeElement()
    const description = new FakeElement()
    const resizeHandle = new FakeElement()
    const firstCallbacks = callbacks()
    const renderer = createDailyProblemView(
      { header, description, resizeHandle },
      firstCallbacks,
    )
    renderer(model())

    const input = header.querySelector('.problem-lookup-input')!
    input.value = '42'
    input.dispatch('input')
    expect(firstCallbacks.onLookupInput).toHaveBeenCalledWith('42')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testMetrics = vi.hoisted(() => ({
  createElement: 0,
  createTextNode: 0,
  innerHTMLWrites: 0,
  listeners: 0,
}))

vi.mock('../../../src/icons', () => ({
  iconFor: (_name: string, className?: string) => {
    const icon = (globalThis.document as unknown as FakeDocument).createElement('svg')
    icon.className = className ?? ''
    return icon
  },
}))

import {
  FILE_GROUPS,
  renderFilesView,
  type FilesViewModel,
} from '../../../src/app/files-view'
import { renderFilesViewBaseline } from '../../performance/fixtures/files-view-baseline'
import type { ProblemFileEntry } from '../../../src/backend'

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
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  parentElement: FakeElement | null = null
  private rawClassName = ''
  hidden = false
  disabled = false
  title = ''
  type = ''
  value = ''
  id = ''

  get className(): string {
    return this.rawClassName
  }

  set className(value: string) {
    this.rawClassName = value
    this.classList.replace(value)
  }

  set innerHTML(value: string) {
    if (value !== '') {
      throw new Error('The benchmark fake DOM only supports clearing innerHTML')
    }
    testMetrics.innerHTMLWrites += 1
    this.children.splice(0).forEach((child) => {
      if (child instanceof FakeElement) child.parentElement = null
    })
  }

  get innerHTML(): string {
    return ''
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

  append(...nodes: FakeChild[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this
      this.children.push(node)
    }
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
    testMetrics.listeners += 1
  }

  dispatch(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  replaceWith(next: FakeElement): void {
    const parent = this.parentElement
    if (!parent) return
    const index = parent.children.indexOf(this)
    if (index >= 0) {
      parent.children[index] = next
      next.parentElement = parent
      this.parentElement = null
    }
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const result: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child instanceof FakeElement && child.matches(selector)) {
          result.push(child)
        }
        if (child instanceof FakeElement) visit(child)
      }
    }
    visit(this)
    return result as T[]
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    return false
  }
}

class FakeDocument {
  createElement(_tagName: string): FakeElement {
    testMetrics.createElement += 1
    return new FakeElement()
  }

  createTextNode(value: string): FakeText {
    testMetrics.createTextNode += 1
    return new FakeText(value)
  }
}

const originalDocument = globalThis.document

function installFakeDocument(): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: new FakeDocument(),
  })
}

function resetMetrics(): void {
  testMetrics.createElement = 0
  testMetrics.createTextNode = 0
  testMetrics.innerHTMLWrites = 0
  testMetrics.listeners = 0
}

function restoreDocument(): void {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    })
  } else {
    delete (globalThis as { document?: Document }).document
  }
}

function file(index: number, packageSegment: ProblemFileEntry['packageSegment'] = 'easy'): ProblemFileEntry {
  return {
    path: `src/main/java/${packageSegment}/Q${index}Problem.java`,
    name: `Q${index}Problem.java`,
    packageSegment,
  }
}

function model(overrides: Partial<FilesViewModel> = {}): FilesViewModel {
  return {
    projectValid: true,
    files: [file(1), file(2, 'medium'), file(3, 'xhard')],
    selectedPath: null,
    fileSearch: '',
    expandedGroups: new Set(['easy']),
    busy: false,
    isFileOpen: () => false,
    ...overrides,
  }
}

function elements(): {
  list: FakeElement
  searchInput: FakeElement
  totalCount: FakeElement
} {
  return {
    list: new FakeElement(),
    searchInput: new FakeElement(),
    totalCount: new FakeElement(),
  }
}

function callbacks() {
  return {
    onFileSelect: vi.fn(),
    onGroupToggle: vi.fn(),
    onFileContextMenu: vi.fn(),
    onRendered: vi.fn(),
  }
}

beforeEach(() => {
  installFakeDocument()
  resetMetrics()
})

afterEach(() => {
  restoreDocument()
})

describe('renderFilesView', () => {
  it('keeps file DOM and listeners when only row state changes', () => {
    const view = elements()
    const firstCallbacks = callbacks()
    const secondCallbacks = callbacks()
    const initial = model()

    renderFilesView(view, initial, firstCallbacks)
    const firstButton = view.list.querySelector('.file-item')
    const firstInnerHTMLWrites = testMetrics.innerHTMLWrites
    const firstListenerCount = testMetrics.listeners

    renderFilesView(view, {
      ...initial,
      selectedPath: initial.files[1].path,
      busy: true,
      isFileOpen: (path) => path === initial.files[0].path,
    }, secondCallbacks)

    expect(view.list.querySelector('.file-item')).toBe(firstButton)
    expect(testMetrics.innerHTMLWrites).toBe(firstInnerHTMLWrites)
    expect(testMetrics.listeners).toBe(firstListenerCount)
    expect(firstButton?.classList.contains('is-open')).toBe(true)
    expect(view.list.querySelectorAll('.file-item').every((item) => item.disabled)).toBe(true)
    expect(secondCallbacks.onRendered).toHaveBeenCalledOnce()
  })

  it('refreshes callback targets when equivalent file DTOs are replaced', () => {
    const view = elements()
    const initialCallbacks = callbacks()
    const nextCallbacks = callbacks()
    const initial = model()
    const mutableFiles = [...initial.files]

    renderFilesView(view, { ...initial, files: mutableFiles }, initialCallbacks)
    const firstButton = view.list.querySelector('.file-item')
    const replacement = { ...initial.files[0], name: 'Q1Renamed.java' }
    mutableFiles[0] = replacement
    renderFilesView(view, {
      ...initial,
      files: mutableFiles,
    }, nextCallbacks)

    expect(view.list.querySelector('.file-item')).not.toBe(firstButton)
    firstButton?.dispatch('click')
    expect(nextCallbacks.onFileSelect).toHaveBeenCalledWith(replacement)
  })

  it('updates group expansion and survives an external icon replacement', () => {
    const view = elements()
    const initial = model()
    const firstCallbacks = callbacks()
    renderFilesView(view, initial, firstCallbacks)
    const groupToggle = view.list.querySelector('.file-group-toggle')
    const liveIcon = groupToggle?.querySelector('.group-toggle-icon')
    const externalIcon = new FakeElement()
    externalIcon.className = 'group-toggle-icon'
    liveIcon?.replaceWith(externalIcon)

    const nextCallbacks = callbacks()
    renderFilesView(view, { ...initial, expandedGroups: new Set(['medium']) }, nextCallbacks)

    expect(groupToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(groupToggle?.querySelector('.group-toggle-icon')).not.toBe(externalIcon)
    expect(groupToggle?.querySelector('.group-toggle-icon')?.parentElement).toBe(groupToggle?.querySelector('.file-group-label'))
  })

  it('rebuilds only when the visible structure changes', () => {
    const view = elements()
    const initial = model()
    renderFilesView(view, initial, callbacks())
    const initialWrites = testMetrics.innerHTMLWrites

    renderFilesView(view, { ...initial, fileSearch: 'Problem' }, callbacks())
    expect(testMetrics.innerHTMLWrites).toBe(initialWrites + 1)

    renderFilesView(view, { ...initial, fileSearch: 'no-match' }, callbacks())
    expect(view.list.querySelector('.sidebar-empty')?.textContent).toBe('No matches')
    expect(testMetrics.innerHTMLWrites).toBe(initialWrites + 2)

    renderFilesView(view, { ...initial, projectValid: false }, callbacks())
    expect(view.list.querySelector('.sidebar-empty')?.textContent).toBe('Choose a repository to see problems')
    expect(testMetrics.innerHTMLWrites).toBe(initialWrites + 3)
  })

  it('matches the legacy DOM semantics for an initial file snapshot', () => {
    const optimized = elements()
    const baseline = elements()
    const current = model({ selectedPath: 'src/main/java/medium/Q2Problem.java' })
    const optimizedCallbacks = callbacks()
    const baselineCallbacks = callbacks()

    renderFilesView(optimized, current, optimizedCallbacks)
    renderFilesViewBaseline(baseline, current, baselineCallbacks)

    expect(snapshot(optimized.list)).toEqual(snapshot(baseline.list))
    expect(optimized.totalCount.textContent).toBe(baseline.totalCount.textContent)
  })
})

describe('files view benchmark fixture', () => {
  it('compares repeated structural work with row-state work', () => {
    const view = elements()
    const files = Array.from({ length: 2353 }, (_, index) => file(index + 1, FILE_GROUPS[index % 3].key))
    const base = model({ files, expandedGroups: new Set(['easy', 'medium', 'xhard']) })

    const warmup = 2
    for (let index = 0; index < warmup; index += 1) {
      renderFilesView(view, base, callbacks())
    }
    resetMetrics()
    const optimizedStart = performance.now()
    for (let index = 0; index < 4; index += 1) {
      renderFilesView(view, {
        ...base,
        selectedPath: files[index].path,
        isFileOpen: (path) => path === files[index].path,
      }, callbacks())
    }
    const optimizedMs = performance.now() - optimizedStart
    const optimizedCreates = testMetrics.createElement
    const optimizedClears = testMetrics.innerHTMLWrites

    resetMetrics()
    const baselineStart = performance.now()
    for (let index = 0; index < 4; index += 1) {
      renderFilesViewBaseline(view, {
        ...base,
        selectedPath: files[index].path,
        isFileOpen: (path) => path === files[index].path,
      }, callbacks())
    }
    const baselineMs = performance.now() - baselineStart

    // Keep this deterministic evidence in the test output when explicitly
    // requested by the performance audit without making ordinary test output
    // noisy.
    if (import.meta.env.APP_VIEW_BENCHMARK === '1') {
      console.info(JSON.stringify({
        fixtureFiles: files.length,
        iterations: 4,
        baselineMs,
        optimizedMs,
        baselineCreates: testMetrics.createElement,
        optimizedCreates,
        baselineClears: testMetrics.innerHTMLWrites,
        optimizedClears,
      }))
    }
    expect(optimizedCreates).toBe(0)
    expect(optimizedClears).toBe(0)
    expect(baselineMs).toBeGreaterThanOrEqual(0)
  })
})

function snapshot(element: FakeElement): unknown {
  return {
    className: element.className,
    hidden: element.hidden,
    disabled: element.disabled,
    attributes: [...element.attributes.entries()],
    dataset: { ...element.dataset },
    text: element.children.filter((child) => child instanceof FakeText).map((child) => child.textContent),
    children: element.children
      .filter((child): child is FakeElement => child instanceof FakeElement)
      .map((child) => snapshot(child)),
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/icons', () => ({
  iconFor: (_name: string, className?: string) => {
    const icon = (globalThis.document as unknown as FakeDocument).createElement('svg')
    icon.className = className ?? ''
    return icon
  },
}))

import { renderTestResults, type TestResultsViewModel } from '../../../src/app/results-view'
import type { TestResult } from '../../../src/backend'

class FakeClassList {
  private readonly values = new Set<string>()

  add(...names: string[]): void {
    names.forEach((name) => this.values.add(name))
  }

  contains(name: string): boolean {
    return this.values.has(name)
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly classList = new FakeClassList()
  parentElement: FakeElement | null = null
  className = ''
  id = ''
  title = ''
  tabIndex = 0
  private rawText = ''

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.rawText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.rawText = value
    this.clearChildren()
  }

  set innerHTML(_value: string) {
    this.rawText = ''
    this.clearChildren()
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this
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

  addEventListener(_type: string, _listener: (event: unknown) => void): void {}

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = []
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child)
        visit(child)
      }
    }
    visit(this)
    return matches as T[]
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const role = selector.match(/^\[role="([^"]+)"\]$/)
    return role ? this.getAttribute('role') === role[1] : false
  }

  private clearChildren(): void {
    this.children.forEach((child) => { child.parentElement = null })
    this.children.length = 0
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement('#text')
    node.textContent = value
    return node
  }
}

class FakeRoot extends FakeElement {
  private readonly elements: Map<string, FakeElement>

  constructor() {
    super('root')
    const panel = new FakeElement('section')
    const statusRow = new FakeElement('div')
    const body = new FakeElement('div')
    panel.append(statusRow, body)
    this.append(panel)
    this.elements = new Map([
      ['#tests-panel', panel],
      ['#test-status-row', statusRow],
      ['#test-body', body],
    ])
  }

  override querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return (this.elements.get(selector) ?? super.querySelector(selector)) as T | null
  }
}

const originalDocument = globalThis.document

afterEach(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  } else {
    delete (globalThis as { document?: Document }).document
  }
})

function result(phase: string, message: string): TestResult {
  return {
    success: false,
    phase,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
    tests: [],
    diagnostics: [{ severity: 'error', message, origin: 'runner' }],
    stdout: '',
    stderr: message,
  }
}

function model(testResult: TestResult): TestResultsViewModel {
  return {
    result: testResult,
    liveRun: null,
    testMethod: null,
    selectedTestKey: null,
    selectedPath: 'src/Q1.java',
    liveDiagnosticsError: null,
    macPlatform: false,
  }
}

function render(testResult: TestResult): FakeRoot {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: new FakeDocument(),
  })
  const root = new FakeRoot()
  renderTestResults(root as unknown as HTMLElement, model(testResult), {
    onSelectTest: vi.fn(),
    onRevealLocation: vi.fn(),
  })
  return root
}

describe('test result termination display', () => {
  it('shows a stopped outcome and keeps the stop reason visible', () => {
    const root = render(result('cancelled', 'Test run stopped by user.'))

    expect(root.querySelector('#test-status-row')?.textContent).toContain('Stopped')
    expect(root.querySelector('.run-note-message')?.textContent).toBe('Test run stopped by user.')
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain('stopped')
  })

  it('shows a timed-out outcome and its execution limit', () => {
    const root = render(result('timedOut', 'Tests exceeded the 5-second execution limit.'))

    expect(root.querySelector('#test-status-row')?.textContent).toContain('Timed out after 5 seconds')
    expect(root.querySelector('.run-note-message')?.textContent)
      .toBe('Tests exceeded the 5-second execution limit.')
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain('timed out')
  })
})

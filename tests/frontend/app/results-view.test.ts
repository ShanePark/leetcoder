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
    const body = new FakeElement('div')
    panel.append(body)
    this.append(panel)
    this.elements = new Map([
      ['#tests-panel', panel],
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

function model(testResult: TestResult | null, overrides: Partial<TestResultsViewModel> = {}): TestResultsViewModel {
  return {
    result: testResult,
    liveRun: null,
    testMethod: null,
    selectedTestKey: null,
    selectedPath: 'src/Q1.java',
    liveDiagnosticsError: null,
    macPlatform: false,
    ...overrides,
  }
}

function render(testResult: TestResult | null, overrides: Partial<TestResultsViewModel> = {}): FakeRoot {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: new FakeDocument(),
  })
  const root = new FakeRoot()
  renderTestResults(root as unknown as HTMLElement, model(testResult, overrides), {
    onSelectTest: vi.fn(),
    onRevealLocation: vi.fn(),
  })
  return root
}

function runItem(root: FakeRoot): FakeElement {
  const item = root.querySelector('.test-tree-root')
  if (!item) throw new Error('missing run item')
  return item
}

function finished(
  success: boolean,
  phase: string,
  summary: Partial<TestResult['summary']>,
  tests: TestResult['tests'] = [],
): TestResult {
  return {
    success,
    phase,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, ...summary },
    tests,
    diagnostics: [],
    stdout: '',
    stderr: '',
  }
}

describe('test result termination display', () => {
  it('shows a stopped outcome and keeps the stop reason visible', () => {
    const root = render(result('cancelled', 'Test run stopped by user.'))

    expect(runItem(root).textContent).toContain('Stopped')
    expect(runItem(root).className).toContain('is-warning')
    expect(root.querySelector('.run-note-message')?.textContent).toBe('Test run stopped by user.')
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain('Stopped')
  })

  it('shows a timed-out outcome and its execution limit', () => {
    const root = render(result('timedOut', 'Tests exceeded the 5-second execution limit.'))

    expect(runItem(root).textContent).toContain('Timed out after 5 seconds')
    expect(runItem(root).className).toContain('is-failure')
    expect(root.querySelector('.run-note-message')?.textContent)
      .toBe('Tests exceeded the 5-second execution limit.')
    expect(root.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain('Timed out')
  })
})

describe('run summary in the test list', () => {
  it('leads the list with a passed verdict, test count, and duration', () => {
    const root = render(finished(true, 'test', { total: 2, passed: 2, durationMs: 91 }, [
      { name: 'first', status: 'passed', durationMs: 40 },
      { name: 'second', status: 'passed', durationMs: 51 },
    ]))
    const item = runItem(root)

    expect(root.querySelector('[role="option"]')).toBe(item)
    expect(item.className).toContain('is-success')
    expect(item.querySelector('.test-verdict')?.textContent).toBe('Passed')
    expect(item.querySelector('.test-tree-facts')?.textContent).toBe('2 tests · 91ms')
    expect(item.getAttribute('aria-label')).toBe('Test run: Passed, 2 tests, 91ms')
    expect(item.title).toBe('')
  })

  it('shows failed counts and the failure message on the run item', () => {
    const root = render(finished(false, 'test', { total: 3, passed: 1, failed: 1, errors: 1, durationMs: 1500 }, [
      { name: 'first', status: 'passed' },
      { name: 'second', status: 'failed', message: 'expected 1 but was 2' },
      { name: 'third', status: 'error', message: 'boom' },
    ]))
    const item = runItem(root)

    expect(item.className).toContain('is-failure')
    expect(item.querySelector('.test-verdict')?.textContent).toBe('Failed')
    expect(item.querySelector('.test-tree-facts')?.textContent).toBe('2 of 3 failed · 1.50s')
    expect(item.title).not.toBe('')
  })

  it('counts compile errors without a duration', () => {
    const compile = finished(false, 'compile', { durationMs: 300 })
    compile.diagnostics = [
      { severity: 'error', message: 'cannot find symbol' },
      { severity: 'error', message: 'missing return' },
    ]
    const item = runItem(render(compile))

    expect(item.className).toContain('is-failure')
    expect(item.querySelector('.test-verdict')?.textContent).toBe('Compile error')
    expect(item.querySelector('.test-tree-facts')?.textContent).toBe('2 errors')
  })

  it('marks a run without tests and a runner error by their tones', () => {
    const noTests = runItem(render(finished(false, 'noTests', { durationMs: 20 })))
    expect(noTests.className).toContain('is-warning')
    expect(noTests.querySelector('.test-verdict')?.textContent).toBe('No tests ran')
    expect(noTests.querySelector('.test-tree-facts')?.textContent).toBe('20ms')

    const runner = runItem(render(result('runner', 'Gradle daemon exited')))
    expect(runner.className).toContain('is-error')
    expect(runner.querySelector('.test-verdict')?.textContent).toBe('Runner error')
    expect(runner.title).toContain('Gradle daemon exited')
  })

  it('shows live progress, the targeted method, and unavailable live checks', () => {
    const root = render(null, {
      liveRun: {
        id: 1,
        status: 'running',
        phase: 'test',
        startedAt: Date.now(),
        tests: [{ name: 'returnsPair', status: 'passed', durationMs: 5 }],
        stdout: '',
        stderr: '',
        activeTest: null,
        error: null,
        testMethod: 'returnsPair',
        stopRequested: false,
      },
      testMethod: 'returnsPair',
      liveDiagnosticsError: 'javac missing',
    })
    const item = runItem(root)

    expect(root.querySelector('#tests-panel')?.getAttribute('aria-busy')).toBe('true')
    expect(item.className).toContain('is-running')
    expect(item.querySelector('.test-verdict')?.textContent).toBe('Running tests…')
    expect(item.querySelector('.test-run-target')?.textContent).toBe('Only returnsPair()')
    expect(item.querySelector('.test-tree-facts')?.textContent).toBe('1 passed')
    expect(item.querySelector('.live-diagnostics-status')?.title).toBe('javac missing')
    expect(item.getAttribute('aria-label')).toBe('Test run: Running tests…, only returnsPair(), 1 passed')
  })

  it('puts a resize separator between the test list and the run output', () => {
    const root = render(finished(true, 'test', { total: 1, passed: 1 }))
    const workspace = root.querySelector('.test-results-workspace')!
    const [list, splitter, detail] = workspace.children

    expect(list.className).toContain('test-results-tree')
    expect(splitter.id).toBe('test-splitter')
    expect(splitter.getAttribute('role')).toBe('separator')
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical')
    expect(splitter.getAttribute('aria-valuemin')).toBe('200')
    expect(splitter.tabIndex).toBe(0)
    expect(detail.id).toBe('test-detail-pane')
  })

  it('shows run hints in the body before the first run, without a list or separator', () => {
    const root = render(null, { liveDiagnosticsError: 'javac missing' })
    const idle = root.querySelector('.test-idle')!

    expect(idle.textContent).toBe('Run Ctrl+R to test the current file · Ctrl+Shift+R for the selected testLive checks unavailable')
    expect(root.querySelector('.test-tree-root')).toBeNull()
    expect(root.querySelector('#test-splitter')).toBeNull()
  })
})

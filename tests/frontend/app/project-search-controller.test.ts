import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient, ProjectSearchMatch, ProjectSearchResult } from '../../../src/backend'
import {
  ProjectContentSearchController,
  PROJECT_CONTENT_SEARCH_DEBOUNCE_MS,
} from '../../../src/app/project-search-controller'

type TestListener = (event: Event) => void
type FakeChild = FakeElement | FakeText

class FakeText {
  constructor(readonly textContent: string) {}
}

class FakeDocument {
  createElement(_tagName: string): FakeElement {
    return new FakeElement(this)
  }

  createTextNode(value: string): FakeText {
    return new FakeText(value)
  }
}

class FakeElement {
  readonly children: FakeChild[] = []
  readonly listeners = new Map<string, Set<TestListener>>()
  readonly attributes = new Map<string, string>()
  readonly ownerDocument: FakeDocument
  parentElement: FakeElement | null = null
  className = ''
  type = ''
  title = ''
  disabled = false
  hidden = false
  private ownText = ''

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.ownText = value
    this.children.length = 0
  }

  get childElementCount(): number {
    return this.children.filter((child): child is FakeElement => child instanceof FakeElement).length
  }

  get childrenElements(): FakeElement[] {
    return this.children.filter((child): child is FakeElement => child instanceof FakeElement)
  }

  append(...nodes: FakeChild[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes: FakeChild[]): void {
    for (const child of this.childrenElements) child.parentElement = null
    this.children.length = 0
    this.ownText = ''
    this.append(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type) ?? new Set<TestListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: TestListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, values: Record<string, unknown> = {}): void {
    const event = { ...values, target: this, currentTarget: this }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as unknown as Event)
    }
  }

  remove(): void {
    if (!this.parentElement) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index >= 0) siblings.splice(index, 1)
    this.parentElement = null
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function match(path: string, line: number, preview = `preview for ${path}`): ProjectSearchMatch {
  return { path, line, column: 1, preview }
}

function result(
  matches: ProjectSearchMatch[],
  options: Partial<Pick<ProjectSearchResult, 'truncated' | 'skippedFiles'>> = {},
): ProjectSearchResult {
  return { matches, truncated: false, skippedFiles: 0, ...options }
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className.split(/\s+/).includes(className)) return root
  for (const child of root.childrenElements) {
    const found = findByClass(child, className)
    if (found) return found
  }
  return null
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function setup(options: {
  repoPath?: string | null
  beforeSearch?: () => Promise<boolean>
  canNavigate?: (match: ProjectSearchMatch) => boolean
  onNavigate?: (match: ProjectSearchMatch, query: string) => Promise<void>
} = {}) {
  const document = new FakeDocument()
  const viewport = new FakeElement(document)
  const filenameResults = new FakeElement(document)
  filenameResults.className = 'file-list'
  filenameResults.textContent = 'Immediate filename result'
  const host = new FakeElement(document)
  host.className = 'project-content-search-host'
  viewport.append(filenameResults, host)
  let repoPath = options.repoPath === undefined ? '/workspace/project' : options.repoPath
  const searchProject = vi.fn<BackendClient['searchProject']>()
  searchProject.mockResolvedValue(result([]))
  const onNavigate = options.onNavigate ?? vi.fn(async () => undefined)
  const controller = new ProjectContentSearchController({
    host: host as unknown as HTMLElement,
    backend: { searchProject },
    getRepositoryPath: () => repoPath,
    beforeSearch: options.beforeSearch,
    canNavigate: options.canNavigate ?? (() => false),
    onNavigate,
  })
  return {
    controller,
    viewport,
    filenameResults,
    host,
    searchProject,
    onNavigate,
    setRepoPath: (path: string | null) => { repoPath = path },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectContentSearchController', () => {
  it('keeps filename hits immediate and appends deduplicated content-only file hits', async () => {
    const { controller, filenameResults, host, searchProject } = setup()
    searchProject.mockResolvedValue(result([
      match('src/Example.java', 3, 'filename hit already shown above'),
      match('src/utils/Helper.java', 5, 'first source line'),
      match('src/utils/helper.java', 9, 'later line from same file'),
      match('docs/README.md', 7, 'readme preview'),
    ]))

    controller.update('example', ['src/Example.java'])
    expect(filenameResults.textContent).toBe('Immediate filename result')
    expect(searchProject).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    await flushPromises()

    expect(searchProject).toHaveBeenCalledWith(
      '/workspace/project',
      'example',
      false,
      ['src/Example.java'],
    )
    const list = findByClass(host, 'project-content-search-list')!
    expect(list.textContent).toContain('Helper.java:5')
    expect(list.textContent).toContain('first source line')
    expect(list.textContent).toContain('README.md:7')
    expect(list.textContent).not.toContain('Example.java')
    expect(list.textContent).not.toContain('later line from same file')
    expect(list.textContent).toContain('Preview only')
    controller.dispose()
  })

  it('debounces changes and only searches the latest non-empty query', async () => {
    const { controller, searchProject } = setup()
    controller.update('first', [])
    await vi.advanceTimersByTimeAsync(200)
    controller.update('latest', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS - 1)
    expect(searchProject).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(searchProject).toHaveBeenCalledTimes(1)
    expect(searchProject).toHaveBeenCalledWith('/workspace/project', 'latest', false, [])
    controller.dispose()
  })

  it('clears immediately for an empty query and cancels pending work', async () => {
    const { controller, host, searchProject } = setup()
    controller.update('query', [])
    const section = findByClass(host, 'project-content-search')!
    controller.update('   ', [])
    expect(section.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)

    expect(searchProject).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('runs only one native search and starts the latest queued query when it finishes', async () => {
    const first = deferred<ProjectSearchResult>()
    const second = deferred<ProjectSearchResult>()
    const { controller, host, searchProject } = setup()
    searchProject.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    controller.update('first', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    expect(searchProject).toHaveBeenCalledTimes(1)
    controller.update('second', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    expect(searchProject).toHaveBeenCalledTimes(1)

    first.resolve(result([match('src/Old.java', 1)]))
    await flushPromises()
    expect(searchProject).toHaveBeenCalledTimes(2)
    expect(searchProject.mock.calls[1]?.[1]).toBe('second')
    expect(findByClass(host, 'project-content-search-list')?.textContent).not.toContain('Old.java')

    second.resolve(result([match('src/New.java', 2)]))
    await flushPromises()
    expect(findByClass(host, 'project-content-search-list')?.textContent).toContain('New.java:2')
    controller.dispose()
  })

  it('awaits pending saves and aborts the content scan when saving fails', async () => {
    const saveGate = deferred<boolean>()
    const order: string[] = []
    const beforeSearch = vi.fn<() => Promise<boolean>>(() => {
      order.push('save-start')
      return saveGate.promise.then((saved) => {
        order.push('save-finished')
        return saved
      })
    })
    const { controller, host, searchProject } = setup({ beforeSearch })
    controller.update('value', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)

    expect(beforeSearch).toHaveBeenCalledOnce()
    expect(searchProject).not.toHaveBeenCalled()
    saveGate.resolve(false)
    await flushPromises()

    expect(order).toEqual(['save-start', 'save-finished'])
    expect(searchProject).not.toHaveBeenCalled()
    expect(findByClass(host, 'project-content-search-status')?.textContent)
      .toBe('Save pending changes before searching.')
    controller.dispose()
  })

  it('does not search a query that becomes stale while a save is pending', async () => {
    const saveGate = deferred<boolean>()
    const beforeSearch = vi.fn<() => Promise<boolean>>()
      .mockReturnValueOnce(saveGate.promise)
      .mockResolvedValueOnce(true)
    const { controller, host, searchProject } = setup({ beforeSearch })
    controller.update('old', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    controller.update('new', [])
    saveGate.resolve(true)
    await flushPromises()
    expect(searchProject).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(searchProject).toHaveBeenCalledTimes(1)
    expect(searchProject.mock.calls[0]?.[1]).toBe('new')
    expect(findByClass(host, 'project-content-search-status')?.textContent).toBe('No content matches.')
    controller.dispose()
  })

  it('ignores stale repository and disposed responses', async () => {
    const pending = deferred<ProjectSearchResult>()
    const { controller, host, searchProject, setRepoPath } = setup()
    searchProject.mockReturnValue(pending.promise)
    controller.update('value', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    setRepoPath('/workspace/other')
    controller.reset()
    pending.resolve(result([match('src/Stale.java', 1)]))
    await flushPromises()
    expect(findByClass(host, 'project-content-search')?.hidden).toBe(true)
    controller.dispose()

    const disposed = setup()
    const delayed = deferred<ProjectSearchResult>()
    disposed.searchProject.mockReturnValue(delayed.promise)
    disposed.controller.update('value', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    disposed.controller.dispose()
    delayed.resolve(result([match('src/Disposed.java', 1)]))
    await flushPromises()
    expect(findByClass(disposed.host, 'project-content-search')).toBeNull()
  })

  it('shows cap and skipped-file notices and navigates supported source results', async () => {
    const onNavigate = vi.fn(async () => undefined)
    const { controller, host, searchProject } = setup({ canNavigate: (hit) => hit.path.endsWith('.java'), onNavigate })
    searchProject.mockResolvedValue(result(
      [match('src/Thing.java', 4), match('docs/Guide.md', 8)],
      { truncated: true, skippedFiles: 2 },
    ))
    controller.update('thing', [])
    await vi.advanceTimersByTimeAsync(PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
    await flushPromises()

    const list = findByClass(host, 'project-content-search-list')!
    expect(findByClass(host, 'project-content-search-notices')?.textContent).toContain('capped')
    expect(findByClass(host, 'project-content-search-notices')?.textContent).toContain('Skipped 2 files')
    expect(list.textContent).toContain('Preview only')
    const javaButton = findByClass(list, 'project-content-search-hit-button')!
    javaButton.dispatch('click')
    await flushPromises()
    expect(onNavigate).toHaveBeenCalledWith(match('src/Thing.java', 4), 'thing')
    controller.dispose()
  })
})

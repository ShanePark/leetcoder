import './lifecycle-mocks'
import { vi } from 'vitest'
import type { BackendClient, ProblemFileEntry, PsLibraryMetadata, RepositoryFilesChanged } from '../../../src/backend'
import { LeetcoderApp } from '../../../src/app'
export { LeetcoderApp }

type Listener = (event: Event) => void

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event)
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  totalListenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

export class FakeElement extends FakeEventTarget {
  readonly classList = {
    values: new Set<string>(),
    add: (...names: string[]): void => {
      names.forEach((name) => this.classList.values.add(name))
    },
    remove: (...names: string[]): void => {
      names.forEach((name) => this.classList.values.delete(name))
    },
    toggle: (name: string, force?: boolean): boolean => {
      const next = force === undefined ? !this.classList.values.has(name) : force
      if (next) this.classList.values.add(name)
      else this.classList.values.delete(name)
      return next
    },
    contains: (name: string): boolean => this.classList.values.has(name),
  }
  readonly dataset: Record<string, string> = {}
  readonly children: FakeElement[] = []
  ownerDocument!: FakeDocument
  parentElement: FakeElement | null = null
  hidden = false
  disabled = false
  isConnected = true
  title = ''
  value = ''
  textContent = ''
  innerHTML = ''

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement = this
        this.children.push(node)
      }
    }
  }

  prepend(...nodes: unknown[]): void {
    const elements = nodes.filter((node): node is FakeElement => node instanceof FakeElement)
    elements.forEach((node) => {
      node.parentElement = this
    })
    this.children.unshift(...elements)
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children.length = 0
    this.append(...nodes)
  }

  querySelector<T extends FakeElement = FakeElement>(_selector: string): T | null {
    return null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(_selector: string): T[] {
    return []
  }

  closest<T extends FakeElement = FakeElement>(_selector: string): T | null {
    return null
  }

  contains(target: EventTarget | null): boolean {
    return target === this
  }

  setAttribute(name: string, value: string): void {
    if (name === 'title') this.title = value
  }

  removeAttribute(name: string): void {
    if (name === 'title') this.title = ''
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  select(): void {}

  scrollIntoView(): void {}
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement = new FakeElement()
  readonly body = new FakeElement()
  activeElement: FakeElement | null = null
  visibilityState: VisibilityState = 'visible'

  constructor() {
    super()
    this.documentElement.ownerDocument = this
    this.body.ownerDocument = this
  }

  createElement(_tagName: string): FakeElement {
    const element = new FakeElement()
    element.ownerDocument = this
    return element
  }

  createTextNode(_text: string): FakeElement {
    return this.createElement('text')
  }
}

class FakeRoot extends FakeElement {
  private readonly elements = new Map<string, FakeElement>()

  constructor(ownerDocument: FakeDocument) {
    super()
    this.ownerDocument = ownerDocument
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T {
    let element = this.elements.get(selector)
    if (!element) {
      element = new FakeElement()
      element.ownerDocument = this.ownerDocument
      this.elements.set(selector, element)
    }
    return element as T
  }

  querySelectorAll<T extends FakeElement = FakeElement>(_selector: string): T[] {
    return []
  }
}

class FakeWindow extends FakeEventTarget {
  close = vi.fn()
  requestAnimationFrame(callback: FrameRequestCallback): number {
    callback(0)
    return 1
  }
}

export class MemoryStorage {
  private readonly values = new Map<string, string>()

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

export interface DomHarness {
  root: FakeRoot
  window: FakeWindow
  document: FakeDocument
  restore: () => void
}

export function installDom(): DomHarness {
  const document = new FakeDocument()
  const root = new FakeRoot(document)
  const window = new FakeWindow()
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>()

  const globals: Record<string, unknown> = {
    document,
    window,
    Node: FakeElement,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeElement,
    HTMLInputElement: FakeElement,
    SVGElement: FakeElement,
  }
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }

  return {
    root,
    window,
    document,
    restore: () => {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

export const file: ProblemFileEntry = {
  path: 'src/main/java/easy/Q1TwoSum.java',
  name: 'Q1TwoSum.java',
  packageSegment: 'easy',
}

export const dailyProblem = {
  date: '2026-09-10',
  frontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  difficulty: 'Easy',
  url: 'https://leetcode.com/problems/two-sum/',
  javaSnippet: 'class Q1TwoSum {}',
  content: null,
}

export const psLibraryMetadata: PsLibraryMetadata = {
  fingerprint: 'test-fingerprint',
  methods: [],
}

interface BackendHarness {
  backend: BackendClient
  watcher: {
    current: ((change: RepositoryFilesChanged) => void) | null
    unsubscribe: ReturnType<typeof vi.fn>
  }
}

export function createBackend(): BackendHarness {
  const watcher = {
    current: null as ((change: RepositoryFilesChanged) => void) | null,
    unsubscribe: vi.fn(),
  }
  const backend = {
    validateProject: vi.fn().mockResolvedValue({ valid: true }),
    fetchDailyProblem: vi.fn().mockResolvedValue(dailyProblem),
    fetchProblemByNumber: vi.fn().mockResolvedValue(dailyProblem),
    listProblemFiles: vi.fn().mockResolvedValue([file]),
    readProblemFile: vi.fn().mockResolvedValue('class Q1TwoSum {}'),
    createProblemFile: vi.fn().mockResolvedValue(undefined),
    saveProblemFile: vi.fn().mockResolvedValue(undefined),
    deleteProblemFile: vi.fn().mockResolvedValue(undefined),
    duplicateProblemFile: vi.fn().mockResolvedValue({ relativePath: file.path, content: '' }),
    renameProblemFile: vi.fn().mockResolvedValue({ relativePath: file.path, content: '' }),
    listGitChanges: vi.fn().mockResolvedValue([]),
    discardGitChanges: vi.fn().mockResolvedValue(undefined),
    showInFileManager: vi.fn().mockResolvedValue(undefined),
    getGitDiff: vi.fn().mockResolvedValue(''),
    commitGit: vi.fn().mockResolvedValue({ commitHash: 'abc', message: 'commit', paths: [] }),
    pushGit: vi.fn().mockResolvedValue({ output: '' }),
    runProblemTest: vi.fn().mockResolvedValue({
      success: true,
      phase: 'test',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
      tests: [],
      diagnostics: [],
      stdout: '',
      stderr: '',
    }),
    stopProblemTest: vi.fn().mockResolvedValue(true),
    checkProblemDiagnostics: vi.fn().mockResolvedValue([]),
    inspectPsLibrary: vi.fn().mockResolvedValue(psLibraryMetadata),
    watchRepository: vi.fn().mockResolvedValue(undefined),
    stopWatchingRepository: vi.fn().mockResolvedValue(undefined),
    onRepositoryFilesChanged: vi.fn(async (handler: (change: RepositoryFilesChanged) => void) => {
      watcher.current = handler
      return watcher.unsubscribe
    }),
    checkForUpdate: vi.fn().mockResolvedValue({
      supported: false,
      available: false,
      currentCommit: '',
      latestCommit: '',
    }),
    updateAndRestart: vi.fn().mockResolvedValue(undefined),
  } as unknown as BackendClient
  return { backend, watcher }
}

export function rememberedStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  storage.setItem('leetcoder.repository-path', '/repo')
  return storage
}

export async function startApp(
  dom: DomHarness,
  backend: BackendClient,
): Promise<LeetcoderApp> {
  const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
    backend,
    storage: rememberedStorage() as unknown as Storage,
  })
  await app.start()
  return app
}

export function setFileSearchQuery(dom: DomHarness, query: string): void {
  const search = dom.root.querySelector<FakeElement>('#file-search')
  if (!search) throw new Error('Missing file search input')
  search.value = query
  search.dispatch('input', { target: search })
}

export function setNavigatorPlatform(platform: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform, userAgent: 'Vitest' },
  })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
}

export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BackendClient,
  ProblemFileEntry,
  ProjectSearchMatch,
  ProjectValidation,
  PsLibraryMetadata,
  RepositoryFilesChanged,
} from '../../../src/backend'
import { UPDATE_CHECK_INTERVAL_MS } from '../../../src/update-controller'

const testMocks = vi.hoisted(() => ({
  editorInstances: [] as Array<{
    emitChange: (source: string) => void
    triggerProjectSearch: () => void
    metadataUpdates: Array<PsLibraryMetadata | null>
    revealedLocations: Array<{ line: number; column?: number | null }>
  }>,
  fileViewCallbacks: [] as Array<{
    onFileSelect: (file: ProblemFileEntry) => void
  }>,
  filenameMatchedPaths: [] as string[],
  testRunControllers: [] as Array<{
    stopCurrentRun: ReturnType<typeof vi.fn>
  }>,
  contentSearchControllers: [] as Array<{
    update: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    options: {
      canNavigate: (match: ProjectSearchMatch) => boolean
      onNavigate: (match: ProjectSearchMatch, query: string) => Promise<void>
    }
  }>,
}))

vi.mock('../../../src/editor', () => {
  class FakeJavaEditor {
    readonly view = { state: {} }
    readonly revealedLocations: Array<{ line: number; column?: number | null }> = []
    readonly metadataUpdates: Array<PsLibraryMetadata | null> = []
    private readonly callbacks: {
      onChange?: (source: string) => void
      onSearchProject?: () => void
    }

    constructor(_parent: HTMLElement, callbacks: { onChange?: (source: string) => void; onSearchProject?: () => void }) {
      this.callbacks = callbacks
      testMocks.editorInstances.push(this)
    }

    setValue(_source: string): void {}

    reloadExternalValue(_source: string): void {}

    focus(): void {}

    setIssues(_issues: readonly unknown[], _options?: { reveal?: boolean }): void {}

    setPsLibraryMetadata(metadata: PsLibraryMetadata | null): void {
      this.metadataUpdates.push(metadata)
    }

    revealLine(line: number, column?: number | null): void {
      this.revealedLocations.push({ line, column })
    }

    destroy(): void {}

    emitChange(source: string): void {
      this.callbacks.onChange?.(source)
    }

    triggerProjectSearch(): void {
      this.callbacks.onSearchProject?.()
    }
  }

  return {
    JavaEditor: FakeJavaEditor,
    findJavaTestMethodAt: () => null,
    isShortcutHelpAltShortcut: () => false,
  }
})

vi.mock('../../../src/icons', () => ({
  iconFor: () => ({}),
}))

vi.mock('../../../src/app/project-search-controller', () => ({
  ProjectContentSearchController: class {
    readonly options: {
      canNavigate: (match: ProjectSearchMatch) => boolean
      onNavigate: (match: ProjectSearchMatch, query: string) => Promise<void>
    }
    readonly update = vi.fn()
    readonly reset = vi.fn()
    readonly dispose = vi.fn()

    constructor(options: unknown) {
      this.options = options as typeof this.options
      testMocks.contentSearchControllers.push(this)
    }
  },
}))

vi.mock('../../../src/update-progress', () => ({
  createUpdateProgressView: () => ({
    start: vi.fn(),
    update: vi.fn(),
    fail: vi.fn(),
    isActive: () => false,
  }),
  listenForUpdateProgress: vi.fn(async () => () => {}),
}))

vi.mock('../../../src/live-diagnostics', () => ({
  LiveDiagnosticsScheduler: class {
    schedule(_snapshot: unknown): void {}
    cancel(): void {}
    setBlocked(_blocked: boolean): void {}
    dispose(): void {}
  },
}))

vi.mock('../../../src/app/shell-view', () => ({
  renderShellView: vi.fn(),
}))

vi.mock('../../../src/app/files-view', () => ({
  FILE_GROUPS: [
    { key: 'easy', label: 'Easy' },
    { key: 'medium', label: 'Medium' },
    { key: 'xhard', label: 'Hard' },
  ],
  OTHER_GROUP: { key: 'other', label: 'Other' },
  renderFilesView: vi.fn((_elements: unknown, model: {
    projectValid: boolean
    files: ProblemFileEntry[]
    fileSearch: string
  }, callbacks: {
    onFileSelect: (file: ProblemFileEntry) => void
  }) => {
    const query = model.fileSearch.trim().toLocaleLowerCase()
    testMocks.filenameMatchedPaths = model.projectValid
      ? model.files.filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
        .map((entry) => entry.path)
      : []
    testMocks.fileViewCallbacks.push(callbacks)
  }),
  getFilenameMatchedPaths: vi.fn(() => testMocks.filenameMatchedPaths),
}))

vi.mock('../../../src/app/daily-view', () => ({
  createDailyProblemView: vi.fn(() => vi.fn()),
}))

vi.mock('../../../src/app/dialogs-view', () => ({
  renderDeleteFileDialog: vi.fn(),
  renderDiscardGitDialog: vi.fn(),
  renderFileContextMenu: vi.fn(),
  renderGitContextMenu: vi.fn(),
}))

vi.mock('../../../src/app/git-view', () => ({
  renderGitPanel: vi.fn(),
  updateGitCommitControls: vi.fn(),
}))

vi.mock('../../../src/app/results-view', () => ({
  renderTestResults: vi.fn(() => ({ selectedTestKey: null })),
}))

vi.mock('../../../src/app/tabs-view', () => ({
  createFileTabsView: vi.fn(() => ({
    render: vi.fn(),
    update: vi.fn(),
    dispose: vi.fn(),
  })),
  renderFileHeading: vi.fn(),
}))

vi.mock('../../../src/app/pane-layout', () => ({
  createPaneLayoutController: vi.fn(() => ({
    apply: vi.fn(),
    applyDailyDescriptionHeight: vi.fn(),
    applyGitFileListWidth: vi.fn(),
    destroy: vi.fn(),
  })),
}))

vi.mock('../../../src/app/toast-controller', () => ({
  ToastController: class {
    show(_message: string, _tone: string): void {}
    dispose(): void {}
  },
}))

vi.mock('../../../src/app/overlay-controller', () => ({
  OverlayController: class {
    isUpdateAvailable = false
    isUpdateBusy = false

    constructor(_options: unknown) {}
    render(): void {}
    setUpdateAvailable(_available: boolean): void {}
    setUpdateBusy(_busy: boolean): void {}
    openSettingsDialog(_section?: string): void {}
    closeAppMenu(_restoreFocus?: boolean): void {}
    handleEscape(_event: KeyboardEvent): boolean { return false }
    handleOutsidePointerDown(_event: PointerEvent): void {}
    dispose(): void {}
  },
}))

vi.mock('../../../src/app/test-run-controller', () => ({
  TestRunController: class {
    resultSource: null = null
    stopCurrentRun = vi.fn()

    constructor(_options: unknown) {
      testMocks.testRunControllers.push(this)
    }
    runCurrentTest(_testMethod?: string): Promise<void> { return Promise.resolve() }
    resetTestState(): void {}
    cancelCurrentRun(): void {}
    selectTestResult(_key: string, _focus: boolean): void {}
    acceptRenderedSelection(_key: string | null): void {}
    isResultSourceCurrent(_source: unknown): boolean { return false }
    dispose(): void {}
  },
}))

vi.mock('../../../src/app/file-operations-controller', () => ({
  FileOperationsController: class {
    constructor(_options: unknown) {}
    createFileForToday(): Promise<void> { return Promise.resolve() }
    deleteFile(_file: ProblemFileEntry): Promise<void> { return Promise.resolve() }
    duplicateFile(_file: ProblemFileEntry): Promise<void> { return Promise.resolve() }
    renameFile(_file: ProblemFileEntry, _name: string): Promise<void> { return Promise.resolve() }
    discardGitChanges(_file: unknown): Promise<void> { return Promise.resolve() }
    showGitFileInManager(_path: string): Promise<void> { return Promise.resolve() }
    dispose(): void {}
  },
}))

vi.mock('../../../src/app/git-controller', () => ({
  createGitState: () => ({
    branch: null,
    files: [],
    selectedPaths: [],
    activePath: null,
    diffByPath: {},
    fallbackDiff: '',
    loading: false,
    diffLoading: false,
    busy: false,
    error: null,
    commitMessage: '',
    commitMessageEdited: false,
    loadedRepoPath: null,
    stale: false,
  }),
  GitController: class {
    progressLabel: string | null = null

    constructor(_backend: unknown, _options: unknown, _state: unknown) {}
    clearScheduledRefresh(): void {}
    selectAllFiles(): void {}
    selectNoFiles(): void {}
    toggleFile(_path: string, _selected: boolean): void {}
    setActiveFile(_path: string): void {}
    commitSelectedFiles(_push: boolean): Promise<void> { return Promise.resolve() }
    markStale(): void {}
    reset(): void {}
    refreshStatus(_allowBusy?: boolean): Promise<void> { return Promise.resolve() }
    handleVisibilityReturn(): void {}
    scheduleRefreshIfNeeded(): void {}
    dispose(): void {}
  },
}))

import { LeetcoderApp } from '../../../src/app'

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

class FakeElement extends FakeEventTarget {
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

class MemoryStorage {
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

interface DomHarness {
  root: FakeRoot
  window: FakeWindow
  document: FakeDocument
  restore: () => void
}

function installDom(): DomHarness {
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

const file: ProblemFileEntry = {
  path: 'src/main/java/easy/Q1TwoSum.java',
  name: 'Q1TwoSum.java',
  packageSegment: 'easy',
}

const dailyProblem = {
  date: '2026-09-10',
  frontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  difficulty: 'Easy',
  url: 'https://leetcode.com/problems/two-sum/',
  javaSnippet: 'class Q1TwoSum {}',
  content: null,
}

const psLibraryMetadata: PsLibraryMetadata = {
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

function createBackend(): BackendHarness {
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

function rememberedStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  storage.setItem('leetcoder.repository-path', '/repo')
  return storage
}

async function startApp(
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

function setFileSearchQuery(dom: DomHarness, query: string): void {
  const search = dom.root.querySelector<FakeElement>('#file-search')
  if (!search) throw new Error('Missing file search input')
  search.value = query
  search.dispatch('input', { target: search })
}

function setNavigatorPlatform(platform: string): () => void {
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

beforeEach(() => {
  testMocks.editorInstances.length = 0
  testMocks.fileViewCallbacks.length = 0
  testMocks.filenameMatchedPaths = []
  testMocks.testRunControllers.length = 0
  testMocks.contentSearchControllers.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('LeetcoderApp lifecycle', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDom()
  })

  afterEach(() => {
    dom.restore()
  })

  it('flushes an edited document through prepareToClose and rejects save failures', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const selectFile = testMocks.fileViewCallbacks.at(-1)?.onFileSelect
    expect(selectFile).toBeDefined()
    selectFile?.(file)
    await vi.waitFor(() => {
      expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', file.path)
    })

    const editor = testMocks.editorInstances.at(-1)
    expect(editor).toBeDefined()
    const save = deferred<void>()
    backend.saveProblemFile = vi.fn(() => save.promise)
    editor?.emitChange('class Q1TwoSum { int value = 1; }')

    let settled = false
    const preparation = app.prepareToClose().then(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(backend.saveProblemFile).toHaveBeenCalledWith(
        '/repo',
        file.path,
        'class Q1TwoSum { int value = 1; }',
      )
    })
    expect(settled).toBe(false)
    save.resolve()
    await expect(preparation).resolves.toBeUndefined()

    const failedSave = vi.fn().mockRejectedValue(new Error('disk full'))
    backend.saveProblemFile = failedSave
    editor?.emitChange('class Q1TwoSum { int value = 2; }')
    await expect(app.prepareToClose()).rejects.toThrow('disk full')
    expect(failedSave).toHaveBeenCalledWith(
      '/repo',
      file.path,
      'class Q1TwoSum { int value = 2; }',
    )

    const listenersBeforeFailedDestroy = dom.window.totalListenerCount()
    await expect(app.destroy()).rejects.toThrow('disk full')
    expect(dom.window.totalListenerCount()).toBe(listenersBeforeFailedDestroy)

    // Resolve the pending retry so the fixture can tear down through the same
    // close path a real desktop window uses.
    backend.saveProblemFile = vi.fn().mockResolvedValue(undefined)
    await app.destroy()
  })

  it('unsubscribes repository callbacks and removes global listeners on destroy', async () => {
    const { backend, watcher } = createBackend()
    const app = await startApp(dom, backend)
    expect(watcher.current).not.toBeNull()
    expect(dom.window.totalListenerCount()).toBeGreaterThan(0)
    expect(dom.document.listenerCount('visibilitychange')).toBe(1)

    const listedBeforeDestroy = vi.mocked(backend.listProblemFiles).mock.calls.length
    const staleWatcher = watcher.current
    await app.destroy()

    expect(watcher.unsubscribe).toHaveBeenCalledOnce()
    expect(dom.window.totalListenerCount()).toBe(0)
    expect(dom.document.totalListenerCount()).toBe(0)
    staleWatcher?.({ paths: [file.path], structural: true })
    expect(backend.listProblemFiles).toHaveBeenCalledTimes(listedBeforeDestroy)

    // A recreated app owns exactly its own global listeners; the first app's
    // handlers must not remain attached to the shared window.
    const second = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    expect(dom.window.totalListenerCount()).toBeGreaterThan(0)
    await second.destroy()
    expect(dom.window.totalListenerCount()).toBe(0)
    expect(dom.document.totalListenerCount()).toBe(0)
  })

  it('exposes Stop during a run and routes it to the test controller', async () => {
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const appInternals = app as unknown as {
      state: {
        testRun: {
          id: number
          status: 'running'
          phase: string
          startedAt: number
          tests: []
          stdout: string
          stderr: string
          activeTest: null
          error: null
          testMethod: null
          stopRequested: boolean
        } | null
        busy: boolean
      }
      renderAll: () => void
    }
    appInternals.state.testRun = {
      id: 1,
      status: 'running',
      phase: 'test',
      startedAt: Date.now(),
      tests: [],
      stdout: '',
      stderr: '',
      activeTest: null,
      error: null,
      testMethod: null,
      stopRequested: false,
    }
    appInternals.state.busy = true
    appInternals.renderAll()

    const button = dom.root.querySelector<FakeElement>('#run-test')
    const label = dom.root.querySelector<FakeElement>('#run-label')
    expect(label.textContent).toBe('Stop')
    expect(button.disabled).toBe(false)
    expect(button.classList.contains('is-stop-action')).toBe(true)

    button.dispatch('click')
    expect(testMocks.testRunControllers.at(-1)?.stopCurrentRun).toHaveBeenCalledOnce()
    const activeRun = appInternals.state.testRun!
    activeRun.stopRequested = true
    appInternals.renderAll()
    expect(label.textContent).toBe('Stopping…')
    expect(button.disabled).toBe(true)
    await app.destroy()
  })

  it('does not gate remembered repository startup on a pending daily request', async () => {
    const { backend } = createBackend()
    const daily = deferred<typeof dailyProblem>()
    backend.fetchDailyProblem = vi.fn(() => daily.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })

    let started = false
    const startup = app.start().then(() => {
      started = true
    })

    await vi.waitFor(() => {
      expect(backend.listProblemFiles).toHaveBeenCalledWith('/repo')
      expect(started).toBe(false)
    })
    expect(backend.fetchDailyProblem).toHaveBeenCalledOnce()

    await app.destroy()
    daily.resolve(dailyProblem)
    await startup
    expect(started).toBe(true)
  })

  it('loads Ps metadata per repository and refreshes after Gradle config changes', async () => {
    vi.useFakeTimers()
    try {
      const { backend, watcher } = createBackend()
      const app = await startApp(dom, backend)
      const editor = testMocks.editorInstances.at(-1)!

      await Promise.resolve()
      await Promise.resolve()
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
      expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
      expect(editor.metadataUpdates.at(-1)).toEqual(psLibraryMetadata)

      editor.emitChange('class Q1TwoSum { int value = 1; }')
      watcher.current?.({ paths: [file.path], structural: false })
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      watcher.current?.({ paths: ['gradle/libs.versions.toml'], structural: false })
      expect(editor.metadataUpdates.at(-1)).toBeNull()
      await vi.advanceTimersByTimeAsync(300)
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      expect(editor.metadataUpdates.at(-1)).toEqual(psLibraryMetadata)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates Ps metadata on app focus without refetching repeatedly', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = createBackend()
      const app = await startApp(dom, backend)
      await Promise.resolve()
      await Promise.resolve()
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      dom.window.dispatch('focus')
      dom.document.dispatch('visibilitychange')
      expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(30_000)
      dom.window.dispatch('focus')
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      dom.window.dispatch('focus')
      expect(backend.inspectPsLibrary).toHaveBeenCalledTimes(2)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops remembered repository startup when validation finishes after destroy', async () => {
    const { backend } = createBackend()
    const validation = deferred<ProjectValidation>()
    backend.validateProject = vi.fn(() => validation.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.validateProject).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    validation.resolve({ valid: true })
    await startup

    expect(backend.listProblemFiles).not.toHaveBeenCalled()
    expect(backend.watchRepository).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })

  it('does not apply a file listing that finishes after destroy', async () => {
    const { backend } = createBackend()
    const files = deferred<ProblemFileEntry[]>()
    backend.listProblemFiles = vi.fn(() => files.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.listProblemFiles).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    files.resolve([file])
    await startup

    expect(backend.watchRepository).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })

  it('stops a watcher that finishes installing after destroy', async () => {
    const { backend } = createBackend()
    const watching = deferred<void>()
    backend.watchRepository = vi.fn(() => watching.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.watchRepository).toHaveBeenCalledWith('/repo')
    })
    const rendersBeforeDestroy = testMocks.fileViewCallbacks.length
    await app.destroy()
    const stopsBeforeLateWatcher = vi.mocked(backend.stopWatchingRepository).mock.calls.length
    watching.resolve()
    await startup

    expect(vi.mocked(backend.stopWatchingRepository).mock.calls.length)
      .toBe(stopsBeforeLateWatcher + 1)
    expect(backend.inspectPsLibrary).not.toHaveBeenCalled()
    expect(testMocks.fileViewCallbacks).toHaveLength(rendersBeforeDestroy)
  })

  it('starts Ps inspection only after repository watching finishes', async () => {
    const { backend } = createBackend()
    const watching = deferred<void>()
    backend.watchRepository = vi.fn(() => watching.promise)
    const app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: rememberedStorage() as unknown as Storage,
    })
    const startup = app.start()

    await vi.waitFor(() => {
      expect(backend.watchRepository).toHaveBeenCalledWith('/repo')
    })
    expect(backend.inspectPsLibrary).not.toHaveBeenCalled()

    watching.resolve()
    await startup
    expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
    expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
    await app.destroy()
  })

  it('loads Ps metadata even when repository watching is unavailable', async () => {
    const { backend } = createBackend()
    backend.watchRepository = vi.fn().mockRejectedValue(new Error('watch unavailable'))
    const app = await startApp(dom, backend)

    await Promise.resolve()
    expect(backend.inspectPsLibrary).toHaveBeenCalledOnce()
    expect(backend.inspectPsLibrary).toHaveBeenCalledWith('/repo')
    await app.destroy()
  })

  it('pauses update polling while hidden and resumes on visibility return', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = createBackend()
      const app = await startApp(dom, backend)
      await Promise.resolve()
      expect(backend.checkForUpdate).toHaveBeenCalledOnce()

      dom.document.visibilityState = 'hidden'
      dom.document.dispatch('visibilitychange')
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2)
      expect(backend.checkForUpdate).toHaveBeenCalledOnce()

      dom.document.visibilityState = 'visible'
      dom.document.dispatch('visibilitychange')
      expect(backend.checkForUpdate).toHaveBeenCalledTimes(2)
      await app.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('focuses the file search field from the platform file-search shortcut', async () => {
    const restoreNavigator = setNavigatorPlatform('Linux x86_64')
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    try {
      const search = dom.root.querySelector<FakeElement>('#file-search')
      const event = {
        key: 'o',
        code: 'KeyO',
        shiftKey: true,
        altKey: true,
        metaKey: false,
        ctrlKey: false,
        target: null,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent

      dom.window.dispatch('keydown', event)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(dom.document.activeElement).toBe(search)
    } finally {
      await app.destroy()
      restoreNavigator()
    }
  })

  it('focuses the shared file-search field from the editor and global project-search shortcut', async () => {
    const restoreNavigator = setNavigatorPlatform('Linux x86_64')
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    try {
      const search = dom.root.querySelector<FakeElement>('#file-search')
      const controller = testMocks.contentSearchControllers.at(-1)!
      testMocks.editorInstances.at(-1)?.triggerProjectSearch()
      expect(dom.document.activeElement).toBe(search)

      const event = {
        key: 'ƒ',
        code: 'KeyF',
        shiftKey: true,
        altKey: true,
        metaKey: false,
        ctrlKey: false,
        target: null,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent
      dom.window.dispatch('keydown', event)

      expect(dom.document.activeElement).toBe(search)
      expect(event.preventDefault).toHaveBeenCalledOnce()

      controller.update.mockClear()
      search.value = 'Q1'
      search.dispatch('input', { target: search })
      expect(controller.update).toHaveBeenLastCalledWith('Q1', [file.path])
      expect(dom.root.querySelector<FakeElement>('#file-results-viewport').classList.contains('is-searching')).toBe(true)
    } finally {
      await app.destroy()
      restoreNavigator()
    }
  })

  it('re-finds an editable hit in the current source before revealing it', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockResolvedValue('return true;')
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 1,
      column: 1,
      preview: 'return true;',
    }
    try {
      expect(controller.options.canNavigate(match)).toBe(true)
      expect(controller.options.canNavigate({ ...match, path: 'README.md' })).toBe(false)
      setFileSearchQuery(dom, 'return true')
      testMocks.fileViewCallbacks.at(-1)?.onFileSelect(file)
      await vi.waitFor(() => {
        expect((app as unknown as { state: { selectedPath: string | null } }).state.selectedPath).toBe(file.path)
      })
      testMocks.editorInstances.at(-1)?.emitChange('new prefix\nreturn true;')
      await controller.options.onNavigate(match, 'return true')

      expect(backend.readProblemFile).toHaveBeenCalledWith('/repo', file.path)
      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([{ line: 2, column: 1 }])
    } finally {
      await app.destroy()
    }
  })

  it('does not reveal an editable hit after its text was removed from the current source', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockResolvedValue('return true;')
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 1,
      column: 1,
      preview: 'return true;',
    }
    try {
      setFileSearchQuery(dom, 'return true')
      testMocks.fileViewCallbacks.at(-1)?.onFileSelect(file)
      await vi.waitFor(() => {
        expect((app as unknown as { state: { selectedPath: string | null } }).state.selectedPath).toBe(file.path)
      })
      testMocks.editorInstances.at(-1)?.emitChange('the result has been removed')
      await expect(controller.options.onNavigate(match, 'return true'))
        .rejects.toThrow('Matching text changed; search again.')

      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([])
    } finally {
      await app.destroy()
    }
  })

  it('avoids revealing a failed content-hit navigation', async () => {
    const { backend } = createBackend()
    vi.mocked(backend.readProblemFile).mockRejectedValue(new Error('missing'))
    const app = await startApp(dom, backend)
    const controller = testMocks.contentSearchControllers.at(-1)!
    const match: ProjectSearchMatch = {
      path: file.path,
      line: 3,
      column: 7,
      preview: 'return true;',
    }
    try {
      setFileSearchQuery(dom, 'return true')
      await expect(controller.options.onNavigate(match, 'return true')).rejects.toThrow('Could not open')

      expect(testMocks.editorInstances.at(-1)?.revealedLocations).toEqual([])
    } finally {
      await app.destroy()
    }
  })
})

function deferred<T>(): {
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

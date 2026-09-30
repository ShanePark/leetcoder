import { afterEach, beforeEach, vi } from 'vitest'

import type {
  ProblemFileEntry,
  ProjectSearchMatch,
  PsLibraryMetadata,
} from '../../../src/backend'

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

export { testMocks }

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

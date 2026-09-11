import { describe, expect, it, vi } from 'vitest'

import type { DailyProblem } from '../../../src/backend'
import type { ProblemDefinition, ProblemFilePlan } from '../../../src/domain'
import {
  FileOperationsController,
  type FileOperationsBackend,
  type FileOperationsDocument,
  type FileOperationsGit,
  type FileOperationsState,
} from '../../../src/app/file-operations-controller'
import type { GitChangedFile, OpenFileTab } from '../../../src/app/types'
import type { ProblemFileEntry } from '../../../src/backend'

const repoPath = '/repo'

function file(path: string, name = path.slice(path.lastIndexOf('/') + 1)): ProblemFileEntry {
  return { path, name, packageSegment: 'easy' }
}

function problem(frontendId: string, title: string): DailyProblem {
  return {
    date: '2026-09-10',
    frontendId,
    title,
    titleSlug: title.toLocaleLowerCase().replaceAll(' ', '-'),
    difficulty: 'Easy',
    url: `https://leetcode.com/problems/${frontendId}/`,
    javaSnippet: 'class Solution {}',
    content: null,
  }
}

function plan(path: string, name = path.slice(path.lastIndexOf('/') + 1)): ProblemFilePlan {
  return {
    problemNumber: '1',
    title: 'Two Sum',
    difficulty: 'EASY',
    baseClassName: 'Q1TwoSum',
    className: name.replace(/\.java$/i, ''),
    packageSegment: 'easy',
    packageName: 'shane.leetcode.problems.easy',
    fullyQualifiedClassName: `shane.leetcode.problems.easy.${name.replace(/\.java$/i, '')}`,
    fileName: name,
    path,
    methodSignature: null,
    source: 'class Q1TwoSum {}',
  }
}

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

interface Harness {
  controller: FileOperationsController
  state: FileOperationsState
  backend: FileOperationsBackend
  document: FileOperationsDocument & {
    flushPendingSave: ReturnType<typeof vi.fn>
    openFile: ReturnType<typeof vi.fn>
    applySavedSource: ReturnType<typeof vi.fn>
    beginGitDiscard: ReturnType<typeof vi.fn>
    endGitDiscard: ReturnType<typeof vi.fn>
    cancelPendingAutosave: ReturnType<typeof vi.fn>
  }
  git: FileOperationsGit & {
    finishOperation: ReturnType<typeof vi.fn>
    markStale: ReturnType<typeof vi.fn>
    refreshStatus: ReturnType<typeof vi.fn>
  }
  refreshFiles: ReturnType<typeof vi.fn>
  createProblem: ReturnType<typeof vi.fn>
  setGitFiles: (files: readonly GitChangedFile[]) => void
  messages: Array<{ message: string; tone: string }>
}

function harness(overrides: Partial<FileOperationsState> = {}): Harness {
  const state: FileOperationsState = {
    repoPath,
    projectValid: true,
    files: [],
    dailyProblem: null,
    openTabs: [],
    activeTabId: null,
    selectedPath: null,
    selectedFqcn: null,
    busy: false,
    ...overrides,
  }
  const flushPendingSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const openFile = vi.fn<(entry: ProblemFileEntry) => Promise<void>>().mockResolvedValue(undefined)
  const applySavedSource = vi.fn<(source: string) => void>((source) => {
    state.selectedSource = source
  })
  const beginGitDiscard = vi.fn()
  const endGitDiscard = vi.fn()
  const cancelPendingAutosave = vi.fn()

  const document: Harness['document'] = {
    flushPendingSave,
    cancelPendingAutosave,
    openTabForPath: (path) => state.openTabs.find((tab) => tab.path === path) ?? null,
    removeOpenTab: (tabId) => {
      const index = state.openTabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) {
        return null
      }
      const wasActive = state.activeTabId === tabId
      const [removed] = state.openTabs.splice(index, 1)
      if (!wasActive) {
        return null
      }
      state.activeTabId = null
      state.selectedPath = null
      return state.openTabs[index] ?? state.openTabs[index - 1] ?? null
    },
    resetCurrentFile: () => {
      state.activeTabId = null
      state.selectedPath = null
    },
    openFile,
    beginGitDiscard,
    endGitDiscard,
    applySavedSource,
  }

  const backend: FileOperationsBackend = {
    listProblemFiles: vi.fn().mockResolvedValue([]),
    readProblemFile: vi.fn().mockResolvedValue('restored source'),
    createProblemFile: vi.fn().mockResolvedValue(undefined),
    discardGitChanges: vi.fn().mockResolvedValue(undefined),
    showInFileManager: vi.fn().mockResolvedValue(undefined),
    deleteProblemFile: vi.fn().mockResolvedValue(undefined),
    duplicateProblemFile: vi.fn().mockResolvedValue({}),
    renameProblemFile: vi.fn().mockResolvedValue({}),
  }

  let gitOperationId = 0
  let activeGitOperation: { id: number; repoPath: string; repositoryGeneration: number } | null = null
  const git: Harness['git'] = {
    startOperation: (label) => {
      if (state.busy) {
        return null
      }
      activeGitOperation = { id: ++gitOperationId, repoPath, repositoryGeneration: 1 }
      state.busy = true
      void label
      return activeGitOperation
    },
    isCurrentOperation: (token) => activeGitOperation?.id === token.id,
    finishOperation: vi.fn((token) => {
      if (activeGitOperation?.id !== token.id) {
        return
      }
      activeGitOperation = null
      state.busy = false
    }),
    markStale: vi.fn(),
    refreshStatus: vi.fn().mockResolvedValue(undefined),
  }
  const refreshFiles = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const createProblem = vi.fn<(path: string, value: ProblemDefinition) => Promise<ProblemFilePlan>>()
  let gitFiles: readonly GitChangedFile[] = []
  const messages: Harness['messages'] = []
  const hooks: FileOperationsControllerHooks = {
    state,
    backend,
    document,
    git,
    createProblem,
    refreshFiles,
    repositoryGeneration: () => 1,
    getGitFiles: () => gitFiles,
    setAppBusy: (busy) => {
      state.busy = busy
    },
    render: vi.fn(),
    setMessage: (message, tone) => messages.push({ message, tone }),
    isDestroyed: () => false,
  }
  return {
    controller: new FileOperationsController(hooks),
    state,
    backend,
    document,
    git,
    refreshFiles,
    createProblem,
    setGitFiles: (files) => {
      gitFiles = files
    },
    messages,
  }
}

describe('FileOperationsController', () => {
  it('captures the selected daily problem before flushing pending saves', async () => {
    const selected = problem('1', 'Two Sum')
    const changed = problem('2', 'Add Two Numbers')
    const created = file('src/main/java/easy/Q1TwoSum.java')
    const h = harness({ dailyProblem: selected })
    h.document.flushPendingSave.mockImplementation(async () => {
      h.state.dailyProblem = changed
      return true
    })
    h.createProblem.mockResolvedValue(plan(created.path, created.name))
    h.refreshFiles.mockImplementation(async () => {
      h.state.files = [created]
      return true
    })

    await h.controller.createFileForToday()

    expect(h.createProblem).toHaveBeenCalledWith(repoPath, {
      number: '1',
      title: 'Two Sum',
      difficulty: 'Easy',
      javaCodeSnippet: 'class Solution {}',
    })
    expect(h.document.openFile).toHaveBeenCalledWith(created)
    expect(h.state.busy).toBe(false)
  })

  it('aborts a delete when pending save fails and releases the busy lock', async () => {
    const target = file('src/main/java/easy/Q1TwoSum.java')
    const h = harness({ files: [target] })
    h.document.flushPendingSave.mockResolvedValue(false)

    await h.controller.deleteFile(target)

    expect(h.backend.deleteProblemFile).not.toHaveBeenCalled()
    expect(h.state.busy).toBe(false)
    expect(h.git.markStale).not.toHaveBeenCalled()
  })

  it('deletes the active tab and opens the adjacent replacement', async () => {
    const target = file('src/main/java/easy/Q1TwoSum.java')
    const replacement = file('src/main/java/easy/Q20ValidParentheses.java')
    const targetTab: OpenFileTab = { id: 1, ...target }
    const replacementTab: OpenFileTab = { id: 2, ...replacement }
    const h = harness({
      files: [target, replacement],
      openTabs: [targetTab, replacementTab],
      activeTabId: targetTab.id,
      selectedPath: target.path,
    })
    h.refreshFiles.mockImplementation(async () => {
      h.state.files = [replacement]
      return true
    })

    await h.controller.deleteFile(target)

    expect(h.backend.deleteProblemFile).toHaveBeenCalledWith(repoPath, target.path)
    expect(h.document.openFile).toHaveBeenCalledWith(replacement)
    expect(h.messages.at(-1)?.message).toBe(`Deleted ${target.name}.`)
    expect(h.state.busy).toBe(false)
  })

  it('finds and opens the actual duplicate path returned after refresh', async () => {
    const original = file('src/main/java/easy/Q1TwoSum.java')
    const duplicate = file('src/main/java/easy/Q1TwoSum2.java')
    const h = harness({ files: [original] })
    h.backend.duplicateProblemFile = vi.fn().mockResolvedValue({ relativePath: duplicate.path, content: 'copy' })
    h.refreshFiles.mockImplementation(async () => {
      h.state.files = [original, duplicate]
      return true
    })

    await h.controller.duplicateFile(original)

    expect(h.backend.duplicateProblemFile).toHaveBeenCalledWith(repoPath, original.path)
    expect(h.document.openFile).toHaveBeenCalledWith(duplicate)
    expect(h.messages.at(-1)?.message).toBe(`Duplicated ${original.name} as ${duplicate.name}.`)
  })

  it('updates the active tab to the path returned by rename', async () => {
    const original = file('src/main/java/easy/Q1TwoSum.java')
    const renamed = file('src/main/java/easy/Q1Renamed.java')
    const tab: OpenFileTab = { id: 1, ...original }
    const h = harness({
      files: [original],
      openTabs: [tab],
      activeTabId: tab.id,
      selectedPath: original.path,
    })
    h.backend.renameProblemFile = vi.fn().mockResolvedValue({ relativePath: renamed.path, content: 'renamed' })
    h.refreshFiles.mockImplementation(async () => {
      h.state.files = [renamed]
      return true
    })

    await h.controller.renameFile(original, renamed.name)

    expect(h.backend.renameProblemFile).toHaveBeenCalledWith(repoPath, original.path, renamed.name)
    expect(tab.path).toBe(renamed.path)
    expect(h.document.openFile).toHaveBeenCalledWith(renamed)
    expect(h.messages.at(-1)?.message).toBe(`Renamed ${original.name} to ${renamed.name}.`)
  })

  it('restores a staged rename and keeps the existing tab identity', async () => {
    const original = file('src/main/java/easy/Q1TwoSum.java')
    const destination = file('src/main/java/easy/Q1Renamed.java')
    const tab: OpenFileTab = { id: 7, ...destination }
    const change: GitChangedFile = {
      path: destination.path,
      originalPath: original.path,
      status: 'R',
      staged: true,
      additions: null,
      deletions: null,
    }
    const h = harness({
      files: [destination],
      openTabs: [tab],
      activeTabId: tab.id,
      selectedPath: destination.path,
      selectedFqcn: 'shane.leetcode.problems.easy.Q1Renamed',
    })
    h.backend.readProblemFile = vi.fn().mockResolvedValue('original source')
    h.refreshFiles.mockImplementation(async () => {
      h.state.files = [original]
      return true
    })
    h.setGitFiles([change])

    await h.controller.discardGitChanges(change)

    expect(h.document.beginGitDiscard).toHaveBeenCalledTimes(1)
    expect(h.document.cancelPendingAutosave).toHaveBeenCalledTimes(1)
    expect(h.document.applySavedSource).toHaveBeenCalledWith('original source')
    expect(tab.path).toBe(original.path)
    expect(h.state.selectedPath).toBe(original.path)
    expect(h.document.endGitDiscard).toHaveBeenCalledTimes(1)
    expect(h.messages.at(-1)?.message).toBe(`Discarded changes to ${destination.name}.`)
  })

  it('keeps Git autosave suppression active while discard is awaiting the backend', async () => {
    const target = file('src/main/java/easy/Q1TwoSum.java')
    const change: GitChangedFile = {
      path: target.path,
      status: 'M',
      staged: false,
      additions: 1,
      deletions: 0,
    }
    const h = harness({ files: [target], selectedPath: target.path })
    const pendingDiscard = deferred<void>()
    h.backend.discardGitChanges = vi.fn().mockReturnValue(pendingDiscard.promise)
    h.setGitFiles([change])
    const operation = h.controller.discardGitChanges(change)
    await Promise.resolve()
    await Promise.resolve()

    expect(h.document.beginGitDiscard).toHaveBeenCalledTimes(1)
    expect(h.document.endGitDiscard).not.toHaveBeenCalled()
    expect(h.document.cancelPendingAutosave).toHaveBeenCalledTimes(1)

    pendingDiscard.resolve()
    await operation

    expect(h.document.endGitDiscard).toHaveBeenCalledTimes(1)
    expect(h.state.busy).toBe(false)
  })
})

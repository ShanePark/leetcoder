import { describe, expect, it, vi } from 'vitest'

import {
  GitController,
  createGitState,
  type GitControllerHooks,
  type GitRepositoryContext,
} from '../../../src/app/git-controller'
import type { GitBackendClient } from '../../../src/app/types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function harness(
  backend: GitBackendClient,
  context: GitRepositoryContext = {
    repoPath: '/repo',
    projectValid: true,
    repositoryGeneration: 1,
    appBusy: false,
  },
): {
  controller: GitController
  context: GitRepositoryContext
  hooks: GitControllerHooks
  renders: string[]
  messages: Array<{ message: string; tone: string }>
} {
  const renders: string[] = []
  const messages: Array<{ message: string; tone: string }> = []
  const hooks: GitControllerHooks = {
    getContext: () => context,
    flushPendingSave: vi.fn().mockResolvedValue(true),
    setAppBusy: (busy) => {
      context.appBusy = busy
    },
    render: () => {
      renders.push(controller.progressLabel ?? '')
    },
    renderPanel: () => {
      renders.push(controller.progressLabel ?? '')
    },
    isGitPanelVisible: () => true,
    isWindowVisible: () => true,
    isDestroyed: () => false,
    setMessage: (message, tone) => messages.push({ message, tone }),
  }
  const controller = new GitController(backend, hooks, createGitState())
  return { controller, context, hooks, renders, messages }
}

describe('GitController', () => {
  it('loads and guards a status snapshot and its active diff', async () => {
    const backend: GitBackendClient = {
      listGitChanges: vi.fn().mockResolvedValue(' M Q1.java\n?? Q2.java'),
      getGitDiff: vi.fn().mockResolvedValue(
        'diff --git a/Q1.java b/Q1.java\n@@ -1 +1 @@\n-old\n+new',
      ),
    }
    const { controller } = harness(backend)

    await controller.refreshStatus()

    expect(controller.state.files.map((file) => file.path)).toEqual(['Q1.java', 'Q2.java'])
    expect(controller.state.selectedPaths).toEqual(['Q1.java', 'Q2.java'])
    expect(controller.state.activePath).toBe('Q1.java')
    expect(controller.state.diffByPath['Q1.java']).toContain('+new')
    expect(controller.state.loading).toBe(false)
    expect(controller.state.diffLoading).toBe(false)
  })

  it('keeps an in-flight status response from an older repository out of state', async () => {
    const status = deferred<unknown>()
    const backend: GitBackendClient = {
      listGitChanges: vi.fn(() => status.promise),
    }
    const { controller, context } = harness(backend)

    const request = controller.refreshStatus()
    context.repoPath = '/other-repo'
    context.repositoryGeneration = 2
    status.resolve(' M stale.java')
    await request

    expect(controller.state.files).toEqual([])
    expect(controller.state.loading).toBe(true)
  })

  it('reports commit-and-push phases and restores app controls', async () => {
    const commit = deferred<unknown>()
    const push = deferred<unknown>()
    const backend: GitBackendClient = {
      commitGit: vi.fn(() => commit.promise),
      pushGit: vi.fn(() => push.promise),
      listGitChanges: vi.fn().mockResolvedValue({ branch: 'main', changes: [] }),
    }
    const { controller, hooks, renders, messages } = harness(backend)
    controller.state.files = [{
      path: 'Q1.java',
      status: 'modified',
      staged: false,
      additions: 1,
      deletions: 0,
    }]
    controller.state.selectedPaths = ['Q1.java']
    controller.state.commitMessage = 'Save Q1'

    const operation = controller.commitSelectedFiles(true)
    expect(controller.state.busy).toBe(true)
    expect(controller.progressLabel).toBe('Preparing commit and push…')
    expect(hooks.flushPendingSave).toHaveBeenCalled()

    await Promise.resolve()
    expect(backend.commitGit).toHaveBeenCalledWith('/repo', ['Q1.java'], 'Save Q1')
    expect(controller.progressLabel).toBe('Committing changes…')

    commit.resolve({ commitHash: 'abc1234', message: 'Save Q1', paths: ['Q1.java'] })
    await Promise.resolve()
    expect(backend.pushGit).toHaveBeenCalledWith('/repo')
    expect(controller.progressLabel).toBe('Pushing changes…')

    push.resolve({ branch: 'main', output: '' })
    await operation

    expect(backend.listGitChanges).toHaveBeenCalledWith('/repo')
    expect(messages).toEqual([{
      message: 'Committed abc1234 · Pushed to origin/main',
      tone: 'success',
    }])
    expect(controller.state.busy).toBe(false)
    expect(controller.progressLabel).toBeNull()
    expect(renders.at(-1)).toBe('')
  })

  it('refreshes after a push failure and preserves the actionable error', async () => {
    const backend: GitBackendClient = {
      commitGit: vi.fn().mockResolvedValue({ commitHash: 'abc1234', message: 'Save Q1', paths: ['Q1.java'] }),
      pushGit: vi.fn().mockRejectedValue(new Error('remote rejected the update')),
      listGitChanges: vi.fn().mockResolvedValue({ branch: 'main', changes: [] }),
    }
    const { controller, messages } = harness(backend)
    controller.state.files = [{ path: 'Q1.java', status: 'modified', staged: false, additions: 1, deletions: 0 }]
    controller.state.selectedPaths = ['Q1.java']

    await controller.commitSelectedFiles(true)

    expect(controller.state.error).toBe('remote rejected the update')
    expect(messages).toEqual([{
      message: 'Committed, but could not push: remote rejected the update',
      tone: 'error',
    }])
    expect(controller.state.busy).toBe(false)
  })

  it('debounces stale status refreshes while the Git panel is visible', async () => {
    vi.useFakeTimers()
    try {
      const backend: GitBackendClient = {
        listGitChanges: vi.fn().mockResolvedValue([]),
      }
      const { controller } = harness(backend)

      controller.markStale()
      expect(backend.listGitChanges).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(250)

      expect(backend.listGitChanges).toHaveBeenCalledWith('/repo')
    } finally {
      vi.useRealTimers()
    }
  })
})

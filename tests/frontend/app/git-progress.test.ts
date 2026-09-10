import { describe, expect, it, vi } from 'vitest'

import {
  createGitState,
  GitController,
  type GitControllerHooks,
  type GitRepositoryContext,
} from '../../../src/app/git-controller'
import type { GitBackendClient } from '../../../src/app/types'
import { updateGitCommitControls } from '../../../src/app/git-view'

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function controlsRoot(): {
  root: HTMLElement
  input: HTMLInputElement
  commit: HTMLButtonElement
  commitPush: HTMLButtonElement
} {
  const input = { value: '', placeholder: '', disabled: false }
  const commit = { disabled: false }
  const commitPush = { disabled: false }
  const elements = new Map<string, object>([
    ['#git-commit-message', input],
    ['#git-commit', commit],
    ['#git-commit-push', commitPush],
    ['#git-select-all', { disabled: false }],
    ['#git-select-none', { disabled: false }],
  ])
  const root = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
  } as unknown as HTMLElement
  return {
    root,
    input: input as unknown as HTMLInputElement,
    commit: commit as unknown as HTMLButtonElement,
    commitPush: commitPush as unknown as HTMLButtonElement,
  }
}

function appHarness(options: {
  commit: () => Promise<unknown>
  push?: () => Promise<unknown>
}): {
  controller: GitController
  controls: ReturnType<typeof controlsRoot>
  progress: Array<string | null | undefined>
  messages: Array<{ message: string; tone: string }>
} {
  const controls = controlsRoot()
  const file = {
    path: 'Q1.java',
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 0,
  }
  const progress: Array<string | null | undefined> = []
  const messages: Array<{ message: string; tone: string }> = []
  const backend: GitBackendClient = {
    commitGit: options.commit,
    pushGit: options.push,
    listGitChanges: vi.fn().mockResolvedValue({ branch: 'main', changes: [file] }),
  }
  const context: GitRepositoryContext = {
    repoPath: '/repo',
    projectValid: true,
    repositoryGeneration: 1,
    appBusy: false,
  }
  let controller: GitController
  const recordProgress = (label: string | null): void => {
    if (progress.at(-1) !== label) {
      progress.push(label)
    }
  }
  const hooks: GitControllerHooks = {
    getContext: () => context,
    flushPendingSave: vi.fn().mockResolvedValue(true),
    setAppBusy: (busy) => {
      context.appBusy = busy
    },
    render: () => {
      recordProgress(controller.progressLabel)
      updateGitCommitControls(controls.root, {
        bottomPanelTab: 'git',
        busy: context.appBusy,
        git: controller.state,
        operationLabel: controller.progressLabel,
      })
    },
    renderPanel: () => {
      recordProgress(controller.progressLabel)
    },
    isGitPanelVisible: () => true,
    isWindowVisible: () => true,
    isDestroyed: () => false,
    setMessage: (message, tone) => messages.push({ message, tone }),
  }
  controller = new GitController(backend, hooks, createGitState())
  controller.state.files = [file]
  controller.state.selectedPaths = ['Q1.java']
  controller.state.activePath = 'Q1.java'
  controller.state.commitMessage = 'Save Q1'
  controller.state.commitMessageEdited = true
  hooks.render()
  progress.length = 0
  return { controller, controls, progress, messages }
}

describe('Git commit progress', () => {
  it('disables commit controls immediately and reports each commit-and-push phase', async () => {
    const commit = deferred<unknown>()
    const push = deferred<unknown>()
    const commitMethod = vi.fn(() => commit.promise)
    const pushMethod = vi.fn(() => push.promise)
    const { controller, controls, progress, messages } = appHarness({ commit: commitMethod, push: pushMethod })

    const operation = controller.commitSelectedFiles(true)

    expect(controller.state.busy).toBe(true)
    expect(controller.progressLabel).toBe('Preparing commit and push…')
    expect(controls.input.disabled).toBe(true)
    expect(controls.commit.disabled).toBe(true)
    expect(controls.commitPush.disabled).toBe(true)

    await flushMicrotasks()
    expect(commitMethod).toHaveBeenCalledWith('/repo', ['Q1.java'], 'Save Q1')
    expect(controller.progressLabel).toBe('Committing changes…')

    commit.resolve({ commitHash: 'abc1234', message: 'Save Q1', paths: ['Q1.java'] })
    await flushMicrotasks()
    expect(pushMethod).toHaveBeenCalledWith('/repo')
    expect(controller.progressLabel).toBe('Pushing changes…')

    push.resolve({ branch: 'main', output: '' })
    await operation

    expect(messages).toEqual([{
      message: 'Committed abc1234 · Pushed to origin/main',
      tone: 'success',
    }])
    expect(progress).toEqual([
      'Preparing commit and push…',
      'Committing changes…',
      'Pushing changes…',
      'Refreshing Git status…',
      null,
    ])
    expect(controller.state.busy).toBe(false)
    expect(controller.progressLabel).toBeNull()
    expect(controls.input.disabled).toBe(false)
    expect(controls.commit.disabled).toBe(false)
    expect(controls.commitPush.disabled).toBe(false)
  })

  it('restores controls and preserves the failure after a push error', async () => {
    const pushError = new Error('remote rejected the update')
    const { controller, controls, progress, messages } = appHarness({
      commit: vi.fn().mockResolvedValue({ commitHash: 'abc1234', message: 'Save Q1', paths: ['Q1.java'] }),
      push: vi.fn().mockRejectedValue(pushError),
    })

    await controller.commitSelectedFiles(true)

    expect(controller.state.busy).toBe(false)
    expect(controller.progressLabel).toBeNull()
    expect(controller.state.error).toBe('remote rejected the update')
    expect(controls.input.disabled).toBe(false)
    expect(controls.commit.disabled).toBe(false)
    expect(controls.commitPush.disabled).toBe(false)
    expect(messages).toContainEqual({
      message: 'Committed, but could not push: remote rejected the update',
      tone: 'error',
    })
    expect(progress).toContain('Pushing changes…')
    expect(progress.at(-1)).toBeNull()
  })
})

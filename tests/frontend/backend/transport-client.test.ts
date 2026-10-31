import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  normalizeUpdateBuild,
  normalizeUpdateStatus,
  type Invoke,
  type Listen,
  type RepositoryFilesChanged,
} from '../../../src/backend'

describe('backend client', () => {
  it('normalizes local update status and accepts the Rust snake-case shape', () => {
    expect(normalizeUpdateStatus({
      supported: true,
      available: true,
      current_commit: 'old',
      latest_commit: 'new',
    })).toEqual({
      supported: true,
      available: true,
      currentCommit: 'old',
      latestCommit: 'new',
    })
    expect(normalizeUpdateStatus({ currentCommit: 'same', latestCommit: 'same' })).toEqual({
      supported: true,
      available: false,
      currentCommit: 'same',
      latestCommit: 'same',
    })
  })

  it('normalizes the staged update build and rejects a missing commit', () => {
    expect(normalizeUpdateBuild({ commit: 'abc1234' })).toEqual({ commit: 'abc1234' })
    expect(() => normalizeUpdateBuild({ commit: '' })).toThrow('The update build response was invalid.')
    expect(() => normalizeUpdateBuild(null)).toThrow('The update build response was invalid.')
  })

  it('invokes the native update commands', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      if (command === 'check_for_update') {
        return { supported: true, available: false, currentCommit: 'same', latestCommit: 'same' }
      }
      if (command === 'build_update') return { commit: 'abc1234' }
      if (command === 'apply_update') return undefined
      throw new Error(`unexpected command ${command}`)
    }
    const backend = createBackendClient(invoke)
    await expect(backend.checkForUpdate()).resolves.toMatchObject({ supported: true })
    await expect(backend.buildUpdate()).resolves.toEqual({ commit: 'abc1234' })
    await expect(backend.applyUpdate()).resolves.toBeUndefined()
    expect(calls).toEqual([
      { command: 'check_for_update', args: undefined },
      { command: 'build_update', args: undefined },
      { command: 'apply_update', args: undefined },
    ])
  })
})

describe('repository watcher bridge', () => {
  const noopListen: Listen = async () => () => {}

  it('starts and stops the watcher with the repository path', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      return undefined as never
    }
    const client = createBackendClient(invoke, noopListen)

    await client.watchRepository('/home/shane/leetcode')
    await client.stopWatchingRepository()

    expect(calls).toEqual([
      { command: 'watch_repository', args: { repoPath: '/home/shane/leetcode' } },
      { command: 'unwatch_repository', args: undefined },
    ])
  })

  it('forwards watcher payloads and hands back the unsubscribe function', async () => {
    let emit: ((message: { payload: unknown }) => void) | null = null
    let unsubscribed = false
    const listen: Listen = async (event, handler) => {
      expect(event).toBe('repository-files-changed')
      emit = handler
      return () => {
        unsubscribed = true
      }
    }
    const seen: RepositoryFilesChanged[] = []
    const client = createBackendClient(async () => undefined as never, listen)

    const unsubscribe = await client.onRepositoryFilesChanged((change) => seen.push(change))
    emit!({ payload: { paths: ['src/Q1.java'], structural: true } })
    emit!({ payload: { paths: ['src/Q2.java'] } })

    expect(seen).toEqual([
      { paths: ['src/Q1.java'], structural: true },
      { paths: ['src/Q2.java'], structural: false },
    ])

    unsubscribe()
    expect(unsubscribed).toBe(true)
  })

  it('ignores watcher payloads that carry no usable paths', async () => {
    let emit: ((message: { payload: unknown }) => void) | null = null
    const listen: Listen = async (_event, handler) => {
      emit = handler
      return () => {}
    }
    let received = 0
    const client = createBackendClient(async () => undefined as never, listen)

    await client.onRepositoryFilesChanged(() => {
      received += 1
    })
    emit!({ payload: null })
    emit!({ payload: { structural: true } })
    emit!({ payload: { paths: [] } })
    emit!({ payload: { paths: [7, null] } })

    expect(received).toBe(0)
  })
})

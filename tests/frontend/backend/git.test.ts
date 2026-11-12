import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  normalizeGitChanges,
  normalizeGitCommitResult,
  normalizeGitDiff,
  normalizeGitPullResult,
  normalizeGitPushResult,
  type Invoke,
} from '../../../src/backend'

describe('backend client', () => {
  it('normalizes Git status paths and preserves staged/worktree columns', () => {
    expect(normalizeGitChanges({ changes: [{
      path: 'src/a file.java',
      status: 'MM',
      index_status: 'M',
      worktreeStatus: 'M',
      original_path: 'src/old file.java',
    }] })).toEqual([{
      path: 'src/a file.java',
      status: 'MM',
      indexStatus: 'M',
      worktreeStatus: 'M',
      originalPath: 'src/old file.java',
    }])
  })

  it('invokes Git actions with explicit arguments', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      if (command === 'discard_git_changes' || command === 'show_in_file_manager') return undefined
      if (command === 'get_git_diff') return 'diff --git a/Q1.java b/Q1.java\n'
      if (command === 'commit_git') {
        return { commitHash: 'abc123', message: 'Create Q1.java', paths: ['Q1.java'] }
      }
      if (command === 'pull_git') return { updated: true, output: 'Fast-forward' }
      if (command === 'push_git') return { output: 'done', branch: 'main' }
      if (command === 'count_unpushed_git_commits') return 2
      throw new Error(`unexpected command ${command}`)
    }
    const backend = createBackendClient(invoke)

    await expect(backend.discardGitChanges('/repo', 'Q1.java')).resolves.toBeUndefined()
    await expect(backend.showInFileManager('/repo', 'Q1.java')).resolves.toBeUndefined()
    await expect(backend.getGitDiff('/repo', ['Q1.java'])).resolves.toContain('diff --git')
    await expect(backend.commitGit('/repo', ['Q1.java'], 'Create Q1.java')).resolves.toMatchObject({
      commitHash: 'abc123',
    })
    await expect(backend.pullGit('/repo')).resolves.toEqual({ updated: true, output: 'Fast-forward' })
    await expect(backend.pushGit('/repo')).resolves.toMatchObject({ branch: 'main' })
    await expect(backend.countUnpushedGitCommits('/repo')).resolves.toBe(2)
    expect(calls).toEqual([
      { command: 'discard_git_changes', args: { repoPath: '/repo', path: 'Q1.java' } },
      { command: 'show_in_file_manager', args: { repoPath: '/repo', path: 'Q1.java' } },
      { command: 'get_git_diff', args: { repoPath: '/repo', paths: ['Q1.java'] } },
      { command: 'commit_git', args: { repoPath: '/repo', paths: ['Q1.java'], message: 'Create Q1.java' } },
      { command: 'pull_git', args: { repoPath: '/repo' } },
      { command: 'push_git', args: { repoPath: '/repo' } },
      { command: 'count_unpushed_git_commits', args: { repoPath: '/repo' } },
    ])
  })

  it('accepts legacy-compatible Git response shapes', () => {
    expect(normalizeGitDiff({ patch: 'patch' })).toBe('patch')
    expect(normalizeGitCommitResult({ hash: 'deadbeef', files: ['Q1.java'] })).toMatchObject({
      commitHash: 'deadbeef',
      paths: ['Q1.java'],
    })
    expect(normalizeGitPushResult('pushed')).toEqual({ output: 'pushed', branch: null })
  })

  it('rejects a pull response without an update flag', () => {
    expect(normalizeGitPullResult({ updated: false })).toEqual({ updated: false, output: '' })
    expect(() => normalizeGitPullResult({ output: 'done' })).toThrow('Git pull response was invalid')
  })

  it('rejects an invalid unpushed commit count', async () => {
    const backend = createBackendClient(async () => -1)
    await expect(backend.countUnpushedGitCommits('/repo')).rejects.toThrow('unpushed commit count was invalid')
  })
})

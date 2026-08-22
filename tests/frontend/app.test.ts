import { describe, expect, it, vi } from 'vitest'

import {
  AutosaveCoordinator,
  filterProblemFiles,
  filterProblemFilesByGroup,
  fqcnFromJavaPath,
  isCurrentRepositoryRefresh,
} from '../../src/app'
import type { ProblemFileEntry } from '../../src/backend'

describe('fqcnFromJavaPath', () => {
  it('converts a repository-relative Java path to its FQCN', () => {
    expect(fqcnFromJavaPath(
      'src/main/java/shane/leetcode/problems/easy/Q3622CheckDivisibility.java',
    )).toBe('shane.leetcode.problems.easy.Q3622CheckDivisibility')
  })

  it('handles Windows separators and an absolute repository path', () => {
    expect(fqcnFromJavaPath(
      'C:\\Users\\shane\\ps\\src\\main\\java\\shane\\leetcode\\problems\\xhard\\Q1TwoSum.java',
    )).toBe('shane.leetcode.problems.xhard.Q1TwoSum')
  })

  it('rejects non-Java files and paths outside the Java source root', () => {
    expect(fqcnFromJavaPath('src/main/kotlin/shane/leetcode/problems/easy/Q1TwoSum.kt')).toBeNull()
    expect(fqcnFromJavaPath('src/test/java/shane/leetcode/Q1TwoSum.java')).toBeNull()
  })
})

describe('file search', () => {
  const files: ProblemFileEntry[] = [
    { path: 'src/main/java/easy/Q1TwoSum.java', name: 'Q1TwoSum.java', packageSegment: 'easy' },
    { path: 'src/main/java/easy/Q20ValidParentheses.java', name: 'Q20ValidParentheses.java', packageSegment: 'easy' },
    { path: 'src/main/java/medium/Q146LRUCache.java', name: 'Q146LRUCache.java', packageSegment: 'medium' },
  ]

  it('filters by a trimmed, case-insensitive filename substring', () => {
    expect(filterProblemFiles(files, '  lru  ')).toEqual([files[2]])
    expect(filterProblemFiles(files, 'PARENT')).toEqual([files[1]])
    expect(filterProblemFiles(files, '   ')).toEqual(files)
    expect(filterProblemFilesByGroup(files, 'easy', 'q')).toEqual(files.slice(0, 2))
    expect(filterProblemFilesByGroup(files, 'medium', 'two')).toEqual([])
  })
})

describe('AutosaveCoordinator', () => {
  it('debounces edits and coalesces them to the newest content', async () => {
    vi.useFakeTimers()
    try {
      const saved: string[] = []
      const coordinator = new AutosaveCoordinator(async ({ source }) => {
        saved.push(source)
      }, { delayMs: 500 })

      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'a' })
      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'ab' })
      await vi.advanceTimersByTimeAsync(499)
      expect(saved).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await coordinator.flush()
      expect(saved).toEqual(['ab'])
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves an edit made during an in-flight save after the first write', async () => {
    const saved: string[] = []
    let releaseFirst: (() => void) | undefined
    const coordinator = new AutosaveCoordinator(({ source }) => {
      saved.push(source)
      if (source === 'a') {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return Promise.resolve()
    }, { delayMs: 0 })

    coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'a' })
    const firstFlush = coordinator.flush()
    await Promise.resolve()
    coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'ab' })
    releaseFirst?.()
    await firstFlush
    await coordinator.flush()
    expect(saved).toEqual(['a', 'ab'])
    coordinator.dispose()
  })

  it('flushes a pending edit immediately for a transition', async () => {
    vi.useFakeTimers()
    try {
      const saved: string[] = []
      const coordinator = new AutosaveCoordinator(async ({ source }) => {
        saved.push(source)
      }, { delayMs: 500 })
      coordinator.schedule({ repoPath: '/repo', filePath: 'Q1.java', source: 'latest' })
      await coordinator.flush()
      expect(saved).toEqual(['latest'])
      expect(coordinator.hasPendingChanges).toBe(false)
      coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('repository refresh generations', () => {
  it('rejects a response from a previous request or repository', () => {
    const current = {
      repoPath: '/new-repo',
      projectValid: true,
      repositoryGeneration: 2,
      refreshRequestId: 8,
    }
    expect(isCurrentRepositoryRefresh({
      repoPath: '/old-repo',
      repositoryGeneration: 1,
      requestId: 7,
    }, current)).toBe(false)
    expect(isCurrentRepositoryRefresh({
      repoPath: '/new-repo',
      repositoryGeneration: 2,
      requestId: 8,
    }, current)).toBe(true)
  })
})

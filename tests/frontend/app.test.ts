import { describe, expect, it, vi } from 'vitest'

import {
  AutosaveCoordinator,
  clampBottomPanelHeight,
  clampGitFileListWidth,
  conciseTestFailureMessage,
  deleteFileConfirmationMessage,
  defaultGitCommitMessage,
  defaultVisibleTests,
  filterProblemFiles,
  filterProblemFilesByGroup,
  filterTestDiagnostics,
  fqcnFromJavaPath,
  isCurrentRepositoryRefresh,
  normalizeGitDiff,
  normalizeGitStatus,
  relevantTestStackFrames,
} from '../../src/app'
import type { ProblemFileEntry, TestCaseResult, TestDiagnostic } from '../../src/backend'

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

describe('Git panel helpers', () => {
  it('normalizes porcelain-style and object Git status payloads', () => {
    expect(normalizeGitStatus(' M src/main/java/Q1.java\n?? src/main/java/Q2.java')).toMatchObject({
      files: [
        { path: 'src/main/java/Q1.java', status: 'modified', staged: false },
        { path: 'src/main/java/Q2.java', status: 'untracked', staged: false },
      ],
    })
    expect(normalizeGitStatus({
      branch: 'main',
      changes: [{ path: 'Q1.java', status: 'modified', indexStatus: 'M', worktreeStatus: '.' }],
    })).toMatchObject({
      branch: 'main',
      files: [{ path: 'Q1.java', status: 'modified', staged: true }],
    })
    expect(normalizeGitStatus({
      changes: [{ path: 'Q2.java', status: 'modified', indexStatus: '.', worktreeStatus: 'M' }],
    }).files[0].staged).toBe(false)
  })

  it('splits a multi-file unified diff by repository-relative path', () => {
    const diff = normalizeGitDiff([
      'diff --git a/Q1.java b/Q1.java\n@@ -1 +1 @@\n-old\n+new',
      'diff --git a/Q2.java b/Q2.java\n@@ -1 +1 @@\n-same\n+changed',
    ], ['Q1.java', 'Q2.java'])
    expect(diff['Q1.java']).toContain('-old')
    expect(diff['Q2.java']).toContain('+changed')
  })

  it('keeps no-newline diff metadata out of source line counting', () => {
    const diff = normalizeGitDiff(
      'diff --git a/Q1.java b/Q1.java\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n\\ No newline at end of file',
      ['Q1.java'],
    )
    expect(diff['Q1.java']).toContain('\\ No newline at end of file')
  })

  it('uses the requested Create message and clamps panel height', () => {
    expect(defaultGitCommitMessage(['src/Q1386CinemaSeatAllocation.java'])).toBe('Create Q1386CinemaSeatAllocation.java')
    expect(defaultGitCommitMessage(['Q1.java', 'Q2.java'])).toBe('Create Q1.java and 1 more')
    expect(clampBottomPanelHeight(20, 900)).toBe(180)
    expect(clampBottomPanelHeight(1000, 900)).toBe(640)
    expect(clampBottomPanelHeight(Number.POSITIVE_INFINITY, 300)).toBe(240)
    expect(clampBottomPanelHeight(Number.NaN, 300)).toBe(240)
    expect(clampBottomPanelHeight(300, 900)).toBe(300)
    expect(clampGitFileListWidth(100, 900)).toBe(180)
    expect(clampGitFileListWidth(700, 900)).toBe(617)
    expect(clampGitFileListWidth(Number.POSITIVE_INFINITY, 400)).toBe(180)
    expect(deleteFileConfirmationMessage('Q1.java')).toBe('Delete Q1.java?\n\nThis cannot be undone.')
  })
})

describe('test failure and diagnostic presentation helpers', () => {
  it('keeps a concise assertion and user frames while filtering internal frames', () => {
    const test: TestCaseResult = {
      name: 'asserts',
      status: 'failed',
      details: 'org.opentest4j.AssertionFailedError: expected 3 but was 2\n'
        + '    at shane.leetcode.Q1Test.asserts(Q1Test.java:12)\n'
        + '    at org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:100)\n'
        + '    at java.base/java.lang.reflect.Method.invoke(Method.java:1)',
    }
    expect(conciseTestFailureMessage(test)).toContain('AssertionFailedError')
    expect(relevantTestStackFrames(test.details)).toEqual([
      'at shane.leetcode.Q1Test.asserts(Q1Test.java:12)',
    ])
  })

  it('hides only the noisy unknown-enum Status warnings', () => {
    const diagnostics: TestDiagnostic[] = [
      { severity: 'warning', message: 'warning: unknown enum constant Status.REQUIRED' },
      { severity: 'warning', message: 'unchecked conversion' },
      { severity: 'error', message: 'unknown enum constant Status.REQUIRED' },
    ]
    expect(filterTestDiagnostics(diagnostics)).toEqual([diagnostics[1]])
    expect(filterTestDiagnostics([
      { severity: '', message: 'unknown enum constant Foo.BAR' },
    ])).toEqual([])
  })

  it('shows only failed tests by default when a run has failures', () => {
    const tests: TestCaseResult[] = [
      { name: 'pass', status: 'passed' },
      { name: 'fail', status: 'failed' },
      { name: 'skip', status: 'skipped' },
    ]
    expect(defaultVisibleTests(tests)).toMatchObject({
      tests: [tests[1]],
      hiddenCount: 2,
    })
    expect(defaultVisibleTests(tests, true).tests).toEqual(tests)
  })
})

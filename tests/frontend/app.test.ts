import { describe, expect, it, vi } from 'vitest'

import {
  AutosaveCoordinator,
  charDiffSegments,
  clampBottomPanelHeight,
  clampGitFileListWidth,
  conciseTestFailureMessage,
  deleteFileConfirmationMessage,
  defaultGitCommitMessage,
  defaultVisibleTests,
  filterProblemFiles,
  filterProblemFilesByGroup,
  filterTestDiagnostics,
  findTodayProblemFile,
  fqcnFromJavaPath,
  gitDirectoryPath,
  gitResultToastMessage,
  isCurrentRepositoryRefresh,
  normalizeGitDiff,
  normalizeGitStatus,
  normalizeDailyProblemDateKey,
  parseUnifiedDiffLines,
  RepositoryPickerCoordinator,
  relevantTestStackFrames,
  nextUtcMidnightDelayMs,
  utcDateKey,
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

describe('RepositoryPickerCoordinator', () => {
  it('allows only one picker request until the active request finishes', async () => {
    let finishPicker: ((path: string | null) => void) | undefined
    const picker = vi.fn(() => new Promise<string | null>((resolve) => {
      finishPicker = resolve
    }))
    const coordinator = new RepositoryPickerCoordinator()

    const first = coordinator.open(picker)
    const duplicate = coordinator.open(picker)

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(coordinator.isOpen).toBe(true)
    expect(picker).toHaveBeenCalledTimes(1)

    finishPicker?.('/repo')
    await expect(first).resolves.toBe('/repo')
    expect(coordinator.isOpen).toBe(false)
  })

  it('can open again after cancellation or failure', async () => {
    const coordinator = new RepositoryPickerCoordinator()

    await expect(coordinator.open(async () => null)).resolves.toBeNull()
    await expect(coordinator.open(async () => {
      throw new Error('picker failed')
    })).rejects.toThrow('picker failed')
    await expect(coordinator.open(async () => '/repo')).resolves.toBe('/repo')
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

  it('renders only useful unified-diff rows with Desktop-style gutters', () => {
    const rows = parseUnifiedDiffLines([
      'diff --git a/src/Q1.java b/src/Q1.java',
      'index 1111111..2222222 100644',
      '--- a/src/Q1.java',
      '+++ b/src/Q1.java',
      '@@ -3,3 +3,4 @@',
      ' context',
      '-removed',
      '---',
      '+added',
      '+++',
      ' ',
      '\\ No newline at end of file',
    ].join('\r\n'))

    expect(rows).toEqual([
      { kind: 'hunk', oldLine: null, newLine: null, marker: '', content: '@@ -3,3 +3,4 @@' },
      { kind: 'context', oldLine: 3, newLine: 3, marker: '', content: 'context' },
      { kind: 'deletion', oldLine: 4, newLine: null, marker: '-', content: 'removed' },
      { kind: 'deletion', oldLine: 5, newLine: null, marker: '-', content: '--' },
      { kind: 'addition', oldLine: null, newLine: 4, marker: '+', content: 'added' },
      { kind: 'addition', oldLine: null, newLine: 5, marker: '+', content: '++' },
      { kind: 'context', oldLine: 6, newLine: 6, marker: '', content: '' },
      { kind: 'no-newline', oldLine: null, newLine: null, marker: '', content: '\\ No newline at end of file' },
    ])
  })

  it('keeps deleted and newly added file hunks while filtering mode and binary metadata', () => {
    const deleted = parseUnifiedDiffLines([
      'diff --git a/Q1.java b/Q1.java',
      'deleted file mode 100644',
      'index abc..000',
      '--- a/Q1.java',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-first',
      '-second',
    ].join('\n'))
    const added = parseUnifiedDiffLines([
      'diff --git a/Q2.java b/Q2.java',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/Q2.java',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
    ].join('\n'))
    const binary = parseUnifiedDiffLines([
      'diff --git a/image.png b/image.png',
      'new file mode 100644',
      'index 000..abc',
      'Binary files /dev/null and b/image.png differ',
    ].join('\n'))

    expect(deleted.map(({ kind, oldLine, newLine, content }) => ({ kind, oldLine, newLine, content }))).toEqual([
      { kind: 'hunk', oldLine: null, newLine: null, content: '@@ -1,2 +0,0 @@' },
      { kind: 'deletion', oldLine: 1, newLine: null, content: 'first' },
      { kind: 'deletion', oldLine: 2, newLine: null, content: 'second' },
    ])
    expect(added.map(({ kind, oldLine, newLine, content }) => ({ kind, oldLine, newLine, content }))).toEqual([
      { kind: 'hunk', oldLine: null, newLine: null, content: '@@ -0,0 +1,2 @@' },
      { kind: 'addition', oldLine: null, newLine: 1, content: 'first' },
      { kind: 'addition', oldLine: null, newLine: 2, content: 'second' },
    ])
    expect(binary).toEqual([])
  })

  it('derives the auto commit message from the change kinds and clamps panel height', () => {
    expect(defaultGitCommitMessage([])).toBe('Update files')
    expect(defaultGitCommitMessage([
      { path: 'src/Q1386CinemaSeatAllocation.java', status: 'added' },
    ])).toBe('Add Q1386CinemaSeatAllocation.java')
    expect(defaultGitCommitMessage([
      { path: 'Q1.java', status: 'untracked' },
      { path: 'Q2.java', status: 'added' },
    ])).toBe('Add 2 files')
    expect(defaultGitCommitMessage([
      { path: 'src/Q1.java', status: 'modified' },
    ])).toBe('Update Q1.java')
    expect(defaultGitCommitMessage([
      { path: 'Q1.java', status: 'added' },
      { path: 'Q2.java', status: 'modified' },
    ])).toBe('Update 2 files')
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

  it('uses UTC dates and schedules just after the next UTC midnight', () => {
    const beforeMidnight = Date.UTC(2026, 7, 23, 23, 59, 59, 500)
    expect(utcDateKey(beforeMidnight)).toBe('2026-08-23')
    expect(utcDateKey(beforeMidnight + 1000)).toBe('2026-08-24')
    expect(nextUtcMidnightDelayMs(beforeMidnight)).toBe(1500)
    expect(nextUtcMidnightDelayMs(Date.UTC(2026, 7, 23, 12, 0, 0), 0)).toBe(12 * 60 * 60 * 1000)
  })

  it('accepts only real provider UTC date keys', () => {
    expect(normalizeDailyProblemDateKey('2026-08-23')).toBe('2026-08-23')
    expect(normalizeDailyProblemDateKey('2026-02-29')).toBeNull()
    expect(normalizeDailyProblemDateKey('2026-13-01')).toBeNull()
    expect(normalizeDailyProblemDateKey('2026-8-23')).toBeNull()
    expect(normalizeDailyProblemDateKey('not-a-date')).toBeNull()
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

  it('keeps every test visible, ordered failed → errors → passed → skipped', () => {
    const tests: TestCaseResult[] = [
      { name: 'pass', status: 'passed' },
      { name: 'err', status: 'error' },
      { name: 'fail', status: 'failed' },
      { name: 'skip', status: 'skipped' },
      { name: 'fail2', status: 'failed' },
    ]
    expect(defaultVisibleTests(tests).map((test) => test.name))
      .toEqual(['fail', 'fail2', 'err', 'pass', 'skip'])
    // A live run keeps arrival order so rows do not jump while streaming.
    expect(defaultVisibleTests(tests, true)).toEqual(tests)
  })

  it('produces a character-level diff only for differing single-line values', () => {
    expect(charDiffSegments('[1, 2, 3]', '[1, 4, 3]')).toEqual({
      prefix: '[1, ',
      expectedMid: '2',
      actualMid: '4',
      suffix: ', 3]',
    })
    expect(charDiffSegments('abc', 'abcdef')).toEqual({
      prefix: 'abc',
      expectedMid: '',
      actualMid: 'def',
      suffix: '',
    })
    expect(charDiffSegments('same', 'same')).toBeNull()
    expect(charDiffSegments('multi\nline', 'multi line')).toBeNull()
  })
})

describe('daily problem file matching', () => {
  const files: ProblemFileEntry[] = [
    { path: 'src/main/java/easy/Q1TwoSum.java', name: 'Q1TwoSum.java', packageSegment: 'easy' },
    { path: 'src/main/java/easy/Q3622CheckDivisibilityByDigitSumAndProduct2.java', name: 'Q3622CheckDivisibilityByDigitSumAndProduct2.java', packageSegment: 'easy' },
    { path: 'notes/Q3622CheckDivisibilityByDigitSumAndProduct.md', name: 'Q3622CheckDivisibilityByDigitSumAndProduct.md', packageSegment: 'other' },
  ]

  it('matches the base class name or a numeric collision suffix, Java files only', () => {
    expect(findTodayProblemFile(files, {
      frontendId: '3622',
      title: 'Check Divisibility by Digit Sum and Product',
    })).toBe(files[1])
    expect(findTodayProblemFile(files, { frontendId: '2', title: 'Add Two Numbers' })).toBeNull()
  })
})

describe('git result toast copy', () => {
  it('reports the short hash with file count or push target', () => {
    const commit = { commitHash: 'a1b2c3d4e5f6', message: 'Add Q1.java', paths: ['Q1.java'] }
    expect(gitResultToastMessage(1, false, commit, null)).toBe('Committed a1b2c3d · 1 file')
    expect(gitResultToastMessage(2, true, commit, { output: '', branch: 'main' }))
      .toBe('Committed a1b2c3d · Pushed to origin/main')
    expect(gitResultToastMessage(2, false, null, null)).toBe('Committed · 2 files')
    expect(gitResultToastMessage(1, true, commit, null)).toBe('Committed a1b2c3d · Pushed')
  })

  it('splits a repo-relative path into directory and basename', () => {
    expect(gitDirectoryPath('src/main/java/easy/Q1.java')).toBe('src/main/java/easy')
    expect(gitDirectoryPath('README.md')).toBe('')
  })
})

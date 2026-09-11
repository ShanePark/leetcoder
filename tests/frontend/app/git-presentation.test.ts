import { describe, expect, it } from 'vitest'
import {
  clampBottomPanelHeight,
  clampContextMenuPosition,
  clampGitFileListWidth,
  discardGitChangesConfirmationMessage,
  discardGitChangesWarningMessage,
  deleteFileConfirmationMessage,
  defaultGitCommitMessage,
  gitDirectoryPath,
  gitResultToastMessage,
  normalizeGitDiff,
  normalizeGitStatus,
  normalizeDailyProblemDateKey,
  parseUnifiedDiffLines,
  nextUtcMidnightDelayMs,
  utcDateKey,
} from '../../../src/app'

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
    expect(normalizeGitStatus({
      changes: [{ path: 'renamed/Q1.java', originalPath: 'original/Q1.java', status: 'renamed' }],
    }).files[0].originalPath).toBe('original/Q1.java')
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
    expect(discardGitChangesConfirmationMessage('src/Q1.java')).toContain('all staged and unstaged changes')
    expect(discardGitChangesConfirmationMessage('src/Q1.java')).toContain('Untracked/new files will be deleted')
    expect(discardGitChangesConfirmationMessage('src/Q1.java')).toContain('cannot be undone')
    expect(discardGitChangesWarningMessage()).toBe(
      'This permanently discards all staged and unstaged changes. Untracked/new files will be deleted. This cannot be undone.',
    )
    expect(clampContextMenuPosition(900, 780, 190, 76, 1000, 800)).toEqual({ x: 802, y: 716 })
    expect(clampContextMenuPosition(-10, -20, 190, 76, 1000, 800)).toEqual({ x: 8, y: 8 })
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

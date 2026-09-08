import { describe, expect, it } from 'vitest'
import {
  accordionGroupKeys,
  clampDailyDescriptionHeight,
  clampSidebarWidth,
  duplicateFileName,
  filterProblemFiles,
  filterProblemFilesByGroup,
  findTodayProblemFile,
  findFileAfterDuplicate,
  findRestoredFileAfterGitRename,
  fqcnFromJavaPath,
  isCloseAllTabsShortcut,
  isCloseTabShortcut,
  isFileTabsShiftWheel,
  isMacPlatform,
  normalizeJavaFileName,
  replacementTabIndex,
} from '../../../src/app'
import type { ProblemFileEntry } from '../../../src/backend'

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

describe('file explorer actions', () => {
  it('keeps only one problem difficulty group expanded at a time', () => {
    expect(accordionGroupKeys('easy', true)).toEqual(['easy'])
    expect(accordionGroupKeys('medium', true)).toEqual(['medium'])
    expect(accordionGroupKeys('xhard', true)).toEqual(['xhard'])
    expect(accordionGroupKeys('other', true)).toEqual(['other'])
    expect(accordionGroupKeys('medium', false)).toEqual([])
  })

  it('chooses the first free numeric suffix before the Java extension', () => {
    const name = 'Q2904ShortestAndLexicographicallySmallestBeautifulString.java'
    expect(duplicateFileName(name, [name])).toBe(
      'Q2904ShortestAndLexicographicallySmallestBeautifulString2.java',
    )
    expect(duplicateFileName(name, [name, name.replace('.java', '2.java')])).toBe(
      'Q2904ShortestAndLexicographicallySmallestBeautifulString3.java',
    )
  })

  it('finds the newly-created duplicate after refreshing the explorer', () => {
    const original: ProblemFileEntry = {
      path: 'src/main/java/easy/Q2904ShortestAndLexicographicallySmallestBeautifulString.java',
      name: 'Q2904ShortestAndLexicographicallySmallestBeautifulString.java',
      packageSegment: 'easy',
    }
    const duplicate: ProblemFileEntry = {
      ...original,
      path: original.path.replace('.java', '2.java'),
      name: original.name.replace('.java', '2.java'),
    }
    expect(findFileAfterDuplicate(
      [original, duplicate],
      new Set([original.path]),
      original,
      { relativePath: duplicate.path },
    )).toEqual(duplicate)
  })

  it('finds the original entry restored after discarding a staged rename', () => {
    const restored: ProblemFileEntry = {
      path: 'src/main/java/easy/Q2904ShortestAndLexicographicallySmallestBeautifulString.java',
      name: 'Q2904ShortestAndLexicographicallySmallestBeautifulString.java',
      packageSegment: 'easy',
    }
    expect(findRestoredFileAfterGitRename([restored], {
      path: restored.path.replace('.java', 'Renamed.java'),
      originalPath: restored.path,
    })).toEqual(restored)
    expect(findRestoredFileAfterGitRename([restored], {
      path: restored.path,
      originalPath: restored.path,
    })).toBeNull()
  })

  it('selects the right tab first, then the left tab when closing the last tab', () => {
    expect(replacementTabIndex(2, 0)).toBe(0)
    expect(replacementTabIndex(2, 1)).toBe(1)
    expect(replacementTabIndex(2, 2)).toBe(1)
    expect(replacementTabIndex(0, 0)).toBeNull()
    expect(replacementTabIndex(2, 3)).toBeNull()
  })

  it('recognizes Apple platforms from explicit platform values', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Linux x86_64')).toBe(false)
    expect(isMacPlatform('Win32', 'iPhone Safari')).toBe(true)
  })

  it('matches Cmd+W on macOS and Alt+W on other platforms only', () => {
    const base = { key: 'w', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }

    expect(isCloseTabShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isCloseTabShortcut({ ...base, altKey: true }, true)).toBe(false)
    expect(isCloseTabShortcut({ ...base, metaKey: true, shiftKey: true }, true)).toBe(false)
    expect(isCloseTabShortcut({ ...base, altKey: true }, false)).toBe(true)
    expect(isCloseTabShortcut({ ...base, metaKey: true }, false)).toBe(false)
    expect(isCloseTabShortcut({ ...base, altKey: true, ctrlKey: true }, false)).toBe(false)
  })

  it('matches Cmd+Shift+W on macOS and Alt+Shift+W on other platforms only', () => {
    const base = { key: 'w', shiftKey: true, altKey: false, metaKey: false, ctrlKey: false }

    expect(isCloseAllTabsShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isCloseAllTabsShortcut({ ...base, altKey: true }, true)).toBe(false)
    expect(isCloseAllTabsShortcut({ ...base, metaKey: true, shiftKey: false }, true)).toBe(false)
    expect(isCloseAllTabsShortcut({ ...base, altKey: true }, false)).toBe(true)
    expect(isCloseAllTabsShortcut({ ...base, metaKey: true }, false)).toBe(false)
    expect(isCloseAllTabsShortcut({ ...base, altKey: true, ctrlKey: true }, false)).toBe(false)
  })

  it('requires Shift for file-tab wheel scrolling', () => {
    expect(isFileTabsShiftWheel({ deltaY: 120, shiftKey: true })).toBe(true)
    expect(isFileTabsShiftWheel({ deltaY: 120, shiftKey: false })).toBe(false)
    expect(isFileTabsShiftWheel({ deltaY: 0, shiftKey: true })).toBe(false)
  })

  it('normalizes safe rename input and rejects paths or invalid basenames', () => {
    expect(normalizeJavaFileName('Q2904Copy')).toBe('Q2904Copy.java')
    expect(normalizeJavaFileName('Q2904Copy.JAVA')).toBe('Q2904Copy.JAVA')
    expect(normalizeJavaFileName('../Q2904Copy.java')).toBeNull()
    expect(normalizeJavaFileName('Q2904?.java')).toBeNull()
  })

  it('keeps the sidebar within its own bounds and leaves editor room', () => {
    expect(clampSidebarWidth(100, 1200)).toBe(180)
    expect(clampSidebarWidth(700, 1200)).toBe(520)
    expect(clampSidebarWidth(500, 800)).toBe(433)
    expect(clampSidebarWidth(Number.NaN, 1200)).toBe(248)
  })

  it('keeps the open description within bounds while preserving editor space', () => {
    expect(clampDailyDescriptionHeight(40, 800)).toBe(120)
    expect(clampDailyDescriptionHeight(1000, 800)).toBe(534)
    expect(clampDailyDescriptionHeight(400, 900)).toBe(400)
    expect(clampDailyDescriptionHeight(Number.NaN, 900)).toBe(220)
    expect(clampDailyDescriptionHeight(500, 300)).toBe(120)
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

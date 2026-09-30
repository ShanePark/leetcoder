import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDevMockBackend } from '../../../src/dev-mock'
import { planProblemFile } from '../../../src/domain'

const repo = '/preview'
const javaRoot = 'src/main/java/shane/leetcode/problems'
const originalPath = `${javaRoot}/easy/Q1TwoSum.java`
const addedPath = `${javaRoot}/easy/Q3618SplitArrayByPrimeIndices.java`

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function finishDelayed<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return pending
}

describe('browser preview problem fixtures', () => {
  it('keeps the seeded paths, ordering, packages, and representative source', async () => {
    const backend = createDevMockBackend()
    const files = await backend.listProblemFiles(repo)
    expect(files.map((entry) => entry.path)).toEqual([
      `${javaRoot}/Scratch.java`,
      ...[
        'Q1TwoSum', 'Q20ValidParentheses', 'Q3606CouponCodeValidator',
        'Q3618SplitArrayByPrimeIndices', 'Q88MergeSortedArray', 'Q121BestTimeToBuyAndSellStock',
      ].map((name) => `${javaRoot}/easy/${name}.java`),
      ...['Q2AddTwoNumbers', 'Q146LRUCache', 'Q200NumberOfIslands', 'Q3616NumberOfStudentsWithDifferentRanks']
        .map((name) => `${javaRoot}/medium/${name}.java`),
      ...['Q4MedianOfTwoSortedArrays', 'Q42TrappingRainWater', 'Q3615LongestPalindromicPath']
        .map((name) => `${javaRoot}/xhard/${name}.java`),
    ].sort())
    expect(files.map((entry) => entry.packageSegment)).toEqual([
      'other', ...Array(6).fill('easy'), ...Array(4).fill('medium'), ...Array(3).fill('xhard'),
    ])
    expect(await backend.readProblemFile(repo, `${javaRoot}/Scratch.java`))
      .toBe('package shane.leetcode.problems;\n\npublic class Scratch {\n}\n')
    expect(await backend.readProblemFile(repo, originalPath)).toBe(`package shane.leetcode.problems.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@SuppressWarnings("NewClassNamingConvention")
public class Q1TwoSum {

    public boolean checkDivisibility(int n) {
        int sum = 0;
        int product = 1;
        for (int cur = n; cur > 0; cur /= 10) {
            sum += cur % 10;
            product *= cur % 10;
        }
        return n % (sum + product) == 0;
    }

    @Test
    public void test() {
        assertThat(checkDivisibility(99)).isTrue();
        assertThat(checkDivisibility(23)).isFalse();
    }
}
`)
  })

  it('keeps delayed daily/manual lookups and rejects unavailable numbers', async () => {
    const backend = createDevMockBackend()
    let settled = false
    const pending = backend.fetchDailyProblem().then((problem) => { settled = true; return problem })
    await vi.advanceTimersByTimeAsync(349)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const daily = await pending
    expect(daily).toMatchObject({
      frontendId: '3622', title: 'Check Divisibility by Digit Sum and Product', difficulty: 'Easy',
      javaSnippet: 'class Solution {\n    public boolean checkDivisibility(int n) {\n        \n    }\n}',
    })
    expect(daily.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await finishDelayed(backend.fetchProblemByNumber(' 3622 '))).toEqual({ ...daily, date: '' })
    expect(await finishDelayed(backend.fetchProblemByNumber(' 1 '))).toMatchObject({
      date: '', frontendId: '1', title: 'Two Sum', titleSlug: 'two-sum',
    })
    const rejected = expect(backend.fetchProblemByNumber('999')).rejects
      .toThrow('Problem #999 was not found in the preview.')
    await vi.runAllTimersAsync()
    await rejected
  })
})

describe('browser preview repository mutations and search', () => {
  it('isolates files between backends and retains duplicate/rename behavior', async () => {
    const backend = createDevMockBackend()
    const other = createDevMockBackend()
    const plan = planProblemFile({ number: 9000, title: 'Preview', difficulty: 'Easy' })
    await backend.createProblemFile(repo, plan)
    expect(await backend.readProblemFile(repo, plan.path)).toBe(plan.source)
    await expect(other.readProblemFile(repo, plan.path)).rejects.toThrow('No such file:')

    const duplicate = await backend.duplicateProblemFile(repo, originalPath)
    expect(duplicate.relativePath).toBe(`${javaRoot}/easy/Q1TwoSum2.java`)
    expect(duplicate.content).toContain('public class Q1TwoSum2 {')
    const next = await backend.duplicateProblemFile(repo, originalPath)
    expect(next.relativePath).toBe(`${javaRoot}/easy/Q1TwoSum3.java`)
    const renamed = await backend.renameProblemFile(repo, duplicate.relativePath, 'Renamed')
    expect(renamed.relativePath).toBe(`${javaRoot}/easy/Renamed.java`)
    expect(renamed.content).toContain('public class Renamed {')
    await expect(backend.readProblemFile(repo, duplicate.relativePath)).rejects.toThrow('No such file:')
    await expect(backend.renameProblemFile(repo, originalPath, 'Renamed')).rejects.toThrow('File already exists:')
    await backend.deleteProblemFile(repo, renamed.relativePath)
    await expect(backend.readProblemFile(repo, renamed.relativePath)).rejects.toThrow('No such file:')
    expect(await other.listProblemFiles(repo)).toHaveLength(14)
  })

  it('searches saved lines literally with case, exclusion, coordinates, and first-match behavior', async () => {
    const backend = createDevMockBackend()
    const pending = backend.saveProblemFile(repo, originalPath, 'prefix Needle.* Needle.*\nNeedle.* again\n')
    expect(await backend.searchProject(repo, 'Needle.*', true)).toMatchObject({ matches: [] })
    await finishDelayed(pending)
    expect(await backend.searchProject(repo, 'needle.*', false)).toEqual({
      matches: [{ path: originalPath, line: 1, column: 8, preview: 'prefix Needle.* Needle.*' }],
      truncated: false, skippedFiles: 0,
    })
    expect(await backend.searchProject(repo, 'needle.*', true)).toMatchObject({ matches: [] })
    expect(await backend.searchProject(repo, 'Needle.*', true, [originalPath])).toMatchObject({ matches: [] })
    expect(await backend.searchProject(repo, '', false)).toEqual({ matches: [], truncated: false, skippedFiles: 0 })
  })
})

describe('browser preview Git and native-only capabilities', () => {
  it('restores modified sources, deletes new files, and commits only selected changes', async () => {
    const backend = createDevMockBackend()
    const original = await backend.readProblemFile(repo, originalPath)
    await finishDelayed(backend.saveProblemFile(repo, originalPath, 'edited'))
    await backend.discardGitChanges(repo, originalPath)
    expect(await backend.readProblemFile(repo, originalPath)).toBe(original)
    await backend.discardGitChanges(repo, addedPath)
    await expect(backend.readProblemFile(repo, addedPath)).rejects.toThrow('No such file:')
    await expect(backend.discardGitChanges(repo, originalPath)).rejects.toThrow('not currently changed')
    const paths = ['notes/scratchpad.md']
    expect(await finishDelayed(backend.commitGit(repo, paths, 'Update notes'))).toEqual({
      commitHash: 'a1b2c3d4e5f60789', message: 'Update notes', paths,
    })
    expect(await backend.listGitChanges(repo)).toEqual([])
    expect(await finishDelayed(backend.getGitStatus(repo))).toEqual({ branch: 'main', files: [] })
    expect(await createDevMockBackend().listGitChanges(repo)).toHaveLength(3)
  })

  it('keeps diff fixtures and browser-only capability results', async () => {
    const backend = createDevMockBackend()
    const diff = await finishDelayed(backend.getGitDiff(repo, [originalPath, 'notes/scratchpad.md']))
    expect(diff).toContain('@@ -8,9 +8,11 @@ public class Q1TwoSum {')
    expect(diff).toContain('+        Map<Integer, Integer> seen = new HashMap<>();')
    expect(diff).toContain('@@ -0,0 +1,4 @@\n+# scratch notes\n+\n+- revisit DP problems\n+\n')
    expect(await finishDelayed(backend.pushGit(repo))).toEqual({ output: 'To github.com:shane/ps.git', branch: 'main' })
    expect(await backend.validateProject(repo)).toEqual({ valid: true })
    expect(await backend.inspectPsLibrary(repo)).toEqual({ fingerprint: 'preview', methods: [] })
    expect(await backend.checkForUpdate()).toEqual({ supported: false, available: false, currentCommit: '', latestCommit: '' })
    await expect(backend.updateAndRestart()).rejects.toThrow('Updates are unavailable in the browser preview.')
    const watcher = vi.fn()
    await backend.watchRepository(repo)
    const unsubscribe = await backend.onRepositoryFilesChanged(watcher)
    unsubscribe()
    await backend.stopWatchingRepository()
    expect(watcher).not.toHaveBeenCalled()
  })
})

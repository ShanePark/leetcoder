import { describe, expect, it } from 'vitest'

import {
  createBackendClient,
  type Invoke,
} from '../../../src/backend'

describe('backend client', () => {
  it('invokes deletion with the repository-relative source path', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('delete_problem_file')
      expect(args).toEqual({ repoPath: '/repo', path: 'src/main/java/Q1.java' })
      return undefined
    }

    await expect(
      createBackendClient(invoke).deleteProblemFile('/repo', 'src/main/java/Q1.java'),
    ).resolves.toBeUndefined()
  })

  it('invokes duplicate and returns the new repository-relative file', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('duplicate_problem_file')
      expect(args).toEqual({ repoPath: '/repo', path: 'src/main/java/Q1.java' })
      return {
        relativePath: 'src/main/java/Q12.java',
        content: 'public class Q12 {}',
      }
    }

    await expect(
      createBackendClient(invoke).duplicateProblemFile('/repo', 'src/main/java/Q1.java'),
    ).resolves.toEqual({
      relativePath: 'src/main/java/Q12.java',
      content: 'public class Q12 {}',
    })
  })

  it('invokes rename with a requested path and normalizes legacy response fields', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('rename_problem_file')
      expect(args).toEqual({
        repoPath: '/repo',
        path: 'src/main/java/Q1.java',
        newPath: 'src/main/java/Renamed.java',
      })
      return {
        path: 'src/main/java/Renamed.java',
        source: 'public class Renamed {}',
      }
    }

    await expect(
      createBackendClient(invoke).renameProblemFile(
        '/repo',
        'src/main/java/Q1.java',
        'src/main/java/Renamed.java',
      ),
    ).resolves.toEqual({
      relativePath: 'src/main/java/Renamed.java',
      content: 'public class Renamed {}',
    })
  })

  it('keeps Kotlin files for collision detection while ignoring unrelated files', async () => {
    const invoke: Invoke = async (command) => {
      expect(command).toBe('list_problem_files')
      return [
        'src/main/java/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation.java',
        'src/main/kotlin/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation5.kt',
        'src/main/java/shane/leetcode/problems/easy/README.md',
      ]
    }

    const files = await createBackendClient(invoke).listProblemFiles('/repo')

    expect(files.map((file) => file.path)).toEqual([
      'src/main/java/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation.java',
      'src/main/kotlin/shane/leetcode/problems/easy/Q3362ZeroArrayTransformation5.kt',
    ])
  })

  it('normalizes the daily DTO and preserves the optional Java snippet', async () => {
    const invoke: Invoke = async (command) => {
      expect(command).toBe('fetch_daily_problem')
      return {
        date: '2026-08-22',
        frontendId: 3622,
        title: 'Check Divisibility by Digit Sum and Product',
        titleSlug: 'check-divisibility-by-digit-sum-and-product',
        difficulty: 'HARD',
        url: 'https://leetcode.com/problems/check-divisibility-by-digit-sum-and-product/',
        javaSnippet: 'class Solution { public boolean checkDivisibility(int n) { return true; } }',
      }
    }

    await expect(createBackendClient(invoke).fetchDailyProblem()).resolves.toMatchObject({
      frontendId: '3622',
      javaSnippet: expect.stringContaining('checkDivisibility'),
    })
  })

  it('invokes a numeric problem lookup and keeps manual results date-less', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('fetch_problem_by_number')
      expect(args).toEqual({ frontendId: '1' })
      return {
        date: '',
        frontend_id: '1',
        title: 'Two Sum',
        title_slug: 'two-sum',
        difficulty: 'Easy',
        url: 'https://leetcode.com/problems/two-sum/',
        content: '<p>Find two numbers.</p>',
        java_snippet: 'class Solution {}',
      }
    }

    await expect(createBackendClient(invoke).fetchProblemByNumber('1')).resolves.toEqual({
      date: '',
      frontendId: '1',
      title: 'Two Sum',
      titleSlug: 'two-sum',
      difficulty: 'Easy',
      url: 'https://leetcode.com/problems/two-sum/',
      content: '<p>Find two numbers.</p>',
      javaSnippet: 'class Solution {}',
    })
  })

  it('always resolves the daily problem description content to a string or null', async () => {
    const fetchDaily = (extra: Record<string, unknown>) => {
      const invoke: Invoke = async (command) => {
        expect(command).toBe('fetch_daily_problem')
        return {
          date: '2026-08-24',
          frontendId: 1,
          title: 'Two Sum',
          titleSlug: 'two-sum',
          difficulty: 'EASY',
          url: 'https://leetcode.com/problems/two-sum/',
          ...extra,
        }
      }
      return createBackendClient(invoke).fetchDailyProblem()
    }

    // The description HTML is passed through untrimmed.
    await expect(fetchDaily({ content: ' <p>Given an array of integers…</p>\n' })).resolves.toMatchObject({
      content: ' <p>Given an array of integers…</p>\n',
    })
    await expect(fetchDaily({ content: null })).resolves.toMatchObject({ content: null })
    await expect(fetchDaily({})).resolves.toMatchObject({ content: null })
    await expect(fetchDaily({ content: '  \n\t ' })).resolves.toMatchObject({ content: null })
  })
})

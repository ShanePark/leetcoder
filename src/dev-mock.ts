import type {
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitFileChange,
  GitPushResult,
  ProblemFileEntry,
  ProjectValidation,
  TestCaseResult,
  TestDiagnostic,
  TestResult,
  TestRunProgressHandler,
} from './backend'
import type { ProblemFilePlan } from './domain'

/**
 * Browser-preview mock backend for visual verification (`vite dev` +
 * `?mock`). Inert in the desktop app: activation requires the absence of the
 * Tauri bridge AND the explicit `mock` query parameter.
 *
 * Scenarios via the parameter value: `?mock` (one failing test),
 * `?mock=pass`, `?mock=compile`, `?mock=notests`.
 */
export function isDevMockActive(): boolean {
  if (typeof window === 'undefined' || '__TAURI_INTERNALS__' in window) {
    return false
  }
  return new URLSearchParams(window.location.search).has('mock')
}

const MOCK_REPO_PATH = '/Users/shane/ps'

type MockScenario = 'fail' | 'pass' | 'compile' | 'notests'

function activeScenario(): MockScenario {
  const value = new URLSearchParams(window.location.search).get('mock')
  if (value === 'pass' || value === 'compile' || value === 'notests') {
    return value
  }
  return 'fail'
}

/** localStorage-compatible seeded store so the mock boots into a loaded repo. */
export function createDevMockStorage(): Storage {
  const data = new Map<string, string>([
    ['leetcoder.repository-path', MOCK_REPO_PATH],
  ])
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

const DAILY_PROBLEM: DailyProblem = {
  date: new Date().toISOString().slice(0, 10),
  frontendId: '3622',
  title: 'Check Divisibility by Digit Sum and Product',
  titleSlug: 'check-divisibility-by-digit-sum-and-product',
  difficulty: 'Easy',
  url: 'https://leetcode.com/problems/check-divisibility-by-digit-sum-and-product/',
  javaSnippet: 'class Solution {\n    public boolean checkDivisibility(int n) {\n        \n    }\n}',
  content: `
<p>You are given a positive integer <code>n</code>. Determine whether <code>n</code> is divisible by the <strong>sum</strong> of its digits <em>plus</em> the <strong>product</strong> of its digits.</p>
<p>Return <code>true</code> if it is divisible, and <code>false</code> otherwise.</p>
<pre>Input: n = 99
Output: true
Explanation: digit sum = 18, digit product = 81.
18 + 81 = 99 and 99 % 99 == 0.</pre>
<ul>
  <li><code>1 &lt;= n &lt;= 10<sup>6</sup></code></li>
  <li>The check uses base-10 digits.</li>
</ul>
`,
}

function javaSourceFor(className: string): string {
  return `package shane.leetcode.problems.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@SuppressWarnings("NewClassNamingConvention")
public class ${className} {

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
`
}

function seedFiles(): Map<string, string> {
  const names: Array<[string, string]> = [
    ['easy', 'Q1TwoSum'],
    ['easy', 'Q20ValidParentheses'],
    ['easy', 'Q88MergeSortedArray'],
    ['easy', 'Q121BestTimeToBuyAndSellStock'],
    ['easy', 'Q3606CouponCodeValidator'],
    ['easy', 'Q3618SplitArrayByPrimeIndices'],
    ['medium', 'Q2AddTwoNumbers'],
    ['medium', 'Q146LRUCache'],
    ['medium', 'Q200NumberOfIslands'],
    ['medium', 'Q3616NumberOfStudentsWithDifferentRanks'],
    ['xhard', 'Q4MedianOfTwoSortedArrays'],
    ['xhard', 'Q42TrappingRainWater'],
    ['xhard', 'Q3615LongestPalindromicPath'],
  ]
  const files = new Map<string, string>()
  for (const [segment, className] of names) {
    files.set(
      `src/main/java/shane/leetcode/problems/${segment}/${className}.java`,
      javaSourceFor(className).replace('problems.easy', `problems.${segment}`),
    )
  }
  files.set('src/main/java/shane/leetcode/problems/Scratch.java', 'package shane.leetcode.problems;\n\npublic class Scratch {\n}\n')
  return files
}

function entryFor(path: string): ProblemFileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const segment = /\/easy\//.test(path)
    ? 'easy'
    : /\/medium\//.test(path)
      ? 'medium'
      : /\/xhard\//.test(path)
        ? 'xhard'
        : 'other'
  return { path, name, packageSegment: segment }
}

const MODIFIED_DIFF = `diff --git a/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java b/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java
index 3f9c2b1..8a41d02 100644
--- a/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java
+++ b/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java
@@ -8,9 +8,11 @@ public class Q1TwoSum {
     public int[] twoSum(int[] nums, int target) {
-        for (int i = 0; i < nums.length; i++) {
-            for (int j = i + 1; j < nums.length; j++) {
-                if (nums[i] + nums[j] == target) return new int[]{i, j};
+        Map<Integer, Integer> seen = new HashMap<>();
+        for (int i = 0; i < nums.length; i++) {
+            Integer other = seen.get(target - nums[i]);
+            if (other != null) {
+                return new int[]{other, i};
             }
+            seen.put(nums[i], i);
         }
         throw new IllegalArgumentException("no solution");
     }
@@ -22,6 +24,7 @@ public class Q1TwoSum {
     @Test
     public void test() {
         assertThat(twoSum(new int[]{2, 7, 11, 15}, 9)).containsExactly(0, 1);
+        assertThat(twoSum(new int[]{3, 2, 4}, 6)).containsExactly(1, 2);
     }
 }
`

function addedDiffFor(path: string, source: string): string {
  const lines = source.split('\n')
  const body = lines.map((line) => `+${line}`).join('\n')
  return `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..b7e23a9
--- /dev/null
+++ b/${path}
@@ -0,0 +1,${lines.length} @@
${body}
`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createDevMockBackend(): BackendClient & {
  getGitStatus(repoPath: string): Promise<unknown>
} {
  const files = seedFiles()
  const gitAddedPath = 'src/main/java/shane/leetcode/problems/easy/Q3618SplitArrayByPrimeIndices.java'
  let gitChanges: Array<GitFileChange & { additions: number | null; deletions: number | null }> = [
    {
      path: 'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      status: 'modified',
      indexStatus: '.',
      worktreeStatus: 'M',
      additions: 12,
      deletions: 4,
    },
    {
      path: gitAddedPath,
      status: 'added',
      indexStatus: 'A',
      worktreeStatus: '.',
      additions: 58,
      deletions: 0,
    },
    {
      path: 'notes/scratchpad.md',
      status: 'untracked',
      indexStatus: '?',
      worktreeStatus: '?',
      additions: null,
      deletions: null,
    },
  ]

  return {
    async validateProject(): Promise<ProjectValidation> {
      return { valid: true }
    },

    async fetchDailyProblem(): Promise<DailyProblem> {
      await delay(350)
      return DAILY_PROBLEM
    },

    async listProblemFiles(): Promise<ProblemFileEntry[]> {
      return [...files.keys()].sort().map(entryFor)
    },

    async readProblemFile(_repoPath: string, path: string): Promise<string> {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      return source
    },

    async createProblemFile(_repoPath: string, plan: ProblemFilePlan): Promise<void> {
      files.set(plan.path, plan.source)
    },

    async saveProblemFile(_repoPath: string, path: string, content: string): Promise<void> {
      await delay(120)
      files.set(path, content)
    },

    async deleteProblemFile(_repoPath: string, path: string): Promise<void> {
      files.delete(path)
    },

    async getGitStatus(): Promise<unknown> {
      await delay(150)
      return { branch: 'main', files: gitChanges }
    },

    async listGitChanges(): Promise<GitFileChange[]> {
      return gitChanges
    },

    async getGitDiff(_repoPath: string, paths: string[]): Promise<string> {
      await delay(150)
      return paths
        .map((path) => {
          if (path.endsWith('Q1TwoSum.java')) {
            return MODIFIED_DIFF
          }
          const source = files.get(path) ?? '# scratch notes\n\n- revisit DP problems\n'
          return addedDiffFor(path, source)
        })
        .join('')
    },

    async commitGit(_repoPath: string, paths: string[], message: string): Promise<GitCommitResult> {
      await delay(300)
      gitChanges = gitChanges.filter((change) => !paths.includes(change.path))
      return { commitHash: 'a1b2c3d4e5f60789', message, paths }
    },

    async pushGit(): Promise<GitPushResult> {
      await delay(500)
      return { output: 'To github.com:shane/ps.git', branch: 'main' }
    },

    async runProblemTest(
      _repoPath: string,
      fullyQualifiedClassName: string,
      onProgress?: TestRunProgressHandler,
    ): Promise<TestResult> {
      const scenario = activeScenario()
      const sourceFile = `src/main/java/${fullyQualifiedClassName.replace(/\./g, '/')}.java`
      const emit = onProgress ?? ((): void => {})
      emit({ kind: 'started' })
      emit({ kind: 'phase', phase: 'compiling' })
      await delay(600)

      if (scenario === 'compile') {
        const diagnostics: TestDiagnostic[] = [
          {
            severity: 'error',
            message: 'cannot find symbol\n  symbol:   method checkDivisibilty(int)\n  location: class Solution',
            file: sourceFile,
            line: 24,
            column: 27,
            origin: 'javac',
            sourceLine: '        assertThat(checkDivisibilty(99)).isTrue();',
            caret: '                          ^',
          },
          {
            severity: 'error',
            message: "';' expected",
            file: sourceFile,
            line: 25,
            column: 48,
            origin: 'javac',
            sourceLine: '        assertThat(checkDivisibility(23)).isFalse()',
            caret: '                                               ^',
          },
        ]
        emit({ kind: 'log', stream: 'stderr', text: `${sourceFile}:24: error: cannot find symbol\n` })
        return {
          success: false,
          phase: 'compile',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 640 },
          tests: [],
          diagnostics,
          stdout: '',
          stderr: `${sourceFile}:24: error: cannot find symbol\n2 errors\n`,
          exitCode: 1,
        }
      }

      emit({ kind: 'phase', phase: 'runningTests' })
      if (scenario === 'notests') {
        await delay(400)
        return {
          success: false,
          phase: 'noTests',
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 1040 },
          tests: [],
          diagnostics: [],
          stdout: '> Task :test\n',
          stderr: '',
          exitCode: 0,
        }
      }

      const failing = scenario === 'fail'
      const cases: TestCaseResult[] = [
        { name: 'test()', className: fullyQualifiedClassName, displayName: 'test()', status: 'passed', durationMs: 18 },
        { name: 'testSmallNumbers()', className: fullyQualifiedClassName, displayName: 'testSmallNumbers()', status: 'passed', durationMs: 3 },
        {
          name: 'testSortedOutput()',
          className: fullyQualifiedClassName,
          displayName: 'testSortedOutput()',
          status: failing ? 'failed' : 'passed',
          durationMs: 41,
          ...(failing
            ? {
              message: 'expected: [1, 2, 3] but was: [1, 2, 4]',
              details: 'org.opentest4j.AssertionFailedError: expected: [1, 2, 3] but was: [1, 2, 4]\n'
                + `    at ${fullyQualifiedClassName}.testSortedOutput(${sourceFile.slice(sourceFile.lastIndexOf('/') + 1)}:31)\n`
                + '    at org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:38)\n'
                + '    at java.base/java.lang.reflect.Method.invoke(Method.java:565)',
              expected: '[1, 2, 3]',
              actual: '[1, 2, 4]',
              stdout: 'sorting input [3, 1, 2]\ncomparing result…\n',
              file: sourceFile,
              line: 31,
              column: 9,
            }
            : { stdout: 'sorting input [3, 1, 2]\n' }),
        },
        { name: 'testLargeInput()', className: fullyQualifiedClassName, displayName: 'testLargeInput()', status: 'passed', durationMs: 122 },
        { name: 'testEdgeCases()', className: fullyQualifiedClassName, displayName: 'testEdgeCases()', status: 'passed', durationMs: 7 },
      ]
      for (const test of cases) {
        emit({ kind: 'testStarted', test: { ...test, status: 'running' } })
        await delay(140)
        emit({ kind: 'testFinished', test })
      }
      emit({ kind: 'log', stream: 'stdout', text: '> Task :test\nBUILD ' + (failing ? 'FAILED' : 'SUCCESSFUL') + ' in 1s\n' })
      await delay(120)
      const failed = cases.filter((test) => test.status === 'failed').length
      return {
        success: failed === 0,
        phase: 'test',
        summary: {
          total: cases.length,
          passed: cases.length - failed,
          failed,
          skipped: 0,
          errors: 0,
          durationMs: 1460,
        },
        tests: cases,
        diagnostics: [],
        stdout: `> Task :test\nBUILD ${failing ? 'FAILED' : 'SUCCESSFUL'} in 1s\n`,
        stderr: failing ? '5 tests completed, 1 failed\n' : '',
        exitCode: failed === 0 ? 0 : 1,
      }
    },
  }
}

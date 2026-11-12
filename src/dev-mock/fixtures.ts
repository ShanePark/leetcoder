import type { AiModel, AiReview, AiReviewResult, DailyProblem } from '../backend'

export const DAILY_PROBLEM: DailyProblem = {
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

export const MANUAL_PROBLEM: DailyProblem = {
  date: '',
  frontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  difficulty: 'Easy',
  url: 'https://leetcode.com/problems/two-sum/',
  javaSnippet: `class Solution {
    public int[] twoSum(int[] nums, int target) {

    }
}`,
  content: '<p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return indices of the two numbers such that they add up to <code>target</code>.</p>',
}

export const AI_MODELS: readonly AiModel[] = [
  {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    deprecated: false,
    superseded: false,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  },
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    deprecated: false,
    superseded: false,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
  {
    id: 'claude-haiku-5',
    displayName: 'Claude Haiku 5',
    deprecated: false,
    superseded: false,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  },
  // The price cache has no entry for this model.
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', deprecated: true, superseded: true, pricing: null },
]

export const AI_DEFAULT_MODEL_ID = 'claude-sonnet-5-5'

/** Example assertions for the methods the preview's problems and seed files declare. */
export const AI_STATEMENTS = new Map<string, readonly string[]>([
  ['checkDivisibility', [
    'assertThat(checkDivisibility(99)).isTrue();',
    'assertThat(checkDivisibility(23)).isFalse();',
  ]],
  ['twoSum', [
    'assertThat(twoSum(new int[]{2, 7, 11, 15}, 9)).containsExactly(0, 1);',
    'assertThat(twoSum(new int[]{3, 2, 4}, 6)).containsExactly(1, 2);',
    'assertThat(twoSum(new int[]{3, 3}, 6)).containsExactly(0, 1);',
  ]],
])

/** One preview ledger record. A null cost means no price was known for the model. */
export interface AiUsageEntry {
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
  approximate: boolean
  refused: boolean
}

/** The record each preview generation appends. */
export const AI_GENERATION_USAGE: Omit<AiUsageEntry, 'ts' | 'model'> = {
  inputTokens: 1_310,
  outputTokens: 118,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0057,
  approximate: false,
  refused: false,
}

/** The tokens of each preview review, priced by the served model. A review sends the whole file and writes prose. */
export const AI_REVIEW_TOKENS: Omit<AiReviewResult['usage'], 'costUsd'> = {
  inputTokens: 2_480,
  outputTokens: 412,
  cacheReadTokens: 1_650,
  cacheWriteTokens: 0,
}

/** The preview review of code whose tests passed, or that was sent without a run. */
export const AI_REVIEW: AiReview = {
  verdict: 'unsure',
  summary: 'The approach is right, but the result depends on map lookups that the tests only partly cover.',
  failureCause: null,
  issues: [
    'The complement is looked up after the current value is stored, so a value that is half of the target can match itself.',
  ],
  missedCases: [
    { input: 'nums = [3,2,4], target = 6', reason: 'Index 0 pairs with itself because 3 + 3 = 6.' },
    { input: 'nums = [3,3], target = 6', reason: 'Duplicate values share one map entry.' },
  ],
  efficiency: {
    time: 'O(n)',
    space: 'O(n)',
    assessment: 'One pass over at most 10^4 numbers fits the limits easily.',
  },
  improvements: ['Look up the complement before storing the current value.'],
}

/** The preview review of code whose last run failed. */
export const AI_FAILING_REVIEW: AiReview = {
  ...AI_REVIEW,
  verdict: 'incorrect',
  summary: 'The failing test catches a real bug: an element can be paired with itself.',
  failureCause:
    'For nums = [3,2,4] and target = 6, the value 3 is stored before its complement is checked, so the method returns [0, 0] instead of [1, 2].',
}

export function seedAiUsage(now: number): AiUsageEntry[] {
  const day = 86_400_000
  const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, approximate: false, refused: false }
  return [
    { ...usage, ts: now, model: 'claude-sonnet-5-5', inputTokens: 1_933, outputTokens: 118, costUsd: 0.0076 },
    { ...usage, ts: now, model: 'claude-opus-5-5', inputTokens: 2_410, outputTokens: 96, cacheReadTokens: 1_200, costUsd: 0.0361 },
    { ...usage, ts: now, model: 'claude-haiku-5', inputTokens: 1_420, outputTokens: 20, costUsd: 0.0016 },
    { ...usage, ts: now - day, model: 'claude-sonnet-5-5', inputTokens: 1_480, outputTokens: 132, costUsd: 0.0064 },
    { ...usage, ts: now - 2 * day, model: 'claude-opus-5-5', inputTokens: 3_120, outputTokens: 240, costUsd: 0.0576 },
    { ...usage, ts: now - 3 * day, model: 'claude-sonnet-5-5', inputTokens: 2_050, outputTokens: 214, costUsd: 0.0094, approximate: true },
    { ...usage, ts: now - 5 * day, model: 'claude-haiku-5', inputTokens: 1_120, outputTokens: 96, costUsd: null },
    { ...usage, ts: now - 6 * day, model: 'claude-sonnet-5-5', inputTokens: 1_390, outputTokens: 12, costUsd: 0, refused: true },
    { ...usage, ts: now - 8 * day, model: 'claude-sonnet-5-5', inputTokens: 2_640, outputTokens: 310, costUsd: 0.0126 },
    { ...usage, ts: now - 8 * day, model: 'claude-haiku-5', inputTokens: 980, outputTokens: 88, costUsd: 0.0012 },
    { ...usage, ts: now - 11 * day, model: 'claude-opus-5-5', inputTokens: 1_760, outputTokens: 142, costUsd: 0.0243 },
    { ...usage, ts: now - 20 * day, model: 'claude-sonnet-5-5', inputTokens: 3_300, outputTokens: 402, costUsd: 0.0160 },
    { ...usage, ts: now - 41 * day, model: 'claude-sonnet-5-5', inputTokens: 1_900, outputTokens: 170, costUsd: 0.0082 },
    { ...usage, ts: now - 70 * day, model: 'claude-sonnet-4-5', inputTokens: 1_640, outputTokens: 150, costUsd: null },
  ]
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

export function seedFiles(): Map<string, string> {
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

export const MODIFIED_DIFF = `diff --git a/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java b/src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java
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

export function addedDiffFor(path: string, source: string): string {
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

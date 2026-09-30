import type { DailyProblem } from '../backend'

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

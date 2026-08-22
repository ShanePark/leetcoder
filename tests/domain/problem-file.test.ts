import { describe, expect, it } from 'vitest'

import {
  planProblemFile,
  renderJavaProblemSource,
} from '../../src/domain'

describe('renderJavaProblemSource', () => {
  it('renders the agreed template with a method signature', () => {
    const source = renderJavaProblemSource(
      'shane.leetcode.problems.easy',
      'Q3622CheckDivisibilityByDigitSumAndProduct',
      'public boolean checkDivisibility(int n)',
    )

    expect(source).toBe(`package shane.leetcode.problems.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q3622CheckDivisibilityByDigitSumAndProduct {

    @Test
    public void test() {
        assertThat()
    }

    public boolean checkDivisibility(int n) {

    }
}
`)
    expect(source).not.toContain('assertThat();')
  })

  it('renders only the class and test when no signature is available', () => {
    const source = renderJavaProblemSource(
      'shane.leetcode.problems.medium',
      'Q123Example',
      null,
    )

    expect(source).toBe(`package shane.leetcode.problems.medium;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q123Example {

    @Test
    public void test() {
        assertThat()
    }
}
`)
  })
})

describe('planProblemFile', () => {
  it('returns package, path, FQCN, collision-safe name, source, and signature', () => {
    const plan = planProblemFile(
      {
        number: 3622,
        title: 'Check Divisibility by Digit Sum and Product',
        difficulty: 'Hard',
        javaCodeSnippet: 'class Solution { public boolean checkDivisibility(int n) { return true; } }',
      },
      [
        'src/main/java/shane/leetcode/problems/xhard/Q3622CheckDivisibilityByDigitSumAndProduct.java',
        'src/main/kotlin/shane/leetcode/problems/xhard/Q3622CheckDivisibilityByDigitSumAndProduct2.kt',
      ],
    )

    expect(plan).toMatchObject({
      problemNumber: '3622',
      title: 'Check Divisibility by Digit Sum and Product',
      difficulty: 'HARD',
      baseClassName: 'Q3622CheckDivisibilityByDigitSumAndProduct',
      className: 'Q3622CheckDivisibilityByDigitSumAndProduct3',
      packageSegment: 'xhard',
      packageName: 'shane.leetcode.problems.xhard',
      fullyQualifiedClassName: 'shane.leetcode.problems.xhard.Q3622CheckDivisibilityByDigitSumAndProduct3',
      fileName: 'Q3622CheckDivisibilityByDigitSumAndProduct3.java',
      path: 'src/main/java/shane/leetcode/problems/xhard/Q3622CheckDivisibilityByDigitSumAndProduct3.java',
      methodSignature: 'public boolean checkDivisibility(int n)',
    })
    expect(plan.source).toContain('public boolean checkDivisibility(int n) {')
  })

  it('checks suffix collisions only in the destination difficulty package', () => {
    const existing = [
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      'src/main/java/shane/leetcode/problems/medium/Q1TwoSum.java',
    ]

    const easyPlan = planProblemFile({
      number: 1,
      title: 'Two Sum',
      difficulty: 'EASY',
    }, existing)
    const mediumPlan = planProblemFile({
      number: 1,
      title: 'Two Sum',
      difficulty: 'MEDIUM',
    }, existing)

    expect(easyPlan.className).toBe('Q1TwoSum2')
    expect(mediumPlan.className).toBe('Q1TwoSum2')
  })

  it('falls back to the test-only template when LeetCode has no usable method', () => {
    const plan = planProblemFile({
      number: '123',
      title: 'Design Something',
      difficulty: 'MEDIUM',
      javaCodeSnippet: 'class Solution { private int state; }',
    })

    expect(plan.methodSignature).toBeNull()
    expect(plan.source).not.toContain('public int')
    expect(plan.source).toContain('assertThat()\n    }\n}')
  })
})

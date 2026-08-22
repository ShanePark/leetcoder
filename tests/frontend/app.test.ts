import { describe, expect, it } from 'vitest'

import { fqcnFromJavaPath } from '../../src/app'

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

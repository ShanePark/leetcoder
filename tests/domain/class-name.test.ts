import { describe, expect, it } from 'vitest'

import {
  classNameFromProblem,
  nextClassName,
  packageForDifficulty,
} from '../../src/domain'

describe('classNameFromProblem', () => {
  it('matches the repository ClassNameFactory convention', () => {
    expect(classNameFromProblem('3622', 'Check Divisibility by Digit Sum and Product'))
      .toBe('Q3622CheckDivisibilityByDigitSumAndProduct')
  })

  it('adds an underscore when the title starts with a digit', () => {
    expect(classNameFromProblem(3, '3Sum')).toBe('Q3_3Sum')
  })

  it('treats Unicode decimal digits like Java Character.isDigit', () => {
    expect(classNameFromProblem(1, '٣Sum')).toBe('Q1_٣Sum')
  })

  it('removes punctuation while preserving the token-index capitalization rule', () => {
    expect(classNameFromProblem(1, "two (sum) / it's-good"))
      .toBe('Q1TwosumItsgood')
  })
})

describe('nextClassName', () => {
  it('considers both Java and Kotlin files when finding the next suffix', () => {
    const existing = [
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      'src/main/kotlin/shane/leetcode/problems/easy/Q1TwoSum2.kt',
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum4.java',
      'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.txt',
    ]

    expect(nextClassName('Q1TwoSum', existing)).toBe('Q1TwoSum3')
  })

  it('uses the base name when it is free, even if a suffixed name exists', () => {
    expect(nextClassName('Q1TwoSum', ['Q1TwoSum2.kt'])).toBe('Q1TwoSum')
  })

  it('starts at two when the base name exists', () => {
    expect(nextClassName('Q1TwoSum', ['Q1TwoSum.java'])).toBe('Q1TwoSum2')
  })
})

describe('packageForDifficulty', () => {
  it.each([
    ['EASY', 'easy'],
    ['Easy', 'easy'],
    ['medium', 'medium'],
    ['HARD', 'xhard'],
  ])('maps %s to %s', (difficulty, packageSegment) => {
    expect(packageForDifficulty(difficulty)).toBe(packageSegment)
  })

  it('rejects an unknown difficulty', () => {
    expect(() => packageForDifficulty('unknown')).toThrow('Unsupported LeetCode difficulty')
  })
})

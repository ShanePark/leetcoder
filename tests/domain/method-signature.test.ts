import { describe, expect, it } from 'vitest'

import { extractJavaMethodSignature } from '../../src/domain'

describe('extractJavaMethodSignature', () => {
  it('extracts a normal Solution method without its body', () => {
    const snippet = `
      class Solution {
          public boolean checkDivisibility(int n) {
              return true;
          }
      }
    `

    expect(extractJavaMethodSignature(snippet)).toBe('public boolean checkDivisibility(int n)')
  })

  it('normalizes a multiline signature and keeps throws declarations', () => {
    const snippet = `class Solution {
      public List<List<Integer>> fourSum(
          int[] nums,
          long target
      ) throws IOException {
          return List.of();
      }
    }`

    expect(extractJavaMethodSignature(snippet))
      .toBe('public List<List<Integer>> fourSum(int[] nums, long target) throws IOException')
  })

  it('ignores fields, nested classes, comments, and braces inside literals', () => {
    const snippet = `
      class Solution {
          private int count = 0;
          @SuppressWarnings("unused")
          class Helper {
              String value = "not a { method }";
          }
          // public boolean fake() { }
          public boolean actual(String input) {
              String text = "{ still inside the method }";
              return text.length() > input.length();
          }
      }
    `

    expect(extractJavaMethodSignature(snippet)).toBe('public boolean actual(String input)')
  })

  it('prefers the public entry point when a private helper appears first', () => {
    const snippet = `class Solution {
      private int helper(int value) { return value; }
      public int solve(int value) { return helper(value); }
    }`

    expect(extractJavaMethodSignature(snippet)).toBe('public int solve(int value)')
  })

  it('supports a package-private method with a single-token return type', () => {
    const snippet = 'class Solution { boolean solve(int value) { return value > 0; } }'

    expect(extractJavaMethodSignature(snippet)).toBe('boolean solve(int value)')
  })

  it('returns no signature for unsupported or malformed snippets', () => {
    expect(extractJavaMethodSignature('public int[] twoSum(int[] nums) { return nums; }')).toBeNull()
    expect(extractJavaMethodSignature('class Solution { int value; }')).toBeNull()
    expect(extractJavaMethodSignature('class Solution { Solution(int value) { } }')).toBeNull()
    expect(extractJavaMethodSignature('class Solution { public Solution(int value) { } }')).toBeNull()
    expect(extractJavaMethodSignature('class Solution { public boolean broken(int n) ')).toBeNull()
    expect(extractJavaMethodSignature(null)).toBeNull()
  })
})

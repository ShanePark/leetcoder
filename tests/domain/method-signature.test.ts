import { describe, expect, it } from 'vitest'

import { extractJavaMethodSignature } from '../../src/domain'
import { declaresJavaSolutionConstructor } from '../../src/domain/method-signature'

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

describe('declaresJavaSolutionConstructor', () => {
  it.each([
    ['a public constructor', 'class Solution {\n  public Solution(int[] nums) {\n  }\n  public int[] reset() {\n  }\n}'],
    ['a constructor after other members', 'class Solution {\n  private int n;\n  public int f() {\n  }\n  public Solution() {\n  }\n}'],
    ['a package-private constructor', 'class Solution {\n  Solution(int n) {\n  }\n}'],
    ['a multiline constructor', 'class Solution {\n  public Solution(\n    int[] nums\n  ) {\n  }\n}'],
    ['an annotated constructor', 'class Solution {\n  @Inject(name = "x")\n  public Solution(int n) {\n  }\n}'],
    ['a generic constructor', 'class Solution {\n  public <T extends Comparable<T>> Solution(T value) {\n  }\n}'],
    ['space before the parenthesis', 'class Solution {\n  public Solution (int n) {\n  }\n}'],
  ])('finds %s', (_label, snippet) => {
    expect(declaresJavaSolutionConstructor(snippet)).toBe(true)
  })

  it.each([
    ['a normal class', 'class Solution {\n  public int f(int n) {\n  }\n}'],
    ['a line comment', 'class Solution {\n  // public Solution(int n) {\n  public int f() {\n  }\n}'],
    ['a block comment', '/* class Solution { Solution() {} } */\nclass Solution {\n  /* Solution(int n) { */\n  public int f() {\n  }\n}'],
    ['a parameter type', 'class Solution {\n  public int f(Solution other) {\n  }\n}'],
    ['a return type', 'class Solution {\n  public Solution copy() {\n  }\n}'],
    ['a field initializer', 'class Solution {\n  Solution next = new Solution(1);\n  public int f() {\n  }\n}'],
    ['an anonymous class field', 'class Solution {\n  Solution next = new Solution(1) {\n  };\n  public int f() {\n  }\n}'],
    ['a call in a body', 'class Solution {\n  public int f() {\n    Solution(1);\n    return 0;\n  }\n}'],
    ['a string literal', 'class Solution {\n  String s = "Solution(int n) {";\n  public int f() {\n  }\n}'],
    ['a nested class constructor', 'class Solution {\n  class Node {\n    Node(int n) {\n    }\n  }\n  public int f() {\n  }\n}'],
    ['another class', 'class LRUCache {\n  public LRUCache(int capacity) {\n  }\n}'],
    ['no snippet', null],
    ['an empty snippet', '   '],
  ])('ignores %s', (_label, snippet) => {
    expect(declaresJavaSolutionConstructor(snippet)).toBe(false)
  })

  it('leaves the signature extraction of a constructor snippet unchanged', () => {
    const snippet = 'class Solution {\n  public Solution(int[] nums) {\n  }\n  public int[] reset() {\n  }\n}'
    expect(extractJavaMethodSignature(snippet)).toBe('public int[] reset()')
  })
})

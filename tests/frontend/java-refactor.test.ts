import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  planJavaMethodExtraction,
  type JavaMethodExtractionPlan,
  type JavaRefactorChange,
} from '../../src/java-refactor'

function applyChanges(source: string, changes: readonly JavaRefactorChange[]): string {
  return [...changes]
    .sort((left, right) => right.from - left.from)
    .reduce((result, change) => (
      result.slice(0, change.from) + change.insert + result.slice(change.to)
    ), source)
}

function planned(source: string, from: number, to: number, name?: string): JavaMethodExtractionPlan {
  const result = planJavaMethodExtraction(source, from, to, name)
  if ('reason' in result) throw new Error(result.reason)
  return result
}

function compileJavaIfAvailable(source: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'leetcoder-java-refactor-'))
  try {
    const file = join(directory, 'Solution.java')
    writeFileSync(file, source)
    try {
      execFileSync('javac', ['-d', directory, file], { stdio: 'pipe' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Java Extract Method planner', () => {
  it('extracts a typed array expression and passes its parameter', () => {
    const source = [
      'class Solution {',
      '    public int firstStableIndex(int[] nums, int k) {',
      '        return nums[nums.length - 1];',
      '    }',
      '}',
      '',
    ].join('\n')
    const expression = 'nums[nums.length - 1]'
    const from = source.indexOf(expression)
    const plan = planned(source, from, from + expression.length, 'lastElement')
    const transformed = applyChanges(source, plan.changes)

    expect(transformed).toBe([
      'class Solution {',
      '    public int firstStableIndex(int[] nums, int k) {',
      '        return lastElement(nums);',
      '    }',
      '    private int lastElement(int[] nums) {',
      '        return nums[nums.length - 1];',
      '    }',
      '}',
      '',
    ].join('\n'))
    expect(plan.nameRanges).toHaveLength(2)
    expect(plan.nameRanges.map((range) => transformed.slice(range.from, range.to))).toEqual([
      'lastElement', 'lastElement',
    ])
    compileJavaIfAvailable(transformed)
  })

  it('extracts complete loop statements into a void helper', () => {
    const source = [
      'class Solution {',
      '    public int firstStableIndex(int[] nums) {',
      '        int[] min = new int[nums.length];',
      '        for (int i = nums.length - 1; i >= 0; i--) {',
      '            min[i] = nums[i];',
      '        }',
      '        return 0;',
      '    }',
      '}',
      '',
    ].join('\n')
    const from = source.indexOf('        int[] min')
    const end = source.indexOf('        return 0;')
    const selected = source.slice(from, end).trimEnd()
    const plan = planned(source, from, from + selected.length, 'fillMinimums')
    const transformed = applyChanges(source, plan.changes)

    expect(transformed).toBe([
      'class Solution {',
      '    public int firstStableIndex(int[] nums) {',
      '        fillMinimums(nums);',
      '        return 0;',
      '    }',
      '    private void fillMinimums(int[] nums) {',
      '        int[] min = new int[nums.length];',
      '        for (int i = nums.length - 1; i >= 0; i--) {',
      '            min[i] = nums[i];',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'))
    compileJavaIfAvailable(transformed)
  })

  it('returns one live-out local from a selected statement block', () => {
    const source = [
      'class Solution {',
      '    public int calculate(int[] nums) {',
      '        int value = nums[0];',
      '        value += 1;',
      '        return value;',
      '    }',
      '}',
      '',
    ].join('\n')
    const from = source.indexOf('        int value')
    const end = source.indexOf('        return value;')
    const selected = source.slice(from, end).trimEnd()
    const plan = planned(source, from, from + selected.length, 'calculateValue')
    const transformed = applyChanges(source, plan.changes)

    expect(transformed).toBe([
      'class Solution {',
      '    public int calculate(int[] nums) {',
      '        int value = calculateValue(nums);',
      '        return value;',
      '    }',
      '    private int calculateValue(int[] nums) {',
      '        int value = nums[0];',
      '        value += 1;',
      '        return value;',
      '    }',
      '}',
      '',
    ].join('\n'))
  })

  it('accepts complete siblings inside a nested block', () => {
    const source = [
      'class Solution {',
      '    void visit(int[] nums) {',
      '        for (int number : nums) {',
      '            int doubled = number * 2;',
      '            System.out.println(doubled);',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n')
    const from = source.indexOf('            int doubled')
    const end = source.indexOf('        }', from)
    const selected = source.slice(from, end).trimEnd()
    const plan = planned(source, from, from + selected.length, 'printDouble')
    const transformed = applyChanges(source, plan.changes)
    expect(transformed).toContain('printDouble(number);')
    expect(transformed).toContain('private void printDouble(int number)')
  })

  it('rejects partial statements and multiple live-out values', () => {
    const source = [
      'class Solution {',
      '    int calculate(int[] nums) {',
      '        int left = nums[0];',
      '        int right = nums[1];',
      '        return left + right;',
      '    }',
      '}',
    ].join('\n')
    const partial = source.indexOf('left =') + 2
    const partialResult = planJavaMethodExtraction(source, partial, partial + 4)
    expect('reason' in partialResult).toBe(true)

    const from = source.indexOf('        int left')
    const end = source.indexOf('        return left')
    const selected = source.slice(from, end).trimEnd()
    const multiple = planJavaMethodExtraction(source, from, from + selected.length)
    expect(multiple).toEqual({ reason: 'The selected statements produce more than one value.' })
  })

  it('rejects a block that transfers control to the caller', () => {
    const source = 'class Solution { int f(int[] nums) { for (int n : nums) { if (n < 0) break; } return 0; } }'
    const from = source.indexOf('for (')
    const to = source.indexOf(' return 0')
    const result = planJavaMethodExtraction(source, from, to)
    expect('reason' in result).toBe(true)
  })
})

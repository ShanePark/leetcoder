import { describe, expect, it } from 'vitest'

import { findIndexedProblemFile, indexProblemFiles } from '../../../src/app/file-index'
import type { ProblemFileEntry } from '../../../src/backend'

describe('problem file index', () => {
  it('matches equivalent separator and relative-prefix variants', () => {
    const file: ProblemFileEntry = {
      path: 'src/main/java/easy/Q1TwoSum.java',
      name: 'Q1TwoSum.java',
      packageSegment: 'easy',
    }
    const index = indexProblemFiles([file])

    expect(findIndexedProblemFile(index, './src\\main\\java\\easy\\Q1TwoSum.java')).toBe(file)
  })

  it('keeps the first entry for duplicate canonical paths like Array.find', () => {
    const first: ProblemFileEntry = {
      path: 'src/Q1.java',
      name: 'Q1.java',
      packageSegment: 'easy',
    }
    const second: ProblemFileEntry = {
      ...first,
      path: './src\\Q1.java',
    }
    const index = indexProblemFiles([first, second])

    expect(findIndexedProblemFile(index, 'src/Q1.java')).toBe(first)
  })

  it('indexes case-distinct files independently', () => {
    const first: ProblemFileEntry = {
      path: 'src/Q1TwoSum.java',
      name: 'Q1TwoSum.java',
      packageSegment: 'easy',
    }
    const second: ProblemFileEntry = {
      ...first,
      path: 'src/Q1Twosum.java',
      name: 'Q1Twosum.java',
    }
    const index = indexProblemFiles([first, second])

    expect(index.size).toBe(2)
    expect(findIndexedProblemFile(index, first.path)).toBe(first)
    expect(findIndexedProblemFile(index, second.path)).toBe(second)
    expect(findIndexedProblemFile(index, 'src/Q1TWOSUM.java')).toBeUndefined()
  })

  it('returns undefined for a path that was not indexed', () => {
    const index = indexProblemFiles([])

    expect(findIndexedProblemFile(index, 'src/Q1.java')).toBeUndefined()
  })
})

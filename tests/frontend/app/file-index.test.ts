import { describe, expect, it } from 'vitest'

import { findIndexedProblemFile, indexProblemFiles } from '../../../src/app/file-index'
import type { ProblemFileEntry } from '../../../src/backend'

describe('problem file index', () => {
  it('matches canonical case and separator variants', () => {
    const file: ProblemFileEntry = {
      path: 'src/main/java/easy/Q1TwoSum.java',
      name: 'Q1TwoSum.java',
      packageSegment: 'easy',
    }
    const index = indexProblemFiles([file])

    expect(findIndexedProblemFile(index, './SRC\\MAIN\\JAVA\\EASY\\Q1TWOSUM.JAVA')).toBe(file)
  })

  it('keeps the first entry for duplicate canonical paths like Array.find', () => {
    const first: ProblemFileEntry = {
      path: 'src/Q1.java',
      name: 'Q1.java',
      packageSegment: 'easy',
    }
    const second: ProblemFileEntry = {
      ...first,
      path: './SRC\\Q1.JAVA',
      name: 'Q1.JAVA',
    }
    const index = indexProblemFiles([first, second])

    expect(findIndexedProblemFile(index, 'src/Q1.java')).toBe(first)
  })

  it('returns undefined for a path that was not indexed', () => {
    const index = indexProblemFiles([])

    expect(findIndexedProblemFile(index, 'src/Q1.java')).toBeUndefined()
  })
})

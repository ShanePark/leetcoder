import { describe, expect, it } from 'vitest'

import { selectedGitFiles } from '../../../src/app/git-view'
import type { GitChangedFile } from '../../../src/app/types'

describe('Git selection indexing', () => {
  it('filters changed files in repository order with constant-time membership checks', () => {
    const files: GitChangedFile[] = [
      { path: 'Q1.java', status: 'modified', staged: false, additions: null, deletions: null },
      { path: 'Q2.java', status: 'added', staged: false, additions: 2, deletions: null },
      { path: 'Q3.java', status: 'deleted', staged: true, additions: null, deletions: 3 },
    ]

    expect(selectedGitFiles(files, new Set(['Q3.java', 'missing.java', 'Q1.java']))).toEqual([
      files[0],
      files[2],
    ])
  })
})

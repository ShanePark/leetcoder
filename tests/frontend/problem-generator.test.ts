import { describe, expect, it, vi } from 'vitest'

import { createProblemWithRetry } from '../../src/problem-generator'
import type { BackendClient, ProblemFileEntry } from '../../src/backend'

function entry(path: string): ProblemFileEntry {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    packageSegment: 'medium',
  }
}

describe('createProblemWithRetry', () => {
  it('uses Kotlin collisions when choosing the next Java suffix', async () => {
    const existing = [
      entry('src/main/java/shane/leetcode/problems/medium/Q3362ZeroArrayTransformation.java'),
      entry('src/main/java/shane/leetcode/problems/medium/Q3362ZeroArrayTransformation2.java'),
      entry('src/main/java/shane/leetcode/problems/medium/Q3362ZeroArrayTransformation3.java'),
      entry('src/main/java/shane/leetcode/problems/medium/Q3362ZeroArrayTransformation4.java'),
      entry('src/main/kotlin/shane/leetcode/problems/medium/Q3362ZeroArrayTransformation5.kt'),
    ]
    const createProblemFile = vi.fn().mockResolvedValue(undefined)
    const backend = {
      listProblemFiles: vi.fn().mockResolvedValue(existing),
      createProblemFile,
    } as unknown as BackendClient

    const plan = await createProblemWithRetry(backend, '/repo', {
      number: '3362',
      title: 'Zero Array Transformation',
      difficulty: 'MEDIUM',
    })

    expect(plan.className).toBe('Q3362ZeroArrayTransformation6')
    expect(createProblemFile).toHaveBeenCalledWith('/repo', expect.objectContaining({
      className: 'Q3362ZeroArrayTransformation6',
      path: expect.stringContaining('Q3362ZeroArrayTransformation6.java'),
    }))
  })

  it('refreshes the list and retries when another process wins the suffix race', async () => {
    const firstListing = [entry('src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java')]
    const secondListing = [
      ...firstListing,
      entry('src/main/java/shane/leetcode/problems/easy/Q1TwoSum2.java'),
    ]
    const listProblemFiles = vi.fn()
      .mockResolvedValueOnce(firstListing)
      .mockResolvedValueOnce(secondListing)
    const createProblemFile = vi.fn()
      .mockRejectedValueOnce(new Error('file already exists'))
      .mockResolvedValueOnce(undefined)
    const backend = { listProblemFiles, createProblemFile } as unknown as BackendClient

    const plan = await createProblemWithRetry(backend, '/repo', {
      number: '1',
      title: 'Two Sum',
      difficulty: 'EASY',
    })

    expect(plan.className).toBe('Q1TwoSum3')
    expect(listProblemFiles).toHaveBeenCalledTimes(2)
    expect(createProblemFile).toHaveBeenCalledTimes(2)
  })
})

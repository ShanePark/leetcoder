import { describe, expect, it } from 'vitest'

import { createBackendClient, type Invoke } from '../../../src/backend'

describe('project search backend', () => {
  it('passes supplied exclusions and normalizes the native search result', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('search_project')
      expect(args).toEqual({
        repoPath: '/repo',
        query: 'needle',
        caseSensitive: false,
        excludePaths: ['src/Main.java', 'README.md'],
      })
      return {
        matches: [
          {
            path: 'src/Main.java',
            line: 12,
            column: 5,
            preview: '😀 needle found',
          },
        ],
        truncated: false,
        skippedFiles: 2,
      }
    }

    await expect(
      createBackendClient(invoke).searchProject('/repo', 'needle', false, [
        'src/Main.java',
        'README.md',
      ]),
    ).resolves.toEqual({
      matches: [
        {
          path: 'src/Main.java',
          line: 12,
          column: 5,
          preview: '😀 needle found',
        },
      ],
      truncated: false,
      skippedFiles: 2,
    })
  })

  it('omits exclusions when no paths are supplied', async () => {
    const invoke: Invoke = async (command, args) => {
      expect(command).toBe('search_project')
      expect(args).toEqual({
        repoPath: '/repo',
        query: 'needle',
        caseSensitive: true,
      })
      return { matches: [], truncated: false, skippedFiles: 0 }
    }

    await expect(
      createBackendClient(invoke).searchProject('/repo', 'needle', true),
    ).resolves.toEqual({ matches: [], truncated: false, skippedFiles: 0 })
  })

  it('rejects malformed search results', async () => {
    const invoke: Invoke = async () => ({
      matches: [{ path: 'src/Main.java', line: 0, column: 1, preview: 'needle' }],
      truncated: false,
      skippedFiles: 0,
    })

    await expect(
      createBackendClient(invoke).searchProject('/repo', 'needle', true),
    ).rejects.toThrow('invalid match')
  })
})

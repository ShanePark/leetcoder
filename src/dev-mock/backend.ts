import type {
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitFileChange,
  GitPushResult,
  ProblemFileEntry,
  PsLibraryMetadata,
  ProjectSearchMatch,
  ProjectSearchResult,
  ProjectValidation,
  UpdateStatus,
} from '../backend'
import type { ProblemFilePlan } from '../domain'
import { DAILY_PROBLEM, MANUAL_PROBLEM, MODIFIED_DIFF, addedDiffFor, seedFiles } from './fixtures'
import { delay } from './runtime'
import { createMockTestRunner } from './test-runner'

export function createDevMockBackend(): BackendClient & {
  getGitStatus(repoPath: string): Promise<unknown>
} {
  const files = seedFiles()
  const originalFiles = new Map(files)
  const gitAddedPath = 'src/main/java/shane/leetcode/problems/easy/Q3618SplitArrayByPrimeIndices.java'
  let gitChanges: Array<GitFileChange & { additions: number | null; deletions: number | null }> = [
    {
      path: 'src/main/java/shane/leetcode/problems/easy/Q1TwoSum.java',
      status: 'modified',
      indexStatus: '.',
      worktreeStatus: 'M',
      additions: 12,
      deletions: 4,
    },
    {
      path: gitAddedPath,
      status: 'added',
      indexStatus: 'A',
      worktreeStatus: '.',
      additions: 58,
      deletions: 0,
    },
    {
      path: 'notes/scratchpad.md',
      status: 'untracked',
      indexStatus: '?',
      worktreeStatus: '?',
      additions: null,
      deletions: null,
    },
  ]

  return {
    async validateProject(): Promise<ProjectValidation> {
      return { valid: true }
    },

    async inspectPsLibrary(): Promise<PsLibraryMetadata> {
      return { fingerprint: 'preview', methods: [] }
    },

    async fetchDailyProblem(): Promise<DailyProblem> {
      await delay(350)
      return DAILY_PROBLEM
    },

    async fetchProblemByNumber(frontendId: string): Promise<DailyProblem> {
      await delay(350)
      if (frontendId.trim() === MANUAL_PROBLEM.frontendId) {
        return MANUAL_PROBLEM
      }
      if (frontendId.trim() === DAILY_PROBLEM.frontendId) {
        return { ...DAILY_PROBLEM, date: '' }
      }
      throw new Error(`Problem #${frontendId} was not found in the preview.`)
    },

    async listProblemFiles(): Promise<ProblemFileEntry[]> {
      return [...files.keys()].sort().map(entryFor)
    },

    async searchProject(
      _repoPath: string,
      query: string,
      caseSensitive: boolean,
      excludePaths: readonly string[] = [],
    ): Promise<ProjectSearchResult> {
      if (query.length === 0) {
        return { matches: [], truncated: false, skippedFiles: 0 }
      }
      const needle = caseSensitive ? query : query.toLowerCase()
      const matches: ProjectSearchMatch[] = []
      const excludedPaths = new Set(excludePaths)
      for (const [path, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (excludedPaths.has(path)) {
          continue
        }
        const lines = content.split(/\r?\n/)
        const matchIndex = lines.findIndex((line) => {
          const candidate = caseSensitive ? line : line.toLowerCase()
          return candidate.indexOf(needle) >= 0
        })
        if (matchIndex < 0) {
          continue
        }
        if (matches.length === 500) {
          return { matches, truncated: true, skippedFiles: 0 }
        }
        const line = lines[matchIndex] ?? ''
        const candidate = caseSensitive ? line : line.toLowerCase()
        const index = candidate.indexOf(needle)
        const column = index + 1
        matches.push({ path, line: matchIndex + 1, column, preview: line.slice(0, 240) })
      }
      return { matches, truncated: false, skippedFiles: 0 }
    },

    async readProblemFile(_repoPath: string, path: string): Promise<string> {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      return source
    },

    async createProblemFile(_repoPath: string, plan: ProblemFilePlan): Promise<void> {
      files.set(plan.path, plan.source)
    },

    async saveProblemFile(_repoPath: string, path: string, content: string): Promise<void> {
      await delay(120)
      files.set(path, content)
    },

    async deleteProblemFile(_repoPath: string, path: string): Promise<void> {
      files.delete(path)
    },

    async duplicateProblemFile(_repoPath: string, path: string) {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      const slash = path.lastIndexOf('/')
      const directory = slash >= 0 ? path.slice(0, slash) : ''
      const name = path.slice(slash + 1)
      const extensionIndex = name.lastIndexOf('.')
      const stem = extensionIndex >= 0 ? name.slice(0, extensionIndex) : name
      const extension = extensionIndex >= 0 ? name.slice(extensionIndex) : ''
      const names = new Set(
        [...files.keys()]
          .filter((candidate) => candidate.startsWith(`${directory}/`))
          .map((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')),
      )
      let suffix = 2
      let candidateStem = `${stem}${suffix}`
      while (names.has(candidateStem)) {
        suffix += 1
        candidateStem = `${stem}${suffix}`
      }
      const candidatePath = `${directory}/${candidateStem}${extension}`
      const copied = source.replace(new RegExp(`\\b${escapeRegExp(stem)}\\b`, 'g'), candidateStem)
      files.set(candidatePath, copied)
      return { relativePath: candidatePath, content: copied }
    },

    async renameProblemFile(_repoPath: string, path: string, newPath: string) {
      const source = files.get(path)
      if (source === undefined) {
        throw new Error(`No such file: ${path}`)
      }
      const slash = path.lastIndexOf('/')
      const directory = slash >= 0 ? path.slice(0, slash) : ''
      const name = path.slice(slash + 1)
      const extensionIndex = name.lastIndexOf('.')
      const extension = extensionIndex >= 0 ? name.slice(extensionIndex) : ''
      const targetName = newPath.includes('/') ? newPath.slice(newPath.lastIndexOf('/') + 1) : newPath
      const target = newPath.includes('/') ? newPath : `${directory}/${newPath}`
      const targetPath = /\.[^.]+$/.test(targetName) ? target : `${target}${extension}`
      if (files.has(targetPath)) {
        throw new Error(`File already exists: ${targetPath}`)
      }
      const oldStem = extensionIndex >= 0 ? name.slice(0, extensionIndex) : name
      const destinationName = targetPath.slice(targetPath.lastIndexOf('/') + 1)
      const destinationExtensionIndex = destinationName.lastIndexOf('.')
      const destinationStem = destinationExtensionIndex >= 0
        ? destinationName.slice(0, destinationExtensionIndex)
        : destinationName
      const renamed = source.replace(new RegExp(`\\b${escapeRegExp(oldStem)}\\b`, 'g'), destinationStem)
      files.delete(path)
      files.set(targetPath, renamed)
      return { relativePath: targetPath, content: renamed }
    },

    async getGitStatus(): Promise<unknown> {
      await delay(150)
      return { branch: 'main', files: gitChanges }
    },

    async listGitChanges(): Promise<GitFileChange[]> {
      return gitChanges
    },

    async discardGitChanges(_repoPath: string, path: string): Promise<void> {
      const change = gitChanges.find((entry) => entry.path === path)
      if (!change) {
        throw new Error(`The selected path is not currently changed: ${path}`)
      }
      const isNew = change.status === 'added' || change.status === 'untracked'
      if (isNew) {
        files.delete(path)
      } else {
        const original = originalFiles.get(path)
        if (original !== undefined) {
          files.set(path, original)
        }
      }
      gitChanges = gitChanges.filter((entry) => entry.path !== path)
    },

    async showInFileManager(): Promise<void> {
      // The browser preview has no native file manager to open.
    },

    async getGitDiff(_repoPath: string, paths: string[]): Promise<string> {
      await delay(150)
      return paths
        .map((path) => {
          if (path.endsWith('Q1TwoSum.java')) {
            return MODIFIED_DIFF
          }
          const source = files.get(path) ?? '# scratch notes\n\n- revisit DP problems\n'
          return addedDiffFor(path, source)
        })
        .join('')
    },

    async commitGit(_repoPath: string, paths: string[], message: string): Promise<GitCommitResult> {
      await delay(300)
      gitChanges = gitChanges.filter((change) => !paths.includes(change.path))
      return { commitHash: 'a1b2c3d4e5f60789', message, paths }
    },

    async pushGit(): Promise<GitPushResult> {
      await delay(500)
      return { output: 'To github.com:shane/ps.git', branch: 'main' }
    },

    ...createMockTestRunner(),

    // The browser preview has no filesystem watcher behind it.
    async watchRepository(): Promise<void> {},

    async stopWatchingRepository(): Promise<void> {},

    async onRepositoryFilesChanged(): Promise<() => void> {
      return () => {}
    },

    async checkForUpdate(): Promise<UpdateStatus> {
      return {
        supported: false,
        available: false,
        currentCommit: '',
        latestCommit: '',
      }
    },

    async updateAndRestart(): Promise<void> {
      throw new Error('Updates are unavailable in the browser preview.')
    },
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function entryFor(path: string): ProblemFileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const segment = /\/easy\//.test(path)
    ? 'easy'
    : /\/medium\//.test(path)
      ? 'medium'
      : /\/xhard\//.test(path)
        ? 'xhard'
        : 'other'
  return { path, name, packageSegment: segment }
}

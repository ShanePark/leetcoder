import type { BackendClient, Invoke, Listen } from './contracts'
import { BackendError } from './errors'
import {
  normalizeDailyProblem,
  normalizeUpdateStatus,
  normalizeValidation,
} from './normalizers/problem'
import {
  normalizeProblemFileContent,
  normalizeProblemFileSource,
  normalizeProblemFiles,
  normalizeRepositoryFilesChanged,
} from './normalizers/files'
import {
  normalizeGitChanges,
  normalizeGitCommitResult,
  normalizeGitDiff,
  normalizeGitPushResult,
} from './normalizers/git'
import {
  normalizeProblemDiagnostics,
  normalizeTestResult,
  normalizeTestRunProgress,
} from './normalizers/test'
import {
  createProgressChannel,
  defaultInvoke,
  defaultListen,
  REPOSITORY_FILES_CHANGED_EVENT,
} from './transport'
import { isRecord, stringValue } from './normalizers/common'

/**
 * Create the backend boundary used by the application.
 *
 * Command invocation and event subscription stay injectable so browser tests
 * and preview mocks can use the same client without a desktop runtime.
 */
export function createBackendClient(
  invoke: Invoke = defaultInvoke,
  listen: Listen = defaultListen,
): BackendClient {
  return {
    async validateProject(repoPath) {
      const response = await invoke<unknown>('validate_project', { repoPath })
      return normalizeValidation(response)
    },

    async fetchDailyProblem() {
      const response = await invoke<unknown>('fetch_daily_problem')
      return normalizeDailyProblem(response)
    },

    async fetchProblemByNumber(frontendId) {
      const response = await invoke<unknown>('fetch_problem_by_number', { frontendId })
      return normalizeDailyProblem(response)
    },

    async listProblemFiles(repoPath) {
      const response = await invoke<unknown>('list_problem_files', { repoPath })
      return normalizeProblemFiles(response)
    },

    async readProblemFile(repoPath, path) {
      const response = await invoke<unknown>('read_problem_file', { repoPath, path })
      return normalizeProblemFileSource(response)
    },

    async createProblemFile(repoPath, plan) {
      const response = await invoke<unknown>('create_problem_file', {
        repoPath,
        path: plan.path,
        source: plan.source,
      })
      if (isRecord(response) && response.created === false) {
        throw new BackendError(
          stringValue(response.message) ?? 'The problem file was not created.',
          response.conflict === true,
        )
      }
    },

    async saveProblemFile(repoPath, path, content) {
      await invoke<unknown>('save_problem_file', { repoPath, path, content })
    },

    async deleteProblemFile(repoPath, path) {
      await invoke<unknown>('delete_problem_file', { repoPath, path })
    },

    async duplicateProblemFile(repoPath, path) {
      const response = await invoke<unknown>('duplicate_problem_file', { repoPath, path })
      return normalizeProblemFileContent(response, 'duplicate')
    },

    async renameProblemFile(repoPath, path, newPath) {
      const response = await invoke<unknown>('rename_problem_file', {
        repoPath,
        path,
        newPath,
      })
      return normalizeProblemFileContent(response, 'rename')
    },

    async listGitChanges(repoPath) {
      const response = await invoke<unknown>('list_git_changes', { repoPath })
      return normalizeGitChanges(response)
    },

    async discardGitChanges(repoPath, path) {
      await invoke<unknown>('discard_git_changes', { repoPath, path })
    },

    async showInFileManager(repoPath, path) {
      await invoke<unknown>('show_in_file_manager', { repoPath, path })
    },

    async getGitDiff(repoPath, paths) {
      const response = await invoke<unknown>('get_git_diff', { repoPath, paths })
      return normalizeGitDiff(response)
    },

    async commitGit(repoPath, paths, message) {
      const response = await invoke<unknown>('commit_git', { repoPath, paths, message })
      return normalizeGitCommitResult(response)
    },

    async pushGit(repoPath) {
      const response = await invoke<unknown>('push_git', { repoPath })
      return normalizeGitPushResult(response)
    },

    async runProblemTest(repoPath, fullyQualifiedClassName, onProgress, testMethod) {
      // The channel is intentionally passed even when the caller does not
      // subscribe. Rust commands use it to report lifecycle events, and a
      // no-op listener keeps the invoke contract identical for every caller.
      const onEvent = createProgressChannel((event) => {
        const progress = normalizeTestRunProgress(event)
        if (progress) {
          onProgress?.(progress)
        }
      })
      const args: Record<string, unknown> = {
        repoPath,
        fullyQualifiedClassName,
        onEvent,
      }
      if (testMethod !== undefined) {
        args.testMethod = testMethod
      }
      const response = await invoke<unknown>('run_problem_test', args)
      return normalizeTestResult(response)
    },

    async checkProblemDiagnostics(repoPath, fullyQualifiedClassName, source) {
      const response = await invoke<unknown>('check_problem_diagnostics', {
        repoPath,
        fullyQualifiedClassName,
        source,
      })
      return normalizeProblemDiagnostics(response)
    },

    async watchRepository(repoPath) {
      await invoke<unknown>('watch_repository', { repoPath })
    },

    async stopWatchingRepository() {
      await invoke<unknown>('unwatch_repository')
    },

    async onRepositoryFilesChanged(handler) {
      return listen(REPOSITORY_FILES_CHANGED_EVENT, (message) => {
        const change = normalizeRepositoryFilesChanged(message.payload)
        if (change) {
          handler(change)
        }
      })
    },

    async checkForUpdate() {
      const response = await invoke<unknown>('check_for_update')
      return normalizeUpdateStatus(response)
    },

    async updateAndRestart() {
      await invoke<unknown>('update_and_restart')
    },
  }
}

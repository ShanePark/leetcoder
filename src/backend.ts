/**
 * Public backend boundary.
 *
 * Keep this module as the stable import surface for the application while the
 * implementation is split by contract, transport, and response domain under
 * `src/backend/`.
 */
export type {
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitFileChange,
  GitPushResult,
  Listen,
  Invoke,
  ProblemDiagnostic,
  ProblemFileContent,
  ProblemFileEntry,
  ProjectValidation,
  RepositoryFilesChanged,
  TestCaseResult,
  TestCaseStatus,
  TestDiagnostic,
  TestPhase,
  TestResult,
  TestRunProgress,
  TestRunProgressHandler,
  TestSummary,
  UpdateStatus,
} from './backend/contracts'

export { createBackendClient } from './backend/client'

export { BackendError, errorMessage, isConflictError } from './backend/errors'

export {
  normalizeUpdateStatus,
} from './backend/normalizers/problem'

export {
  normalizeGitChanges,
  normalizeGitCommitResult,
  normalizeGitDiff,
  normalizeGitPushResult,
} from './backend/normalizers/git'

export {
  normalizeProblemDiagnostics,
  normalizeTestResult,
  normalizeTestRunProgress,
} from './backend/normalizers/test'

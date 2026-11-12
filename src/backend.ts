/**
 * Public backend boundary.
 *
 * Keep this module as the stable import surface for the application while the
 * implementation is split by contract, transport, and response domain under
 * `src/backend/`.
 */
export type {
  AiGenerateRequest,
  AiGenerateResult,
  AiKeySaveResult,
  AiModel,
  AiModelList,
  AiModelPricing,
  AiProgress,
  AiProgressHandler,
  AiProviderInfo,
  AiRequestUsage,
  AiResponseLanguage,
  AiReview,
  AiReviewMissedCase,
  AiReviewRequest,
  AiReviewResult,
  AiReviewTestCase,
  AiReviewTestRun,
  AiReviewVerdict,
  AiStatus,
  AiModelUsage,
  AiUsageBucket,
  AiUsageSummary,
  AiUsageTotals,
  BackendClient,
  DailyProblem,
  GitCommitResult,
  GitFileChange,
  GitPullResult,
  GitPushResult,
  Listen,
  Invoke,
  JavaFieldMember,
  JavaMemberParameter,
  JavaMethodMember,
  JavaTypeMembers,
  JavaTypeMembersMetadata,
  ProblemDiagnostic,
  ProblemFileContent,
  ProblemFileEntry,
  ProjectSearchMatch,
  ProjectSearchResult,
  PsLibraryMetadata,
  PsMethod,
  PsParameter,
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
  UpdateBuild,
  UpdateStatus,
} from './backend/contracts'

export { createBackendClient } from './backend/client'

export { BackendError, errorMessage, isConflictError } from './backend/errors'

export {
  normalizeUpdateBuild,
  normalizeUpdateStatus,
} from './backend/normalizers/problem'

export {
  normalizeGitChanges,
  normalizeGitCommitResult,
  normalizeGitDiff,
  normalizeGitPullResult,
  normalizeGitPushResult,
} from './backend/normalizers/git'

export {
  normalizeProblemDiagnostics,
  normalizeTestResult,
  normalizeTestRunProgress,
} from './backend/normalizers/test'

export {
  normalizeJavaTypeMembersMetadata,
  normalizePsLibraryMetadata,
} from './backend/normalizers/java-library'

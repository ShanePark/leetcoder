import { planProblemFile, type ProblemDefinition, type ProblemFilePlan } from './domain'
import { isConflictError, type BackendClient } from './backend'

const DEFAULT_MAX_ATTEMPTS = 32

/**
 * Plan against a fresh file listing, then create.  A create can race with a
 * second editor instance, so an already-exists error refreshes the listing
 * and lets the domain choose the next suffix.
 */
export async function createProblemWithRetry(
  backend: BackendClient,
  repoPath: string,
  problem: ProblemDefinition,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<ProblemFilePlan> {
  if (maxAttempts < 1) {
    throw new Error('At least one file-creation attempt is required.')
  }

  let existingPaths = (await backend.listProblemFiles(repoPath)).map((file) => file.path)
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const plan = planProblemFile(problem, existingPaths)
    try {
      await backend.createProblemFile(repoPath, plan)
      return plan
    } catch (error) {
      if (!isConflictError(error) || attempt === maxAttempts - 1) {
        throw error
      }
      existingPaths = (await backend.listProblemFiles(repoPath)).map((file) => file.path)
    }
  }

  throw new Error('The problem file could not be created.')
}

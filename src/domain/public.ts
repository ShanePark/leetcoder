/** The difficulty labels understood by the problem generator. */
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD'

/** Difficulty values accepted from LeetCode or from the editor UI. */
export type DifficultyInput = Difficulty | string

/** The source package used by the existing problem repository. */
export type ProblemPackage = 'easy' | 'medium' | 'xhard'

/** The metadata needed to create a new problem file. */
export interface ProblemDefinition {
  number: string | number
  title: string
  difficulty: DifficultyInput
  javaCodeSnippet?: string | null
}

/**
 * The complete, filesystem-independent result of planning a problem file.
 * `path` is relative to the repository root.
 */
export interface ProblemFilePlan {
  problemNumber: string
  title: string
  difficulty: Difficulty
  baseClassName: string
  className: string
  packageSegment: ProblemPackage
  packageName: string
  fullyQualifiedClassName: string
  fileName: string
  path: string
  methodSignature: string | null
  source: string
}

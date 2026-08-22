import { classNameFromProblem, nextClassName, packageForDifficulty } from './class-name'
import { extractJavaMethodSignature } from './method-signature'
import type { ProblemDefinition, ProblemFilePlan } from './public'
import { BASE_PACKAGE, renderJavaProblemSource } from './template'

const JAVA_SOURCE_ROOT = 'src/main/java'

/** Build the path, names, and source for one new LeetCode Java problem file. */
export function planProblemFile(
  problem: ProblemDefinition,
  existingPaths: readonly string[] = [],
): ProblemFilePlan {
  const problemNumber = String(problem.number).trim()
  const title = problem.title.trim()
  const packageSegment = packageForDifficulty(problem.difficulty)
  const difficulty = difficultyForPackage(packageSegment)
  const baseClassName = classNameFromProblem(problemNumber, title)
  const className = nextClassName(
    baseClassName,
    existingPaths.filter((sourcePath) => belongsToPackage(sourcePath, packageSegment)),
  )
  const packageName = `${BASE_PACKAGE}.${packageSegment}`
  const fileName = `${className}.java`
  const path = `${JAVA_SOURCE_ROOT}/${packageName.replace(/\./g, '/')}/${fileName}`
  const methodSignature = extractJavaMethodSignature(problem.javaCodeSnippet)

  return {
    problemNumber,
    title,
    difficulty,
    baseClassName,
    className,
    packageSegment,
    packageName,
    fullyQualifiedClassName: `${packageName}.${className}`,
    fileName,
    path,
    methodSignature,
    source: renderJavaProblemSource(packageName, className, methodSignature),
  }
}

function difficultyForPackage(packageSegment: ProblemFilePlan['packageSegment']): ProblemFilePlan['difficulty'] {
  switch (packageSegment) {
    case 'easy':
      return 'EASY'
    case 'medium':
      return 'MEDIUM'
    case 'xhard':
      return 'HARD'
    default:
      throw new Error(`Unsupported package segment: ${packageSegment}`)
  }
}

function belongsToPackage(sourcePath: string, packageSegment: ProblemFilePlan['packageSegment']): boolean {
  const normalizedPath = sourcePath.replace(/\\/g, '/')
  const packagePath = `shane/leetcode/problems/${packageSegment}`

  // A bare filename is useful to callers that have already scoped a
  // directory listing to the destination package.
  if (!normalizedPath.includes('/')) {
    return true
  }

  return (
    normalizedPath.includes(`/src/main/java/${packagePath}/`) ||
    normalizedPath.includes(`/src/main/kotlin/${packagePath}/`) ||
    normalizedPath.includes(`/${packagePath}/`)
  )
}

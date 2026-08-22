import type { ProblemPackage, DifficultyInput } from './public'

const JAVA_SOURCE_EXTENSIONS = new Set(['.java', '.kt'])

/**
 * Convert a LeetCode number and title using the same convention as the
 * repository's `ClassNameFactory` Java utility.
 */
export function classNameFromProblem(number: string | number, title: string): string {
  const problemNumber = normalizeProblemNumber(number)
  const normalizedTitle = title.trim()
  let className = `Q${problemNumber}`

  // ClassNameFactory adds an underscore when the first title character is a
  // digit, e.g. "Q3_3Sum".
  if (normalizedTitle.length > 0 && isDigit(normalizedTitle[0])) {
    className += '_'
  }

  for (const word of normalizedTitle.split(' ')) {
    // Java's ClassNameFactory iterates char (UTF-16 code units), so retain
    // that behavior for supplementary Unicode characters as well.
    for (let index = 0; index < word.length; index += 1) {
      const character = word[index]
      if (!isLetterOrDigit(character)) {
        continue
      }

      // The Java utility only uppercases a lower-case character when it is
      // the first character in the space-delimited token.
      className += index === 0 ? uppercaseAscii(character) : character
    }
  }

  return className
}

/** Map a LeetCode difficulty label to the repository package segment. */
export function packageForDifficulty(difficulty: DifficultyInput): ProblemPackage {
  const normalized = String(difficulty).trim().toUpperCase()
  switch (normalized) {
    case 'EASY':
      return 'easy'
    case 'MEDIUM':
      return 'medium'
    case 'HARD':
      return 'xhard'
    default:
      throw new Error(`Unsupported LeetCode difficulty: ${difficulty}`)
  }
}

/**
 * Pick the first available class name from `base`, `base2`, `base3`, ... .
 * Both Java and Kotlin source files participate in collision detection.
 */
export function nextClassName(baseClassName: string, existingPaths: readonly string[] = []): string {
  const base = baseClassName.trim()
  if (base.length === 0) {
    throw new Error('A base class name is required')
  }

  const existingNames = new Set(
    existingPaths
      .map(sourcePathToName)
      .filter((name): name is string => name !== null),
  )

  if (!existingNames.has(base)) {
    return base
  }

  let suffix = 2
  while (existingNames.has(`${base}${suffix}`)) {
    suffix += 1
  }
  return `${base}${suffix}`
}

function normalizeProblemNumber(number: string | number): string {
  const normalized = String(number).trim()
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid LeetCode problem number: ${number}`)
  }
  return normalized
}

function sourcePathToName(sourcePath: string): string | null {
  const normalizedPath = sourcePath.replace(/\\/g, '/')
  const slashIndex = normalizedPath.lastIndexOf('/')
  const fileName = normalizedPath.slice(slashIndex + 1)
  const extensionIndex = fileName.lastIndexOf('.')
  if (extensionIndex < 0) {
    return null
  }

  const extension = fileName.slice(extensionIndex).toLowerCase()
  if (!JAVA_SOURCE_EXTENSIONS.has(extension)) {
    return null
  }
  return fileName.slice(0, extensionIndex)
}

function isDigit(character: string): boolean {
  return /^\p{Nd}$/u.test(character)
}

function isLetterOrDigit(character: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(character)
}

function uppercaseAscii(character: string): string {
  return character >= 'a' && character <= 'z' ? character.toUpperCase() : character
}

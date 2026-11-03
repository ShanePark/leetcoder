/**
 * Extract the first top-level method declaration from a conventional
 * LeetCode Java `class Solution` snippet. The declaration is returned without
 * its opening brace and without a body.
 *
 * LeetCode's Java snippets are intentionally small, so this parser stays
 * dependency-free while still ignoring comments, strings, nested classes, and
 * braces inside method bodies.
 */
export function extractJavaMethodSignature(snippet: string | null | undefined): string | null {
  if (!snippet || snippet.trim().length === 0) {
    return null
  }

  const candidates = solutionMemberHeaders(maskJavaTrivia(snippet))
    .map((header) => methodSignatureFromSegment(header, 'Solution'))
    .filter((candidate) => candidate !== null)

  // LeetCode's entry point is normally public. If a snippet happens to declare
  // a private helper first, prefer the public entry point while still retaining
  // a package-private fallback.
  return candidates.find((candidate) => /\bpublic\b/.test(candidate)) ?? candidates[0] ?? null
}

/**
 * Whether `class Solution` declares a constructor, which marks a design problem:
 * its example calls need an instance, and its other methods still look like an
 * ordinary entry point.
 */
export function declaresJavaSolutionConstructor(snippet: string | null | undefined): boolean {
  if (!snippet) {
    return false
  }
  return solutionMemberHeaders(maskJavaTrivia(snippet)).some((header) =>
    /^(?:(?:public|protected|private)\s+)?(?:<[\s\S]*>\s*)?Solution\s*\(/.test(withoutLeadingAnnotations(header)))
}

/** The text before each member body of `class Solution`, from masked source. */
function solutionMemberHeaders(masked: string): string[] {
  const classMatch = /\bclass\s+Solution\b/.exec(masked)
  if (!classMatch) {
    return []
  }

  const classOpenBrace = masked.indexOf('{', classMatch.index + classMatch[0].length)
  if (classOpenBrace < 0) {
    return []
  }

  const headers: string[] = []
  let depth = 1
  let segmentStart = classOpenBrace + 1

  for (let index = classOpenBrace + 1; index < masked.length; index += 1) {
    const character = masked[index]
    if (character === '{') {
      if (depth === 1) {
        headers.push(masked.slice(segmentStart, index))
      }
      depth += 1
      continue
    }

    if (character === '}') {
      depth -= 1
      if (depth === 0) {
        break
      }
      if (depth === 1) {
        segmentStart = index + 1
      }
      continue
    }

    // Fields and annotation initializers can occur before the method. A
    // semicolon marks the beginning of the next top-level declaration.
    if (character === ';' && depth === 1) {
      segmentStart = index + 1
    }
  }

  return headers
}

/**
 * Annotations are not part of a method signature inserted into the user's
 * class. Strip only annotations at the beginning of a declaration.
 */
function withoutLeadingAnnotations(segment: string): string {
  return segment.trim().replace(/^(?:@[\w$.]+(?:\s*\([^)]*\))?\s*)+/, '').trim()
}

function methodSignatureFromSegment(segment: string, className: string): string | null {
  const candidate = withoutLeadingAnnotations(segment)
  if (candidate.length === 0 || candidate.includes('=')) {
    return null
  }

  const normalized = candidate
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+\]/g, '[]')
  const openParenthesis = normalized.indexOf('(')
  const closeParenthesis = normalized.lastIndexOf(')')
  if (openParenthesis <= 0 || closeParenthesis <= openParenthesis) {
    return null
  }

  const beforeParenthesis = normalized.slice(0, openParenthesis).trim()
  const methodNameMatch = /([A-Za-z_$][\w$]*)$/.exec(beforeParenthesis)
  if (!methodNameMatch) {
    return null
  }

  const methodName = methodNameMatch[1]
  if (CONTROL_KEYWORDS.has(methodName) || methodName === className) {
    return null
  }

  const beforeMethodName = beforeParenthesis
    .slice(0, methodNameMatch.index)
    .trim()
  if (
    beforeMethodName.length === 0 ||
    /\b(?:class|interface|enum)\b/.test(beforeMethodName)
  ) {
    return null
  }

  const suffix = normalized.slice(closeParenthesis + 1).trim()
  if (suffix.length > 0 && !/^throws\s+[\w$., <>\[\]]+$/.test(suffix)) {
    return null
  }

  // A declaration's parentheses must be balanced. This also rejects a
  // malformed field or invocation that happens to contain a pair of them.
  let parenthesisDepth = 0
  for (let index = openParenthesis; index <= closeParenthesis; index += 1) {
    if (normalized[index] === '(') {
      parenthesisDepth += 1
    } else if (normalized[index] === ')') {
      parenthesisDepth -= 1
      if (parenthesisDepth < 0) {
        return null
      }
    }
  }
  if (parenthesisDepth !== 0) {
    return null
  }

  return normalized
}

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'try'])

/** Replace comments and literals with whitespace while preserving positions. */
function maskJavaTrivia(source: string): string {
  const characters = Array.from(source)
  const output = characters.slice()
  let index = 0

  const blank = (at: number) => {
    if (output[at] !== '\n' && output[at] !== '\r') {
      output[at] = ' '
    }
  }

  while (index < characters.length) {
    if (characters[index] === '/' && characters[index + 1] === '/') {
      blank(index)
      blank(index + 1)
      index += 2
      while (index < characters.length && characters[index] !== '\n' && characters[index] !== '\r') {
        blank(index)
        index += 1
      }
      continue
    }

    if (characters[index] === '/' && characters[index + 1] === '*') {
      blank(index)
      blank(index + 1)
      index += 2
      while (index < characters.length) {
        if (characters[index] === '*' && characters[index + 1] === '/') {
          blank(index)
          blank(index + 1)
          index += 2
          break
        }
        blank(index)
        index += 1
      }
      continue
    }

    if (characters[index] === '"' || characters[index] === "'") {
      const quote = characters[index]
      blank(index)
      index += 1
      while (index < characters.length) {
        if (characters[index] === '\\') {
          blank(index)
          if (index + 1 < characters.length) {
            blank(index + 1)
          }
          index += 2
          continue
        }
        const isClosingQuote = characters[index] === quote
        blank(index)
        index += 1
        if (isClosingQuote) {
          break
        }
      }
      continue
    }

    index += 1
  }

  return output.join('')
}

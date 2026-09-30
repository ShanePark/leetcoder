import type { JavaDefinition, JavaIdentifier, JavaMethod } from '../model'
import { maskJavaCommentsAndLiterals } from './masking'
import { parameterNameAndType, splitTopLevel } from './symbols'

function javaClassNames(maskedSource: string): Set<string> {
  const names = new Set<string>()
  const classPattern = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(maskedSource))) {
    names.add(match[1])
  }
  return names
}

function methodHasReturnType(match: RegExpExecArray, nameStartInMatch: number): boolean {
  let prefix = match[0].slice(0, nameStartInMatch)
  const boundary = Math.max(prefix.lastIndexOf('{'), prefix.lastIndexOf('}'), prefix.lastIndexOf(';'))
  if (boundary >= 0) {
    prefix = prefix.slice(boundary + 1)
  }
  const normalized = prefix
    .replace(/(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+/g, ' ')
    .replace(/\b(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\b/g, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .trim()
  return normalized.length > 0
}

export function collectJavaMethodsFromMasked(source: string, maskedSource: string): JavaMethod[] {
  const classNames = javaClassNames(maskedSource)
  const result: JavaMethod[] = []
  const method = /(?:^|[;{}])\s*(?:(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+)?(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{}]+>\s*)?(?:(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(?:\s*<[^>{}]*>)?\s*(?:\[\s*\])*\s+)?([A-Za-z_$][\w$]*)\s*\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm
  let match: RegExpExecArray | null
  while ((match = method.exec(maskedSource))) {
    const name = match[1]
    if (/^(?:if|for|while|switch|catch|try|synchronized)$/.test(name)) continue
    // Constructors have the class name but no return type. They are not
    // method definitions for the editor's same-file navigation feature.
    const signatureOpenParen = match[0].lastIndexOf('(')
    const nameStartInMatch = match[0].lastIndexOf(name, signatureOpenParen)
    const hasReturnType = methodHasReturnType(match, nameStartInMatch)
    if (!hasReturnType && classNames.has(name)) continue
    const nameStart = match.index + nameStartInMatch
    const parameters = splitTopLevel(match[2]).map(parameterNameAndType).filter((value): value is { name: string; type: string } => value !== null).map((value) => value.name)
    result.push({ name, parameters, declaredAt: match.index, nameStart, nameEnd: nameStart + name.length })
  }
  return result
}

export function collectJavaMethods(source: string): JavaMethod[] {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  return collectJavaMethodsFromMasked(source, maskedSource)
}

/** Return the Java identifier under a source position, if it is code. */
function javaIdentifierAtMasked(source: string, maskedSource: string, position: number): JavaIdentifier | null {
  let cursor = Math.max(0, Math.min(Math.trunc(position), source.length))
  if (cursor === source.length || !/[A-Za-z0-9_$]/.test(maskedSource[cursor] ?? '')) {
    cursor -= 1
  }
  if (cursor < 0 || !/[A-Za-z_$]/.test(maskedSource[cursor] ?? '')) {
    return null
  }
  let from = cursor
  let to = cursor + 1
  while (from > 0 && /[A-Za-z0-9_$]/.test(maskedSource[from - 1])) from -= 1
  while (to < maskedSource.length && /[A-Za-z0-9_$]/.test(maskedSource[to])) to += 1
  const name = source.slice(from, to)
  if (!name || maskedSource.slice(from, to) !== name) {
    return null
  }
  return { name, from, to }
}

export function javaIdentifierAt(source: string, position: number): JavaIdentifier | null {
  return javaIdentifierAtMasked(source, maskJavaCommentsAndLiterals(source), position)
}

function previousIdentifier(maskedSource: string, from: number): string | null {
  let cursor = from - 1
  while (cursor >= 0 && /\s/.test(maskedSource[cursor])) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[cursor])) cursor -= 1
  const start = cursor + 1
  return start < end ? maskedSource.slice(start, end) : null
}

function callOpenParen(maskedSource: string, end: number): number | null {
  let cursor = end
  while (cursor < maskedSource.length && /\s/.test(maskedSource[cursor])) cursor += 1
  return maskedSource[cursor] === '(' ? cursor : null
}

function isGenericAngleOpen(maskedSource: string, index: number): boolean {
  let previous = index - 1
  while (previous >= 0 && /\s/.test(maskedSource[previous])) previous -= 1
  let next = index + 1
  while (next < maskedSource.length && /\s/.test(maskedSource[next])) next += 1
  if (previous < 0 || next >= maskedSource.length) return false
  const before = maskedSource.slice(0, index)
  const explicitTypeArguments = /\.\s*$/.test(before)
  if (!explicitTypeArguments && !/[A-Za-z0-9_$>\]]/.test(maskedSource[previous])) return false
  if (!/[A-Za-z0-9_$?@]/.test(maskedSource[next])) return false

  let previousStart = previous
  while (previousStart >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[previousStart])) previousStart -= 1
  const previousToken = maskedSource.slice(previousStart + 1, previous + 1)
  const typeName = /^[A-Z_$]/.test(previousToken)
  const constructedType = /\bnew\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(before)
  if (!explicitTypeArguments && !typeName && !constructedType) return false

  // A comparison (`left < right`) has no closing angle before the current
  // call's argument boundary. Generic types do, including nested `>>`.
  let depth = 1
  let nestedParen = 0
  for (let cursor = next; cursor < maskedSource.length; cursor += 1) {
    const current = maskedSource[cursor]
    if (current === '<') {
      depth += 1
    } else if (current === '>') {
      depth -= 1
      if (depth === 0) {
        if (explicitTypeArguments || constructedType) return true
        let after = cursor + 1
        while (after < maskedSource.length && /\s/.test(maskedSource[after])) after += 1
        return after >= maskedSource.length || /[,\)\]}.(]/.test(maskedSource[after] ?? '')
      }
    } else if (current === '(') {
      nestedParen += 1
    } else if (current === ')') {
      if (nestedParen > 0) {
        nestedParen -= 1
      } else {
        return false
      }
    } else if (depth === 1 && current === ';') {
      return false
    }
  }
  return false
}

function callArgumentCount(maskedSource: string, openParen: number): number | null {
  let paren = 0
  let bracket = 0
  let brace = 0
  let angle = 0
  let commas = 0
  let hasValue = false
  for (let index = openParen + 1; index < maskedSource.length; index += 1) {
    const current = maskedSource[index]
    if (current === '<' && isGenericAngleOpen(maskedSource, index)) {
      angle += 1
    } else if (current === '>' && angle > 0) {
      angle -= 1
    } else if (current === '(') {
      paren += 1
      hasValue = true
    } else if (current === ')') {
      if (paren > 0) {
        paren -= 1
        hasValue = true
      } else if (bracket === 0 && brace === 0 && angle === 0) {
        return hasValue ? commas + 1 : commas
      }
    } else if (current === '[') {
      bracket += 1
      hasValue = true
    } else if (current === ']') {
      bracket = Math.max(0, bracket - 1)
      hasValue = true
    } else if (current === '{') {
      brace += 1
      hasValue = true
    } else if (current === '}') {
      brace = Math.max(0, brace - 1)
      hasValue = true
    } else if (current === ',' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      commas += 1
      hasValue = false
    } else if (!/\s/.test(current)) {
      hasValue = true
    }
  }
  return null
}

/**
 * Resolve a same-file method call to the exact declaration name range.
 * Only unqualified/`this.` calls are considered.
 */
export function resolveJavaDefinition(source: string, position: number): JavaDefinition | null {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  const identifier = javaIdentifierAtMasked(source, maskedSource, position)
  if (!identifier) return null
  const methods = collectJavaMethodsFromMasked(source, maskedSource)
  const declaration = methods.find((method) => identifier.from === method.nameStart && identifier.to === method.nameEnd)
  if (declaration) {
    return {
      name: declaration.name,
      from: declaration.nameStart,
      to: declaration.nameEnd,
      parameters: declaration.parameters,
      declaredAt: declaration.declaredAt,
    }
  }

  const openParen = callOpenParen(maskedSource, identifier.to)
  if (openParen === null) return null
  if (previousIdentifier(maskedSource, identifier.from) === 'new') return null
  const beforeIdentifier = maskedSource.slice(0, identifier.from)
  if (/\.\s*$/.test(beforeIdentifier) && !/(?:^|[^\w$.])this\s*\.\s*$/.test(beforeIdentifier)) {
    return null
  }

  const candidates = methods.filter((method) => method.name === identifier.name)
  if (candidates.length === 0) return null
  const argumentCount = callArgumentCount(maskedSource, openParen)
  const selected = argumentCount === null
    ? candidates[0]
    : candidates.find((method) => method.parameters.length === argumentCount) ?? candidates[0]
  return {
    name: selected.name,
    from: selected.nameStart,
    to: selected.nameEnd,
    parameters: selected.parameters,
    declaredAt: selected.declaredAt,
  }
}

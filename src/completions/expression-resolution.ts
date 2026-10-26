import type { JavaMethodMember, JavaTypeMembers, JavaTypeMembersMetadata } from '../backend'
import type { JavaSymbol } from './model'
import { maskJavaCommentsAndLiterals } from './source'
import { canonicalTypes, indexedArrayElementType, resolveJavaReceiverTypes, type JavaReceiverTypeResolution } from './type-resolution'

const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void'])
const EMPTY: JavaReceiverTypeResolution = { kind: 'unresolved', typeNames: [], isStatic: false }

function openingDelimiter(text: string, end: number): number {
  const close = text[end]
  const open = close === ')' ? '(' : close === ']' ? '[' : '{'
  let depth = 1
  for (let index = end - 1; index >= 0; index -= 1) {
    if (text[index] === close) depth += 1
    if (text[index] === open && --depth === 0) return index
  }
  return -1
}

/** Find a complete call receiver without stopping at newlines or lambda bodies. */
export function expressionBeforeDot(source: string, position: number): { receiver: string; from: number } | null {
  const masked = maskJavaCommentsAndLiterals(source.slice(0, position))
  const suffix = /\.\s*([A-Za-z_$][\w$]*)?$/.exec(masked)
  if (!suffix) return null
  let index = suffix.index - 1
  while (index >= 0 && /\s/.test(masked[index])) index -= 1
  const end = index + 1
  while (index >= 0) {
    // Consume consecutive groups such as `grid[i][j]` or `values()[0]`.
    while (masked[index] === ')' || masked[index] === ']') {
      index = openingDelimiter(masked, index)
      if (index < 0) return null
      index -= 1
      while (index >= 0 && /\s/.test(masked[index])) index -= 1
    }
    const name = /[A-Za-z_$][\w$]*$/.exec(masked.slice(0, index + 1))
    if (name) index = name.index - 1
    else if (masked[index] === '\u0001') index -= 1
    else if (index + 1 === end) return null
    while (index >= 0 && /\s/.test(masked[index])) index -= 1
    if (masked[index] !== '.') break
    index -= 1
    while (index >= 0 && /\s/.test(masked[index])) index -= 1
  }
  return { receiver: source.slice(index + 1, end).trim(), from: position - (suffix[1]?.length ?? 0) }
}

function splitArguments(value: string, delimiters = ','): string[] {
  const masked = maskJavaCommentsAndLiterals(value)
  const parts: string[] = []
  let start = 0
  const stack: string[] = []
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]
    if ('([{'.includes(char)) stack.push(char)
    else if (')]}'.includes(char)) stack.pop()
    else if (stack.length === 0 && delimiters.includes(char)) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}

function rawType(type: string): string {
  return type.replace(/<.*>/s, '').replace(/\s/g, '')
}

function simpleType(type: string): string {
  return rawType(type).replace(/(?:[A-Za-z_$][\w$]*\.)+/g, '')
}

function argumentScore(parameter: string, argument: string | undefined): number | null {
  if (!argument) return 0
  const expected = simpleType(parameter)
  const actual = simpleType(argument)
  if (expected === actual) return 4
  if (expected.endsWith('[]') || actual.endsWith('[]')) {
    if (!expected.endsWith('[]') || !actual.endsWith('[]')) return null
    const expectedElement = expected.slice(0, -2)
    const actualElement = actual.slice(0, -2)
    if (PRIMITIVES.has(expectedElement) || PRIMITIVES.has(actualElement)) return null
    return /^[A-Z]$/.test(expectedElement) || expectedElement === 'Object' ? 2 : 0
  }
  if (PRIMITIVES.has(expected) && PRIMITIVES.has(actual)) {
    const widening: Record<string, string[]> = {
      byte: ['short', 'int', 'long', 'float', 'double'], short: ['int', 'long', 'float', 'double'],
      char: ['int', 'long', 'float', 'double'], int: ['long', 'float', 'double'],
      long: ['float', 'double'], float: ['double'],
    }
    return widening[actual]?.includes(expected) ? 1 : null
  }
  return 0
}

/** Resolve call results using the same inspected signatures used for member suggestions. */
export async function resolveJavaExpressionReceiver(
  source: string,
  receiver: string,
  position: number,
  symbols: JavaSymbol[],
  inspect: (typeNames: string[]) => Promise<JavaTypeMembersMetadata>,
): Promise<JavaReceiverTypeResolution> {
  async function members(typeNames: string[]): Promise<JavaTypeMembers[]> {
    const metadata = await inspect(typeNames)
    return metadata.types.filter((type) => type.available && typeNames.includes(type.typeName))
  }

  function symbolFor(name: string): JavaSymbol | undefined {
    return symbols.filter((symbol) => symbol.name === name && symbol.scopeStart <= position && position <= symbol.scopeEnd)
      .sort((left, right) => (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart)
        || right.declaredAt - left.declaredAt)[0]
  }

  async function valueTypes(expression: string, depth: number): Promise<string[]> {
    const text = expression.trim()
    if (depth > 24) return []
    const symbol = symbolFor(maskJavaCommentsAndLiterals(text).trim().replace(/^this\./, ''))
    if (symbol?.declaredType && symbol.declaredType !== 'var') return [symbol.declaredType]
    if (symbol?.declaredType === 'var') {
      const declaration = source.slice(symbol.declaredAt + symbol.name.length)
      const assignment = /^\s*=/.exec(declaration)
      if (assignment) {
        const initializer = splitArguments(declaration.slice(assignment[0].length), ',;')[0]
        if (initializer && initializer !== text) return valueTypes(initializer, depth + 1)
      }
    }
    if (/^"/.test(text)) return ['java.lang.String']
    if (/^'/.test(text)) return ['char']
    if (/^(true|false)$/.test(text)) return ['boolean']
    if (/^[+-]?\d+[lL]$/.test(text)) return ['long']
    if (/^[+-]?\d+$/.test(text)) return ['int']
    if (/^[+-]?(?:\d+\.\d*|\d+[dDfF])/.test(text)) return [/[fF]$/.test(text) ? 'float' : 'double']
    const array = /^new\s+([\w.$]+)\s*((?:\[[^\]]*\]\s*)+)/.exec(text)
    if (array) return [`${array[1]}${'[]'.repeat((array[2].match(/\[/g) ?? []).length)}`]
    const access = /^([A-Za-z_$][\w$]*)\s*(\[[\s\S]*\])$/.exec(text)
    if (access) {
      const declared = symbolFor(access[1])?.declaredType
      if (declared?.endsWith('[]')) return [declared.slice(0, -2)]
    }
    if (maskJavaCommentsAndLiterals(text).includes('->') || text.includes('::')) return []
    const resolved = await resolve(text, depth + 1)
    return resolved.isStatic ? [] : resolved.typeNames
  }

  async function resolve(expression: string, depth: number): Promise<JavaReceiverTypeResolution> {
    if (depth > 24) return EMPTY
    const text = expression.trim()
    const masked = maskJavaCommentsAndLiterals(text)
    if (masked.endsWith(')')) {
      const opening = openingDelimiter(masked, masked.length - 1)
      if (opening === 0) return resolve(text.slice(1, -1), depth + 1)
      if (opening < 0) return EMPTY
      const call = /\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(masked.slice(0, opening))
      if (!call) return EMPTY
      const owner = await resolve(text.slice(0, call.index), depth + 1)
      if (owner.kind !== 'metadata') return EMPTY
      const args = splitArguments(text.slice(opening + 1, -1))
      const argumentTypes = await Promise.all(args.map((arg) => valueTypes(arg, depth + 1)))
      const candidates: Array<{ method: JavaMethodMember; score: number }> = []
      for (const type of await members(owner.typeNames)) {
        for (const method of type.methods) {
          if (method.name !== call[1] || method.isStatic !== owner.isStatic) continue
          const varargs = method.parameters.at(-1)?.typeName.endsWith('...')
          if (varargs ? args.length < method.parameters.length - 1 : args.length !== method.parameters.length) continue
          let score = 0
          let compatible = true
          for (let index = 0; index < args.length; index += 1) {
            const declared = method.parameters[Math.min(index, method.parameters.length - 1)].typeName
            const parameter = declared.replace(/\.\.\.$/, '')
            const parameterForms = declared.endsWith('...') && args.length === method.parameters.length
              ? [parameter, `${parameter}[]`] : [parameter]
            const scores = argumentTypes[index].length
              ? argumentTypes[index].flatMap((type) => parameterForms.map((form) => argumentScore(form, type))).filter((value) => value !== null)
              : [0]
            if (!scores.length) { compatible = false; break }
            score += Math.max(...scores)
          }
          if (compatible) candidates.push({ method, score })
        }
      }
      const best = Math.max(...candidates.map((candidate) => candidate.score))
      const typeNames = [...new Set(candidates.filter((candidate) => candidate.score === best).flatMap(({ method }) => {
        const returned = rawType(method.returnType)
        // BaseStream's fluent methods use its self type parameter.
        if (returned === 'S' && owner.typeNames.every((name) => name.startsWith('java.util.stream.'))) return owner.typeNames
        if (/^[A-Z]$/.test(returned) || returned.endsWith('[]') || PRIMITIVES.has(returned)) return []
        return canonicalTypes(source, returned)
      }))]
      return typeNames.length ? { kind: 'metadata', typeNames, isStatic: false } : EMPTY
    }
    if (/^"/.test(text)) return { kind: 'metadata', typeNames: ['java.lang.String'], isStatic: false }
    if (indexedArrayElementType(text, position, symbols) !== null) return resolveJavaReceiverTypes(source, text, position, symbols)
    const name = masked.trim().replace(/\s*\.\s*/g, '.')
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)) return EMPTY
    const symbol = symbolFor(name.replace(/^this\./, ''))
    if (symbol?.declaredType === 'var') {
      const typeNames = (await valueTypes(text, depth + 1)).filter((type) => !PRIMITIVES.has(type) && !type.endsWith('[]'))
      return typeNames.length ? { kind: 'metadata', typeNames, isStatic: false } : EMPTY
    }
    return resolveJavaReceiverTypes(source, name, position, symbols)
  }

  return resolve(receiver, 0)
}

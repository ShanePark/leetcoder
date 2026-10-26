import type { Completion } from '@codemirror/autocomplete'

import { applyJavaTypeText } from './imports'
import { JAVA_TYPE_IMPORTS, JAVA_TYPES, TYPE_GROUPS, type JavaSymbol } from './model'
import { baseType, simpleTypeName } from './source'
import { parameterNameAndType } from './source/symbols'

/**
 * Catalog types that can follow `new`, most commonly instantiated first. The
 * order ranks assignable implementations for a known expected type, so for
 * example `List` offers ArrayList before LinkedList and `Queue` offers
 * ArrayDeque before LinkedList and PriorityQueue.
 */
const INSTANTIABLE_TYPES = [
  'ArrayList', 'ArrayDeque', 'LinkedList', 'PriorityQueue', 'Stack',
  'HashMap', 'TreeMap', 'LinkedHashMap', 'HashSet', 'TreeSet', 'LinkedHashSet',
  'StringBuilder', 'String', 'BigInteger', 'BigDecimal', 'StringBuffer', 'Object',
]
/**
 * Wrapper types are offered for array creation (`new Integer[n]`), so they
 * insert only the name rather than a deprecated constructor call.
 */
const BOXED_TYPES = ['Integer', 'Long', 'Character', 'Double', 'Boolean', 'Byte', 'Short', 'Float']
const GENERIC_TYPES = new Set([
  'ArrayList', 'ArrayDeque', 'LinkedList', 'PriorityQueue', 'Stack',
  'HashMap', 'TreeMap', 'LinkedHashMap', 'HashSet', 'TreeSet', 'LinkedHashSet',
])
/** Array creation (`new int[n]`) is the only use of a primitive after `new`. */
const PRIMITIVE_TYPES = ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short']
const NOT_A_TYPE = new Set(['return', 'throw', 'new', 'case', 'default', 'else', 'var', 'void'])
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized'])
/** A type as written in a declaration, such as `Map<String, int[]>` or `java.util.List<Integer>[]`. */
const TYPE_SYNTAX = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[\w$\s,.?<>[\]]*>)?(?:\s*\[\s*\])*$/
const ANNOTATION = /@[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*\([^()]*\))?\s*/g

/** Return where the typed type name starts when the cursor follows `new`. */
export function constructorContextFrom(maskedSource: string, source: string, position: number): number | null {
  const word = /[\w$]*$/.exec(maskedSource.slice(0, position))![0]
  const from = position - word.length
  if (maskedSource.slice(from, position) !== source.slice(from, position)) return null
  return /(?:^|[^\w$.:])new\s+$/.test(maskedSource.slice(0, from)) ? from : null
}

function visibleSymbol(symbols: JavaSymbol[], name: string, position: number): JavaSymbol | null {
  return symbols
    .filter((symbol) => symbol.name === name && symbol.scopeStart <= position && position <= symbol.scopeEnd
      && (symbol.kind === 'field' || symbol.declaredAt <= position))
    .sort((left, right) => (left.scopeEnd - left.scopeStart) - (right.scopeEnd - right.scopeStart)
      || right.declaredAt - left.declaredAt)[0] ?? null
}

function enclosingMethodReturnType(masked: string, position: number): string | null {
  let depth = 0
  for (let index = position - 1; index >= 0; index -= 1) {
    if (masked[index] === '}') depth += 1
    else if (masked[index] === '{' && depth-- === 0) {
      const before = masked.slice(Math.max(0, index - 300), index).trimEnd()
      // A `return` inside a lambda body returns the lambda's value, whose type
      // is not known here.
      if (before.endsWith('->')) return null
      const header = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()=]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\([^(){};]*\)\s*(?:throws\s+[^{};()]+)?$/
        .exec(before)
      // Control-flow blocks and anonymous class bodies are not method bodies;
      // keep looking outward from the same depth.
      if (!header || CONTROL_WORDS.has(header[2]) || /^(?:new|else)$/.test(header[1])) {
        depth = 0
        continue
      }
      return NOT_A_TYPE.has(baseType(header[1])) ? null : header[1]
    }
  }
  return null
}

/**
 * Infer the type a `new` expression must satisfy from the declaration,
 * assignment, or `return` statement it completes.
 */
export function constructorExpectedType(masked: string, newFrom: number, symbols: JavaSymbol[]): string | null {
  const before = masked.slice(0, newFrom).replace(/new\s+$/, '').trimEnd()
  if (/(?:^|[^\w$.])return$/.test(before)) return enclosingMethodReturnType(masked, newFrom)
  if (!/[^=!<>+\-*/%&|^]=$/.test(before)) return null
  const left = before.slice(0, -1).trimEnd()
  // `)` ends a condition or an annotation argument list, as in
  // `if (node == null) node = new` or `@SuppressWarnings("unchecked") List<Integer>[] g = new`.
  const statementStart = Math.max(...[';', '{', '}', '(', ')'].map((boundary) => left.lastIndexOf(boundary))) + 1
  const statement = left.slice(statementStart)
    .replace(ANNOTATION, '')
    .replace(/\b(?:public|private|protected|static|final|volatile|transient)\s+/g, '')
    .trim()
  const declaration = parameterNameAndType(statement)
  if (declaration) {
    return TYPE_SYNTAX.test(declaration.type) && !NOT_A_TYPE.has(baseType(declaration.type)) ? declaration.type : null
  }
  const assigned = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(statement)
  if (!assigned) return null
  const declaredType = visibleSymbol(symbols, assigned[1], newFrom)?.declaredType
  return declaredType && declaredType !== 'var' && TYPE_SYNTAX.test(declaredType) ? declaredType : null
}

interface ConstructorType {
  name: string
  generic: boolean
  detail?: string
  /** Only valid in array creation, so no constructor call is inserted. */
  arrayOnly?: boolean
}

function localConstructorTypes(masked: string): ConstructorType[] {
  const types: ConstructorType[] = []
  const declaration = /\b(abstract\s+(?:[a-z]+\s+)*)?(?:class|record)\s+([A-Za-z_$][\w$]*)\s*(<)?/g
  let match: RegExpExecArray | null
  while ((match = declaration.exec(masked))) {
    if (!match[1]) types.push({ name: match[2], generic: Boolean(match[3]) })
  }
  return types
}

function constructorCompletion(type: ConstructorType, boost: number | undefined): Completion {
  const label = type.generic ? `${type.name}<>` : type.name
  return {
    label,
    type: 'class',
    detail: type.detail,
    ...(boost === undefined ? {} : { boost }),
    apply: type.arrayOnly
      ? applyJavaTypeText(JAVA_TYPE_IMPORTS[type.name], label)
      : applyJavaTypeText(JAVA_TYPE_IMPORTS[type.name], `${label}()`, label.length + 1),
  }
}

/** Options for the type name after `new`: only types that can be instantiated. */
export function javaConstructorCompletions(masked: string, newFrom: number, symbols: JavaSymbol[]): Completion[] {
  const expected = constructorExpectedType(masked, newFrom, symbols)
  const expectedBase = expected ? simpleTypeName(baseType(expected)) : ''
  const expectedArray = expected?.replace(/\s+/g, '').endsWith('[]') ?? false

  const local = localConstructorTypes(masked)
  const localNames = new Set(local.map((type) => type.name))
  const types: ConstructorType[] = [
    ...INSTANTIABLE_TYPES.filter((name) => !localNames.has(name)).map((name) => ({
      name,
      generic: GENERIC_TYPES.has(name),
      detail: JAVA_TYPE_IMPORTS[name]?.replace(/\.[^.]+$/, '') ?? 'java.lang',
    })),
    ...BOXED_TYPES.filter((name) => !localNames.has(name)).map((name) => ({
      name,
      generic: false,
      detail: 'java.lang',
      arrayOnly: true,
    })),
    ...local,
  ]
  // A declared class the catalog does not know about (for example a node type
  // defined in another file) is still the most likely thing to construct. A
  // qualified name such as `Map.Entry` would lose its qualifier, so skip it.
  if (expected && !expectedArray && /^[A-Z][\w$]*$/.test(expectedBase) && !/\./.test(baseType(expected))
    && !JAVA_TYPES.includes(expectedBase)
    && !types.some((type) => type.name === expectedBase)) {
    types.push({ name: expectedBase, generic: /</.test(expected) })
  }

  const ranked = expected && !expectedArray
    ? types.filter((type) => type.name === expectedBase || (TYPE_GROUPS[type.name] ?? []).includes(expectedBase))
      .sort((left, right) => Number(right.name === expectedBase) - Number(left.name === expectedBase))
    : []
  const options = types.map((type) => {
    const rank = ranked.indexOf(type)
    return constructorCompletion(type, rank >= 0 ? 50 - rank : undefined)
  })
  options.push(...PRIMITIVE_TYPES.map((label) => ({ label, type: 'keyword' as const })))
  if (expected && expectedArray) {
    const dimensions = expected.match(/\[\s*\]/g)?.length ?? 1
    const arrayType = `${baseType(expected)}${'[]'.repeat(dimensions)}`
    const elementBase = simpleTypeName(baseType(expected))
    options.push({
      label: arrayType,
      type: 'class',
      boost: 50,
      apply: applyJavaTypeText(JAVA_TYPE_IMPORTS[elementBase], arrayType, baseType(expected).length + 1),
    })
  }
  return options
}

import { maskJavaCommentsAndLiterals } from '../completions'

import type {
  JavaDeclaration,
  JavaMethodExtractionFailure,
  JavaMethodInfo,
  JavaOutput,
  JavaSyntaxNode,
} from './types'
import {
  EXPRESSION_NODES,
  descendants,
  expressionChildren,
  methodInvocationName,
  methodInvocationReceiverText,
} from './syntax'
import { declarationAt } from './declarations'

export const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var',
  'void', 'volatile', 'while', 'true', 'false', 'null', 'yield',
])

const COMMON_JAVA_TYPES = new Set([
  'ArrayDeque', 'ArrayList', 'Arrays', 'BigDecimal', 'BigInteger', 'Boolean', 'Byte', 'Character',
  'Collections', 'Comparator', 'Deque', 'Double', 'Float', 'HashMap', 'HashSet', 'Integer',
  'Iterable', 'Iterator', 'LinkedHashMap', 'LinkedHashSet', 'LinkedList', 'List', 'Long', 'Map',
  'Math', 'Number', 'Object', 'PriorityQueue', 'Queue', 'Set', 'Short', 'Stack', 'String',
  'StringBuilder', 'StringBuffer', 'System', 'TreeMap', 'TreeSet',
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short',
])

export function identifierOccurrences(
  source: string,
  from: number,
  to: number,
): Array<{ name: string; from: number; to: number }> {
  const masked = maskJavaCommentsAndLiterals(source).slice(from, to)
  const result: Array<{ name: string; from: number; to: number }> = []
  const pattern = /[$A-Za-z_][$\w]*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(masked))) {
    result.push({
      name: match[0],
      from: from + match.index,
      to: from + match.index + match[0].length,
    })
  }
  return result
}

function isPropertyOrMethodName(
  source: string,
  occurrence: { from: number; to: number },
): boolean {
  let before = occurrence.from - 1
  while (before >= 0 && /[ \t]/.test(source[before])) before -= 1
  let after = occurrence.to
  while (after < source.length && /[ \t]/.test(source[after])) after += 1
  return source[before] === '.'
    || source[after] === '('
    || source.slice(Math.max(0, before - 1), before + 1) === '::'
}

function definitionOccurrence(
  declarations: readonly JavaDeclaration[],
  occurrence: { from: number; to: number },
): boolean {
  return declarations.some((candidate) => candidate.definitionFrom === occurrence.from
    && candidate.definitionTo === occurrence.to)
}

export function isIdentifier(value: string): boolean {
  return /^[$A-Za-z_][$\w]*$/.test(value)
}

export function freeJavaDeclarations(
  source: string,
  from: number,
  to: number,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
): { free: JavaDeclaration[]; reason: string | null } {
  const free: JavaDeclaration[] = []
  const seen = new Set<string>()
  const methodNames = new Set(methods.map((method) => method.name))
  for (const occurrence of identifierOccurrences(source, from, to)) {
    if (isPropertyOrMethodName(source, occurrence)) continue
    const declaration = declarationAt(declarations, occurrence.name, occurrence.from)
    // Resolve declarations before filtering names such as String or size:
    // users may legally have locals with either name.
    if (declaration) {
      if (declaration.declaredAt >= from && declaration.declaredAt < to) continue
      if (declaration.kind === 'field') continue
      if (!seen.has(declaration.name)) {
        seen.add(declaration.name)
        free.push(declaration)
      }
      continue
    }
    if (JAVA_KEYWORDS.has(occurrence.name)
      || COMMON_JAVA_TYPES.has(occurrence.name)
      || methodNames.has(occurrence.name)
      || definitionOccurrence(declarations, occurrence)) {
      continue
    }
    let before = occurrence.from - 1
    while (before >= 0 && /[ \t]/.test(source[before])) before -= 1
    // An imported or nested type is not a method argument. Unknown lowercase
    // identifiers are rejected because passing no parameter would break the
    // extracted method.
    if (source.slice(Math.max(0, before - 3), before + 1).endsWith('new')
      || /^[A-Z_$]/.test(occurrence.name)) {
      continue
    }
    return { free, reason: "Cannot determine the type of '" + occurrence.name + "'." }
  }
  return { free, reason: null }
}


export function assignmentTargets(source: string, nodes: readonly JavaSyntaxNode[]): Set<string> {
  const result = new Set<string>()
  for (const root of nodes) {
    for (const assignment of descendants(root, (node) => node.name === 'AssignmentExpression')) {
      const target = expressionChildren(assignment)
        .find((candidate) => EXPRESSION_NODES.has(candidate.name))
      if (target?.name === 'Identifier') result.add(source.slice(target.from, target.to))
    }
    for (const update of descendants(root, (node) => node.name === 'UpdateExpression')) {
      const target = expressionChildren(update).find((candidate) => candidate.name === 'Identifier')
      if (target) result.add(source.slice(target.from, target.to))
    }
  }
  return result
}

function hasUseAfter(
  source: string,
  declaration: JavaDeclaration,
  after: number,
  method: JavaMethodInfo,
): boolean {
  return identifierOccurrences(source, after, method.body.to - 1).some((occurrence) => (
    occurrence.name === declaration.name
      && occurrence.from > declaration.definitionTo
      && declarationAt([declaration], occurrence.name, occurrence.from) !== null
      && !definitionOccurrence([declaration], occurrence)
      && !isPropertyOrMethodName(source, occurrence)
  ))
}

function selectedDeclarations(
  declarations: readonly JavaDeclaration[],
  from: number,
  to: number,
): JavaDeclaration[] {
  return declarations.filter((declaration) => declaration.kind !== 'field'
    && declaration.declaredAt >= from
    && declaration.declaredAt < to)
}

export function outputForStatements(
  source: string,
  statements: readonly JavaSyntaxNode[],
  from: number,
  to: number,
  method: JavaMethodInfo,
  declarations: readonly JavaDeclaration[],
): JavaOutput | JavaMethodExtractionFailure {
  const declared = selectedDeclarations(declarations, from, to)
  const escaped = declared.filter((declaration) => hasUseAfter(source, declaration, to, method))
  const assigned = [...assignmentTargets(source, statements)]
    .map((name) => declarationAt(declarations, name, from + 1))
    .filter((declaration): declaration is JavaDeclaration => declaration !== null
      && declaration.kind !== 'field')
  const candidates = [...new Map([...escaped, ...assigned]
    .map((declaration) => [declaration.name, declaration])).values()]
  if (candidates.length > 1) return { reason: 'The selected statements produce more than one value.' }
  const escapedOutput = escaped.length === 1 ? escaped[0] : null
  const assignedOutput = assigned.find((candidate) => (
    !escapedOutput || candidate.name !== escapedOutput.name
  )) ?? (escapedOutput ? null : assigned[0] ?? null)
  if (escapedOutput && !escapedOutput.initialized) {
    return { reason: 'A selected variable is used after extraction before it is initialized.' }
  }
  return { declaration: escapedOutput, existing: assignedOutput }
}

export function rejectControlFlow(nodes: readonly JavaSyntaxNode[]): JavaMethodExtractionFailure | null {
  const forbidden = new Set([
    'BreakStatement', 'ContinueStatement', 'ReturnStatement', 'ThrowStatement', 'YieldStatement',
  ])
  for (const root of nodes) {
    if (descendants(root, (node) => forbidden.has(node.name)).length > 0) {
      return { reason: 'The selected block contains control flow that cannot safely leave a new method.' }
    }
  }
  return null
}

export function checkedCallInSelection(
  source: string,
  nodes: readonly JavaSyntaxNode[],
  method: JavaMethodInfo,
  methods: readonly JavaMethodInfo[],
): boolean {
  if (method.throwsClause) return false
  const throwingNames = new Set(methods
    .filter((candidate) => candidate.throwsClause)
    .map((candidate) => candidate.name))
  if (throwingNames.size === 0) return false
  return nodes.some((root) => descendants(root, (node) => node.name === 'MethodInvocation')
    .some((node) => {
      const name = methodInvocationName(source, node)
      return name !== null
        && throwingNames.has(name)
        && methodInvocationReceiverText(source, node) === ''
    }))
}

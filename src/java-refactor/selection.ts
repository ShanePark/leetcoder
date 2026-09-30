import { javaLanguage } from '@codemirror/lang-java'

import type {
  JavaMethodExtractionFailure,
  JavaMethodInfo,
  JavaRefactorSelection,
  JavaSelection,
  JavaSyntaxNode,
} from './types'
import { EXPRESSION_NODES, STATEMENT_NODES, children, descendants } from './syntax'
import { containingMethod } from './declarations'

function trimSelection(source: string, from: number, to: number): { from: number; to: number } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.length || to <= from) {
    return null
  }
  let start = from
  let end = to
  while (start < end && /\s/.test(source[start])) start += 1
  while (end > start && /\s/.test(source[end - 1])) end -= 1
  return start < end ? { from: start, to: end } : null
}


function exactExpression(tree: JavaSyntaxNode, from: number, to: number): JavaSyntaxNode | null {
  const candidates = descendants(tree, (node) => node.from === from && node.to === to && EXPRESSION_NODES.has(node.name))
  return candidates
    .filter((node) => !(node.name === 'Identifier'
      && node.parent
      && (node.parent.name === 'FieldAccess' || node.parent.name === 'MethodInvocation'
        || node.parent.name === 'MethodName')))
    .sort((left, right) => (right.to - right.from) - (left.to - left.from))[0] ?? null
}

function statementCandidate(node: JavaSyntaxNode): boolean {
  return STATEMENT_NODES.has(node.name) && !node.type.isError
}

function cursorRelation(
  source: string,
  node: JavaSyntaxNode,
  position: number,
): 'inside' | 'after' | null {
  if (position >= node.from && position <= node.to) return 'inside'
  if (position < node.to) return null
  const suffix = source.slice(node.to, position)
  // The caret commonly sits just after the closing parenthesis, the
  // statement semicolon, or spaces following it. Keep this bounded to one
  // line so a blank line cannot select the preceding statement by accident.
  if (/^[ \t]*(?:;[ \t]*)?$/.test(suffix)) return 'after'
  return null
}

function expressionSelectable(node: JavaSyntaxNode): boolean {
  if (!EXPRESSION_NODES.has(node.name) || node.type.isError) return false
  if (node.name !== 'Identifier') return true
  return !(node.parent
    && (node.parent.name === 'FieldAccess'
      || node.parent.name === 'MethodInvocation'
      || node.parent.name === 'MethodName'))
}

function chooseRefactorNode(
  source: string,
  nodes: readonly JavaSyntaxNode[],
  position: number,
  predicate: (node: JavaSyntaxNode) => boolean,
): JavaSyntaxNode | null {
  const candidates = nodes
    .filter(predicate)
    .map((node) => ({ node, relation: cursorRelation(source, node, position) }))
    .filter((candidate): candidate is { node: JavaSyntaxNode; relation: 'inside' | 'after' } => (
      candidate.relation !== null
    ))
  if (candidates.length === 0) return null

  // At the end of a call, prefer the expression whose end is nearest the
  // caret and then the widest expression ending there. This is what keeps a
  // closing `)` from resolving to the final argument literal.
  const adjacent = candidates.filter((candidate) => candidate.relation === 'after'
    || candidate.node.to <= position)
  if (adjacent.length > 0) {
    return [...adjacent].sort((left, right) => (
      right.node.to - left.node.to
        || (right.node.to - right.node.from) - (left.node.to - left.node.from)
    ))[0].node
  }

  // While the caret is inside an expression, use the most specific node. A
  // call or compound expression wins over a method/field identifier that
  // happens to start at the same offset.
  return [...candidates].sort((left, right) => {
    const width = (left.node.to - left.node.from) - (right.node.to - right.node.from)
    if (width !== 0) return width
    if (left.node.name === 'Identifier' && right.node.name !== 'Identifier') return 1
    if (right.node.name === 'Identifier' && left.node.name !== 'Identifier') return -1
    return left.node.from - right.node.from
  })[0].node
}

/**
 * Infer the expression or statement under a Java editor caret.
 *
 * `expression` is used by Introduce Variable and is tried first by Extract
 * Method. `statement` lets the latter fall back to a complete statement when
 * the expression cannot be extracted safely.
 */
export function findJavaRefactorSelection(
  source: string,
  position: number,
  preference: 'expression' | 'statement' = 'expression',
): JavaRefactorSelection | null {
  if (!Number.isInteger(position) || position < 0 || position > source.length) return null
  const tree = javaLanguage.parser.parse(source).topNode
  if (preference === 'expression') {
    const expression = chooseRefactorNode(
      source,
      descendants(tree, expressionSelectable),
      position,
      expressionSelectable,
    )
    return expression ? { from: expression.from, to: expression.to, kind: 'expression' } : null
  }
  const statements = descendants(tree, (node) => (
    statementCandidate(node) && node.name !== 'Block' && node.name !== 'EmptyStatement'
  ))
  const statement = chooseRefactorNode(source, statements, position, statementCandidate)
  return statement ? { from: statement.from, to: statement.to, kind: 'statement' } : null
}

function selectedStatements(
  source: string,
  method: JavaMethodInfo,
  from: number,
  to: number,
): JavaSyntaxNode[] {
  const block = descendants(method.body, (node) => node.name === 'Block')
    .filter((candidate) => candidate.from < from && to < candidate.to)
    .sort((left, right) => (left.to - left.from) - (right.to - right.from))[0]
  if (!block) return []
  const direct = children(block).filter(statementCandidate)
  const selected = direct.filter((node) => node.from >= from && node.to <= to)
  if (selected.length === 0) return []
  const first = selected[0]
  const last = selected[selected.length - 1]
  if (first.from !== from || last.to !== to) return []
  const directBetween = direct.filter((node) => node.from >= first.from && node.to <= last.to)
  if (directBetween.length !== selected.length) return []
  for (let index = 1; index < selected.length; index += 1) {
    const gap = source.slice(selected[index - 1].to, selected[index].from)
    if (/[^\u0009\u000a\u000d\u0020]/.test(gap)
      && !/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/.test(gap)) return []
  }
  return selected
}

export function selectJavaSource(
  source: string,
  tree: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
  from: number,
  to: number,
): JavaSelection | JavaMethodExtractionFailure {
  const trimmed = trimSelection(source, from, to)
  if (!trimmed) return { reason: 'Select an expression or complete statement block.' }
  const method = containingMethod(methods, trimmed.from, trimmed.to)
  if (!method) return { reason: 'Selection must be inside a method body.' }
  if (descendants(method.body).some((node) => node.type.isError)) {
    return { reason: 'The containing method has syntax errors.' }
  }
  const expression = exactExpression(tree, trimmed.from, trimmed.to)
  if (expression) {
    if (expression.name === 'Definition' || expression.name === 'TypeName'
      || expression.name === 'PrimitiveType' || expression.name === 'MethodName') {
      return { reason: 'Select an expression, not a declaration or method name.' }
    }
    return { from: trimmed.from, to: trimmed.to, method, expression, statements: [] }
  }
  const statements = selectedStatements(source, method, trimmed.from, trimmed.to)
  if (statements.length === 0) return { reason: 'Select a complete expression or whole statement block.' }
  return { from: trimmed.from, to: trimmed.to, method, expression: null, statements }
}

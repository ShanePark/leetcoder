import type { JavaSyntaxNode } from './types'

export const TYPE_NODES = new Set([
  'AnnotatedType', 'ArrayType', 'GenericType', 'PrimitiveType', 'ScopedTypeName', 'TypeName', 'void', 'var',
])

export const EXPRESSION_NODES = new Set([
  'ArrayAccess', 'ArrayCreationExpression', 'ArrayInitializer', 'AssignmentExpression', 'BinaryExpression',
  'BooleanLiteral', 'CastExpression', 'CharacterLiteral', 'ClassLiteral', 'FloatingPointLiteral',
  'Identifier', 'InstanceofExpression', 'LambdaExpression', 'MethodInvocation', 'MethodReference', 'null',
  'ObjectCreationExpression', 'ParenthesizedExpression', 'StringLiteral', 'TextBlock', 'TernaryExpression',
  'UnaryExpression', 'UpdateExpression', 'IntegerLiteral',
])

export const STATEMENT_NODES = new Set([
  'AssertStatement', 'Block', 'BreakStatement', 'ContinueStatement', 'DoStatement', 'EmptyStatement',
  'ExpressionStatement', 'ForStatement', 'IfStatement', 'LabeledStatement', 'LocalVariableDeclaration',
  'ReturnStatement', 'SwitchStatement', 'SynchronizedStatement', 'ThrowStatement', 'TryStatement',
  'WhileStatement', 'YieldStatement',
])

export function children(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}

export function descendants(node: JavaSyntaxNode, predicate?: (candidate: JavaSyntaxNode) => boolean): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  const visit = (current: JavaSyntaxNode): void => {
    if (!predicate || predicate(current)) result.push(current)
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(node)
  return result
}

export function firstChildNamed(node: JavaSyntaxNode, names: ReadonlySet<string>): JavaSyntaxNode | null {
  return children(node).find((child) => names.has(child.name)) ?? null
}

export function nearestAncestor(node: JavaSyntaxNode | null, names: ReadonlySet<string>): JavaSyntaxNode | null {
  let current = node
  while (current) {
    if (names.has(current.name)) return current
    current = current.parent
  }
  return null
}

export function lineBreakOf(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

export function lineStart(source: string, position: number): number {
  let result = Math.max(0, Math.min(position, source.length))
  while (result > 0 && source[result - 1] !== '\n' && source[result - 1] !== '\r') result -= 1
  return result
}

export function leadingIndent(source: string, position: number): string {
  const prefix = source.slice(lineStart(source, position), position)
  return /^[ \t]*/.exec(prefix)?.[0] ?? ''
}


export function expressionChildren(node: JavaSyntaxNode): JavaSyntaxNode[] {
  return children(node).filter((child) => !['(', ')', '[', ']', '{', '}', ',', ';', '.'].includes(child.name))
}

export function methodInvocationName(source: string, node: JavaSyntaxNode): string | null {
  const methodName = descendants(node, (candidate) => candidate.name === 'MethodName')[0]
  if (methodName) return source.slice(methodName.from, methodName.to)
  const match = /(?:^|\.)\s*([$A-Za-z_][$\w]*)\s*\(/.exec(source.slice(node.from, node.to))
  return match?.[1] ?? null
}

export function methodInvocationReceiverText(source: string, node: JavaSyntaxNode): string {
  const methodName = descendants(node, (candidate) => candidate.name === 'MethodName')[0]
  if (!methodName) return ''
  return source.slice(node.from, methodName.from).trim().replace(/\.$/, '').trim()
}

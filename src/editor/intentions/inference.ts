import {
  children,
  classBodyFor,
  classNameForBody,
  declarationAt,
  declarationType,
  descendants,
  directChild,
  invocationNameNode,
  JAVA_KEYWORDS,
  LOCAL_DECLARATION_NODES,
  nearestAncestor,
  PUNCTUATION_NODES,
  TYPE_NODES,
} from './analysis'
import type { JavaDeclaration, JavaInvocationInfo, JavaMethodInfo, JavaSyntaxNode } from './types'

function simpleTypeName(type: string): string {
  const withoutGenerics = type.replace(/<.*>/gs, '')
  return withoutGenerics.replace(/\[\]/g, '').split('.').at(-1) ?? withoutGenerics
}

export function normalizeType(type: string): string {
  return type.replace(/\s+/g, ' ').trim() || 'Object'
}

function declarationFromExpression(
  source: string,
  node: JavaSyntaxNode,
  declarations: readonly JavaDeclaration[],
  invocation: JavaInvocationInfo,
): JavaDeclaration | null {
  if (node.name !== 'Identifier') {
    return null
  }
  return declarationAt(
    declarations,
    source.slice(node.from, node.to),
    invocation.node.from,
    invocation.classBody,
    invocation.method,
  )
}

export function expressionType(
  source: string,
  node: JavaSyntaxNode,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  invocation: JavaInvocationInfo,
): string {
  if (node.name === 'ParenthesizedExpression') {
    const child = children(node).find((candidate) => !PUNCTUATION_NODES.has(candidate.name))
    return child ? expressionType(source, child, declarations, methods, invocation) : 'Object'
  }
  const declaration = declarationFromExpression(source, node, declarations, invocation)
  if (declaration) {
    return normalizeType(declaration.type === 'var' ? 'Object' : declaration.type)
  }
  if (node.name === 'ArrayAccess') {
    const array = children(node).find((child) => !PUNCTUATION_NODES.has(child.name))
    if (!array) return 'Object'
    const arrayType = normalizeType(expressionType(source, array, declarations, methods, invocation))
    return arrayType.endsWith('[]') ? arrayType.slice(0, -2) : 'Object'
  }
  if (node.name === 'this') {
    return classNameForBody(source, invocation.classBody) ?? 'Object'
  }
  if (node.name === 'ObjectCreationExpression') {
    const type = children(node).find((child) => TYPE_NODES.has(child.name))
    return type ? normalizeType(source.slice(type.from, type.to)) : 'Object'
  }
  if (node.name === 'CastExpression') {
    const type = children(node).find((child) => TYPE_NODES.has(child.name))
    return type ? normalizeType(source.slice(type.from, type.to)) : 'Object'
  }
  if (node.name === 'IntegerLiteral') return 'int'
  if (node.name === 'FloatingPointLiteral') return 'double'
  if (node.name === 'BooleanLiteral') return 'boolean'
  if (node.name === 'CharacterLiteral') return 'char'
  if (node.name === 'StringLiteral' || node.name === 'TextBlock') return 'String'
  if (node.name === 'null') return 'Object'
  if (node.name === 'ArrayCreationExpression') {
    const type = children(node).find((child) => TYPE_NODES.has(child.name))
    if (type) return `${normalizeType(source.slice(type.from, type.to))}[]`
  }
  if (node.name === 'MethodInvocation') {
    const nestedName = invocationNameNode(node)
    const nestedOwner = classBodyFor(node)
    if (nestedName && nestedOwner) {
      const nested = methods.find((method) => method.classBody.from === nestedOwner.from
        && method.classBody.to === nestedOwner.to
        && method.name === source.slice(nestedName.from, nestedName.to))
      if (nested) return normalizeType(nested.returnType)
    }
  }
  if (node.name === 'BinaryExpression' || node.name === 'UnaryExpression' || node.name === 'UpdateExpression') {
    const text = source.slice(node.from, node.to)
    if (/[<>!=]=?|&&|\|\|/.test(text)) return 'boolean'
    if (/\+/.test(text) && /"/.test(text)) return 'String'
    return 'int'
  }
  return 'Object'
}

function isBooleanContext(source: string, invocation: JavaInvocationInfo): boolean {
  let current = invocation.node
  while (current.parent) {
    const parent = current.parent
    if (parent.name === 'UnaryExpression') {
      const operator = children(parent).find((child) => child.name === 'LogicOp')
      return operator ? source.slice(operator.from, operator.to).trim() === '!' : false
    }
    if (parent.name === 'ParenthesizedExpression') {
      current = parent
      continue
    }
    if (parent.name === 'BinaryExpression') {
      const text = source.slice(parent.from, parent.to)
      return /&&|\|\|/.test(text)
    }
    if (parent.name === 'IfStatement' || parent.name === 'WhileStatement' || parent.name === 'DoStatement') {
      const condition = children(parent).find((child) => child.name === 'ParenthesizedExpression')
      return Boolean(condition && condition.from <= current.from && current.to <= condition.to)
    }
    break
  }
  return false
}

export function expressionName(source: string, node: JavaSyntaxNode): string {
  if (node.name === 'Identifier') return source.slice(node.from, node.to)
  if (node.name === 'FieldAccess') {
    const identifiers = descendants(node, (candidate) => candidate.name === 'Identifier')
    return identifiers.length > 0 ? source.slice(identifiers[identifiers.length - 1]!.from, identifiers[identifiers.length - 1]!.to) : 'value'
  }
  if (node.name === 'ObjectCreationExpression') {
    const type = children(node).find((child) => TYPE_NODES.has(child.name))
    if (type) {
      const simple = simpleTypeName(source.slice(type.from, type.to))
      return simple ? `${simple[0]!.toLowerCase()}${simple.slice(1)}` : 'value'
    }
  }
  if (node.name === 'MethodInvocation') {
    const name = invocationNameNode(node)
    if (name) return source.slice(name.from, name.to)
  }
  return 'value'
}

export function safeParameterName(base: string, used: ReadonlySet<string>): string {
  const normalized = /^[A-Za-z_$][\w$]*$/.test(base) && !JAVA_KEYWORDS.has(base) ? base : 'value'
  if (!used.has(normalized)) return normalized
  let suffix = 2
  while (used.has(`${normalized}${suffix}`)) suffix += 1
  return `${normalized}${suffix}`
}

export function returnTypeFor(
  source: string,
  invocation: JavaInvocationInfo,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
): string {
  const variable = nearestAncestor(invocation.node.parent, new Set(['VariableDeclarator']))
  if (variable) {
    const declaration = nearestAncestor(variable.parent, LOCAL_DECLARATION_NODES)
    const type = declaration ? declarationType(source, declaration, variable) : null
    if (type && type !== 'var') return normalizeType(type)
  }
  const assignment = nearestAncestor(invocation.node.parent, new Set(['AssignmentExpression']))
  if (assignment) {
    const left = children(assignment).find((child) => child.name === 'Identifier')
    if (left) {
      const declaration = declarationFromExpression(source, left, declarations, invocation)
      if (declaration && declaration.type !== 'var') return normalizeType(declaration.type)
    }
  }
  const returnStatement = nearestAncestor(invocation.node.parent, new Set(['ReturnStatement']))
  if (returnStatement && invocation.method) return normalizeType(invocation.method.returnType)
  const expressionStatement = nearestAncestor(invocation.node.parent, new Set(['ExpressionStatement']))
  if (expressionStatement) return 'void'
  if (isBooleanContext(source, invocation)) return 'boolean'
  const comparison = nearestAncestor(invocation.node.parent, new Set(['BinaryExpression']))
  const comparisonOperator = comparison && directChild(comparison, 'CompareOp')
  if (comparison && comparisonOperator && source.slice(comparisonOperator.from, comparisonOperator.to).trim() !== 'instanceof') {
    const operands = children(comparison).filter((child) => child.name !== 'CompareOp')
    const invocationOperand = operands.find((operand) => (
      operand.from <= invocation.node.from && invocation.node.to <= operand.to
    ))
    const otherOperand = operands.find((operand) => operand !== invocationOperand)
    if (otherOperand) {
      return expressionType(source, otherOperand, declarations, methods, invocation)
    }
  }
  return 'Object'
}

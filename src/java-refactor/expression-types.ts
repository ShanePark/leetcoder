import type { JavaDeclaration, JavaMethodInfo, JavaSyntaxNode } from './types'
import {
  EXPRESSION_NODES,
  TYPE_NODES,
  children,
  descendants,
  expressionChildren,
  firstChildNamed,
  methodInvocationName,
  methodInvocationReceiverText,
} from './syntax'
import { declarationAt } from './declarations'

function stripOneArrayDimension(type: string): string | null {
  const match = /^(.*?)(?:\[\s*\])+$/.exec(type.trim())
  if (!match) return null
  const dimensions = type.trim().slice(match[1].length).match(/\[\s*\]/g)?.length ?? 0
  return dimensions > 1 ? match[1].trim() + '[]'.repeat(dimensions - 1) : match[1].trim()
}

function numericType(type: string | null): boolean {
  return type !== null && /^(?:byte|short|int|long|float|double|char)$/.test(type.trim())
}

function promotedNumericType(types: readonly (string | null)[]): string | null {
  if (types.length === 0 || types.some((type) => type === null)) return null
  const known = types.map((type) => type!.trim())
  if (!known.every(numericType)) return null
  if (known.includes('double')) return 'double'
  if (known.includes('float')) return 'float'
  if (known.includes('long')) return 'long'
  return 'int'
}


function knownMethodReturnType(
  source: string,
  node: JavaSyntaxNode,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  receiverType: string | null,
): string | null {
  const name = methodInvocationName(source, node)
  if (!name) return null
  const receiverText = methodInvocationReceiverText(source, node)
  const declared = [...new Set(methods
    .filter((method) => method.name === name)
    .map((method) => method.returnType)
    .filter((type): type is string => Boolean(type)))]
  if (declared.length === 1 && receiverText === '') return declared[0]
  if (receiverText === 'Math') {
    const argumentList = node.getChild('ArgumentList')
    const arguments_ = argumentList
      ? expressionChildren(argumentList).filter((candidate) => EXPRESSION_NODES.has(candidate.name))
      : []
    const argumentTypes = arguments_.map((argument) => (
      inferJavaExpressionType(source, argument, declarations, methods)
    ))
    if (name === 'max' || name === 'min') {
      return promotedNumericType(argumentTypes)
    }
  }
  const base = receiverType?.replace(/\s*<[\s\S]*>\s*$/, '').trim()
  if (base === 'String') {
    if (name === 'length' || name === 'hashCode') return 'int'
    if (name === 'charAt') return 'char'
    if (name === 'equals' || name === 'isEmpty' || name === 'contains'
      || name === 'startsWith' || name === 'endsWith') return 'boolean'
    if (name === 'toString' || name === 'substring' || name === 'trim') return 'String'
  }
  if (base && /^(?:List|Set|Map|Collection|Iterable|Queue|Deque|ArrayList|HashMap|HashSet)$/.test(base)) {
    if (name === 'size' || name === 'hashCode') return 'int'
    if (name === 'isEmpty' || name === 'contains') return 'boolean'
    if (name === 'toString') return 'String'
  }
  return null
}

export function inferJavaExpressionType(
  source: string,
  node: JavaSyntaxNode,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
): string | null {
  const text = source.slice(node.from, node.to).trim()
  if (node.name === 'Identifier') return declarationAt(declarations, text, node.from + 1)?.type ?? null
  if (node.name === 'IntegerLiteral') return /[lL]$/.test(text) ? 'long' : 'int'
  if (node.name === 'FloatingPointLiteral') return /[fF]$/.test(text) ? 'float' : 'double'
  if (node.name === 'BooleanLiteral') return 'boolean'
  if (node.name === 'CharacterLiteral') return 'char'
  if (node.name === 'StringLiteral' || node.name === 'TextBlock') return 'String'
  if (node.name === 'null') return null
  if (node.name === 'ParenthesizedExpression') {
    const child = expressionChildren(node).find((candidate) => EXPRESSION_NODES.has(candidate.name))
    return child ? inferJavaExpressionType(source, child, declarations, methods) : null
  }
  if (node.name === 'CastExpression') {
    const type = firstChildNamed(node, TYPE_NODES)
    return type ? source.slice(type.from, type.to).trim() : null
  }
  if (node.name === 'ArrayAccess') {
    const base = expressionChildren(node)[0]
    const baseType = base ? inferJavaExpressionType(source, base, declarations, methods) : null
    return baseType ? stripOneArrayDimension(baseType) : null
  }
  if (node.name === 'FieldAccess') {
    if (/\.length$/.test(text)) return 'int'
    const property = /(?:^|\.)\s*([$A-Za-z_][$\w]*)$/.exec(text)?.[1]
    if (!property) return null
    return declarations.find((candidate) => candidate.name === property && candidate.kind === 'field')?.type ?? null
  }
  if (node.name === 'ArrayCreationExpression') {
    const type = firstChildNamed(node, TYPE_NODES)
    if (!type) return null
    const dimensions = descendants(node, (candidate) => candidate.name === 'Dimension').length
    return source.slice(type.from, type.to).trim() + '[]'.repeat(dimensions)
  }
  if (node.name === 'ObjectCreationExpression') {
    const type = firstChildNamed(node, TYPE_NODES)
    if (!type) return null
    const typeText = source.slice(type.from, type.to).trim()
    return /<\s*>$/.test(typeText) ? null : typeText
  }
  if (node.name === 'MethodInvocation') {
    const receiver = expressionChildren(node).find((candidate) => candidate.name !== 'ArgumentList')
    const receiverType = receiver ? inferJavaExpressionType(source, receiver, declarations, methods) : null
    return knownMethodReturnType(source, node, declarations, methods, receiverType)
  }
  if (node.name === 'UnaryExpression' || node.name === 'UpdateExpression') {
    const child = expressionChildren(node).find((candidate) => EXPRESSION_NODES.has(candidate.name))
    const type = child ? inferJavaExpressionType(source, child, declarations, methods) : null
    return type && /^(?:byte|short|char)$/.test(type) ? 'int' : type
  }
  if (node.name === 'InstanceofExpression') return 'boolean'
  if (node.name === 'BinaryExpression' || node.name === 'AssignmentExpression'
    || node.name === 'TernaryExpression') {
    const expressions = expressionChildren(node).filter((candidate) => EXPRESSION_NODES.has(candidate.name))
    const operators = children(node).filter((candidate) => /Op$/.test(candidate.name))
      .map((candidate) => source.slice(candidate.from, candidate.to))
    if (node.name === 'TernaryExpression') {
      const branches = expressions.slice(-2)
        .map((candidate) => inferJavaExpressionType(source, candidate, declarations, methods))
      return branches[0] && branches[0] === branches[1] ? branches[0] : promotedNumericType(branches)
    }
    if (node.name === 'AssignmentExpression') {
      const left = expressions[0]
      return left ? inferJavaExpressionType(source, left, declarations, methods) : null
    }
    if (operators.some((operator) => ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(operator))) {
      return 'boolean'
    }
    const types = expressions.map((candidate) => inferJavaExpressionType(source, candidate, declarations, methods))
    if (operators.includes('+') && types.some((type) => type === 'String')) return 'String'
    if (operators.some((operator) => ['<<', '>>', '>>>'].includes(operator))) {
      const left = types[0]
      if (!left || !types[1] || !numericType(left) || !numericType(types[1])) return null
      return /^(?:byte|short|char)$/.test(left) ? 'int' : left
    }
    return promotedNumericType(types)
  }
  return null
}

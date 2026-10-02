import {
  children,
  declarationAt,
  descendants,
  directChild,
  invocationNameNode,
  invocationAt,
} from './analysis'
import { expressionType, normalizeType } from './inference'
import type {
  JavaDeclaration,
  JavaIntention,
  JavaInvocationInfo,
  JavaMethodInfo,
} from './types'

function sameType(left: string, right: string): boolean {
  return normalizeType(left).replace(/\s/g, '') === normalizeType(right).replace(/\s/g, '')
}

function matchingParameterPositions(types: readonly string[], method: JavaMethodInfo): number[] {
  if (types.length !== method.parameters.length + 1) return []
  return types.flatMap((_, index) => {
    const remaining = types.filter((_, argumentIndex) => argumentIndex !== index)
    return method.parameters.every((parameter, parameterIndex) => sameType(parameter.type, remaining[parameterIndex]!))
      ? [index] : []
  })
}

/** Add one known argument to a uniquely identifiable local method signature. */
export function addMethodParameterIntention(
  source: string,
  invocation: JavaInvocationInfo,
  methods: readonly JavaMethodInfo[],
  declarations: readonly JavaDeclaration[],
): JavaIntention | null {
  const targets = methods.filter((method) => method.name === invocation.name
    && method.classBody.from === invocation.classBody.from
    && method.classBody.to === invocation.classBody.to)
  if (targets.length !== 1) return null
  const target = targets[0]!
  if (target.parameters.length + 1 !== invocation.arguments.length
    || directChild(target.node, 'TypeParameters')
    || (invocation.method && directChild(invocation.method.node, 'TypeParameters'))) return null

  const callNodes = descendants(invocation.classBody, (node) => node.name === 'MethodInvocation')
    .filter((node) => {
      const name = invocationNameNode(node)
      return name && source.slice(name.from, name.to) === target.name
    })
  const calls: JavaInvocationInfo[] = []
  for (const node of callNodes) {
    const name = invocationNameNode(node)!
    const call = invocationAt(source, invocation.classBody, methods, name.from)
    if (!call || call.node.from !== node.from || call.classBody.from !== target.classBody.from) return null
    calls.push(call)
  }

  // A resolved caller supplies the type and name even when the selected
  // recursive call refers to the parameter that has not been declared yet.
  const orderedCalls = [invocation, ...calls.filter((call) => call.node.from !== invocation.node.from)]
  let candidate: { index: number; parameter: { name: string; type: string } } | null = null
  for (const call of orderedCalls) {
    const types = call.arguments.map((argument) => expressionType(source, argument, declarations, methods, call))
    const positions = matchingParameterPositions(types, target)
    if (positions.length !== 1) continue
    const index = positions[0]!
    const argument = call.arguments[index]!
    if (argument.name !== 'Identifier') continue
    const name = source.slice(argument.from, argument.to)
    const declaration = declarationAt(declarations, name, call.node.from, call.classBody, call.method)
    if (!declaration || declaration.type === 'var') continue
    candidate = { index, parameter: { name, type: normalizeType(declaration.type) } }
    break
  }
  if (!candidate || declarations.some((declaration) => declaration.name === candidate.parameter.name && declaration.method === target)) return null

  const proposedDeclarations: JavaDeclaration[] = [...declarations, {
    ...candidate.parameter,
    declaredAt: target.node.from,
    classBody: target.classBody,
    method: target,
    scopeStart: target.body.from + 1,
    scopeEnd: target.body.to - 1,
  }]
  for (const call of calls) {
    const types = call.arguments.map((argument) => expressionType(source, argument, proposedDeclarations, methods, call))
    const positions = matchingParameterPositions(types, target)
    if (positions.length !== 1 || positions[0] !== candidate.index
      || !sameType(types[candidate.index]!, candidate.parameter.type)) return null
  }
  const references = descendants(invocation.classBody, (node) => node.name === 'MethodReference')
  if (references.some((node) => {
    const name = directChild(node, 'Identifier')
    return name && source.slice(name.from, name.to) === target.name
  })) return null

  const formal = directChild(target.node, 'FormalParameters')
  if (!formal) return null
  const parameterNodes = children(formal).filter((node) => node.name === 'FormalParameter' || node.name === 'SpreadParameter')
  if (parameterNodes.length !== target.parameters.length || parameterNodes.some((node) => node.name === 'SpreadParameter')) return null
  const text = `${candidate.parameter.type} ${candidate.parameter.name}`
  const next = parameterNodes[candidate.index]
  const previous = parameterNodes[candidate.index - 1]
  const from = next?.from ?? previous?.to ?? formal.from + 1
  const insert = next ? `${text}, ` : previous ? `, ${text}` : text
  const selectionFrom = from + (previous && !next ? 2 : 0) + candidate.parameter.type.length + 1
  const parameters = [...target.parameters]
  parameters.splice(candidate.index, 0, candidate.parameter)
  const position = candidate.index + 1
  const suffix = position % 100 >= 11 && position % 100 <= 13
    ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[position % 10] ?? 'th'
  const ordinal = `${position}${suffix}`
  return {
    id: 'add-method-parameter',
    label: `Add '${candidate.parameter.type}' as ${ordinal} parameter to method '${target.name}()'`,
    detail: `${target.returnType} ${target.name}(${parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')})`,
    plan: {
      name: target.name,
      returnType: target.returnType,
      parameters,
      callFrom: invocation.node.from,
      callTo: invocation.node.to,
      source,
      change: { from, to: from, insert },
      selection: { from: selectionFrom, to: selectionFrom + candidate.parameter.name.length },
    },
  }
}

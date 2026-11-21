import { javaLanguage } from '@codemirror/lang-java'
import { addMethodParameterIntention } from './add-parameter'
import {
  children,
  classNameForBody,
  collectDeclarations,
  collectMethods,
  directChild,
  invocationAt,
  leadingIndent,
} from './analysis'
import { expressionName, expressionType, returnTypeFor, safeParameterName } from './inference'
import { indentationUnit, insertionAfterMethod, insertionBeforeClassClose, methodText } from './render'
import type {
  JavaDeclaration,
  JavaIntention,
  JavaInvocationInfo,
  JavaMethodCreationPlan,
  JavaMethodInfo,
  JavaMethodParameter,
} from './types'

function hasSpreadParameter(method: JavaMethodInfo): boolean {
  const formal = directChild(method.node, 'FormalParameters')
  return formal !== null && children(formal).some((child) => child.name === 'SpreadParameter')
}

function planForInvocation(
  source: string,
  invocation: JavaInvocationInfo,
  methods: readonly JavaMethodInfo[],
  declarations: readonly JavaDeclaration[],
): JavaMethodCreationPlan | null {
  const targetBody = invocation.target?.classBody ?? invocation.classBody
  // For a call on another object, a same-named method with a different arity
  // does not satisfy the call, so the action creates an overload. Varargs could
  // match any count. Unqualified calls leave arity fixes to add-parameter.
  const existing = methods.some((method) => method.classBody.from === targetBody.from
    && method.classBody.to === targetBody.to
    && method.name === invocation.name
    && (!invocation.target
      || method.parameters.length === invocation.arguments.length
      || hasSpreadParameter(method)))
  if (existing) return null

  const className = classNameForBody(source, targetBody)
  if (className === invocation.name) return null
  const parameters: JavaMethodParameter[] = []
  const usedNames = new Set<string>()
  for (const argument of invocation.arguments) {
    const type = expressionType(source, argument, declarations, methods, invocation)
    const name = safeParameterName(expressionName(source, argument), usedNames)
    usedNames.add(name)
    parameters.push({ type, name })
  }
  const returnType = returnTypeFor(source, invocation, declarations, methods)
  // A method for the caller's own class goes right after the calling method;
  // one for another class goes at the end of that class.
  const callerMethod = invocation.target ? null : invocation.method
  const unit = indentationUnit(source, targetBody)
  const memberIndent = callerMethod
    ? leadingIndent(source, callerMethod.node.from)
    : `${leadingIndent(source, targetBody.to - 1)}${unit}`
  const modifiers = invocation.target
    ? `public ${invocation.target.static ? 'static ' : ''}`
    : `private ${invocation.method?.static ? 'static ' : ''}`
  const generated = methodText(source, modifiers, returnType, invocation.name, parameters, memberIndent, unit)
  const change = callerMethod
    ? insertionAfterMethod(source, callerMethod, generated.text)
    : insertionBeforeClassClose(source, targetBody, generated.text)
  // insertion helpers may prepend a line break before the generated member;
  // locate the generated text in the actual change before applying its local
  // selection offset.
  const generatedOffset = change.insert.indexOf(generated.text)
  const selectionFrom = change.from + Math.max(0, generatedOffset) + generated.selectionOffset
  return {
    name: invocation.name,
    returnType,
    parameters,
    callFrom: invocation.node.from,
    callTo: invocation.node.to,
    source,
    change,
    selection: { from: selectionFrom, to: selectionFrom + generated.selectionLength },
  }
}

/** Plan a create-method intention for the invocation under, or nearest to, a cursor. */
export function planJavaMethodCreation(source: string, position: number): JavaMethodCreationPlan | null {
  if (!source || position < 0 || position > source.length) return null
  const root = javaLanguage.parser.parse(source).topNode
  const methods = collectMethods(source, root)
  const declarations = collectDeclarations(source, root, methods)
  const invocation = invocationAt(source, root, methods, position, declarations)
  if (!invocation) return null
  return planForInvocation(source, invocation, methods, declarations)
}

/** Return the currently applicable local method action. */
export function javaIntentionsAt(source: string, position: number): JavaIntention[] {
  if (!source || position < 0 || position > source.length) return []
  const root = javaLanguage.parser.parse(source).topNode
  const methods = collectMethods(source, root)
  const declarations = collectDeclarations(source, root, methods)
  const invocation = invocationAt(source, root, methods, position, declarations)
  if (!invocation) return []
  const parameterIntention = addMethodParameterIntention(source, invocation, methods, declarations)
  if (parameterIntention) return [parameterIntention]
  const plan = planForInvocation(source, invocation, methods, declarations)
  if (!plan) return []
  return [{
    id: 'create-method',
    label: `Create method '${plan.name}'`,
    detail: `${plan.returnType} ${plan.name}(${plan.parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')})`,
    plan,
  }]
}

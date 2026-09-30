import { javaLanguage } from '@codemirror/lang-java'
import {
  classNameForBody,
  collectDeclarations,
  collectMethods,
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

function planForInvocation(
  source: string,
  invocation: JavaInvocationInfo,
  methods: readonly JavaMethodInfo[],
  declarations: readonly JavaDeclaration[],
): JavaMethodCreationPlan | null {
  const existing = methods.some((method) => method.classBody.from === invocation.classBody.from
    && method.classBody.to === invocation.classBody.to
    && method.name === invocation.name)
  if (existing) return null

  const className = classNameForBody(source, invocation.classBody)
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
  const memberIndent = invocation.method
    ? leadingIndent(source, invocation.method.node.from)
    : `${leadingIndent(source, invocation.classBody.to - 1)}${indentationUnit(source, invocation.classBody)}`
  const unit = indentationUnit(source, invocation.classBody)
  const generated = methodText(source, invocation.method, returnType, invocation.name, parameters, memberIndent, unit)
  const change = invocation.method
    ? insertionAfterMethod(source, invocation.method, generated.text)
    : insertionBeforeClassClose(source, invocation.classBody, generated.text)
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
  const invocation = invocationAt(source, root, methods, position)
  if (!invocation) return null
  const declarations = collectDeclarations(source, root, methods)
  return planForInvocation(source, invocation, methods, declarations)
}

/** Return the currently applicable actions, with create-method first. */
export function javaIntentionsAt(source: string, position: number): JavaIntention[] {
  const plan = planJavaMethodCreation(source, position)
  if (!plan) return []
  return [{
    id: 'create-method',
    label: `Create method '${plan.name}'`,
    detail: `${plan.returnType} ${plan.name}(${plan.parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')})`,
    plan,
  }]
}

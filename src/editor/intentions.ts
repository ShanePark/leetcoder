import { javaLanguage } from '@codemirror/lang-java'
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  showTooltip,
  type EditorView as EditorViewType,
  type TooltipView,
} from '@codemirror/view'

/** A source edit expressed in the coordinates of the document it was planned from. */
export interface JavaIntentionChange {
  from: number
  to: number
  insert: string
}

/** A method parameter inferred from the call that triggered the intention. */
export interface JavaMethodParameter {
  name: string
  type: string
}

/** The edit and selection produced by the create-method intention. */
export interface JavaMethodCreationPlan {
  name: string
  returnType: string
  parameters: readonly JavaMethodParameter[]
  /** The range of the unresolved invocation in the source snapshot. */
  callFrom: number
  callTo: number
  /** The exact source snapshot this plan was computed from. */
  source: string
  change: JavaIntentionChange
  /** The post-change selection, usually the generated default return value. */
  selection: { from: number; to: number }
}

export interface JavaIntention {
  id: 'create-method'
  label: string
  detail: string
  plan: JavaMethodCreationPlan
}

export interface JavaIntentionsMenuState {
  source: string
  anchor: number
  selectedIndex: number
  intentions: readonly JavaIntention[]
}

type JavaSyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode']

interface JavaMethodInfo {
  node: JavaSyntaxNode
  body: JavaSyntaxNode
  classBody: JavaSyntaxNode
  name: string
  returnType: string
  parameters: readonly JavaMethodParameter[]
  static: boolean
}

interface JavaDeclaration {
  name: string
  type: string
  declaredAt: number
  classBody: JavaSyntaxNode
  method: JavaMethodInfo | null
  scopeStart: number
  scopeEnd: number
}

interface JavaInvocationInfo {
  node: JavaSyntaxNode
  name: string
  nameFrom: number
  nameTo: number
  classBody: JavaSyntaxNode
  method: JavaMethodInfo | null
  arguments: JavaSyntaxNode[]
}

const TYPE_NODES = new Set([
  'AnnotatedType', 'ArrayType', 'GenericType', 'PrimitiveType', 'ScopedTypeName', 'TypeName', 'void', 'var',
])
const PARAMETER_NODES = new Set(['FormalParameter', 'SpreadParameter'])
const LOCAL_DECLARATION_NODES = new Set(['LocalVariableDeclaration', 'FieldDeclaration', 'VariableDeclaration', 'ForSpec'])
const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile',
  'while', 'var', 'true', 'false', 'null', 'yield',
])
const PUNCTUATION_NODES = new Set(['(', ')', ',', '[', ']', '{', '}', '.', ';'])

function children(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child)
  }
  return result
}

function directChild(node: JavaSyntaxNode, name: string): JavaSyntaxNode | null {
  return children(node).find((child) => child.name === name) ?? null
}

function descendants(node: JavaSyntaxNode, predicate?: (candidate: JavaSyntaxNode) => boolean): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  const visit = (current: JavaSyntaxNode): void => {
    if (!predicate || predicate(current)) {
      result.push(current)
    }
    for (let child = current.firstChild; child; child = child.nextSibling) {
      visit(child)
    }
  }
  visit(node)
  return result
}

function nearestAncestor(node: JavaSyntaxNode | null, names: ReadonlySet<string>): JavaSyntaxNode | null {
  let current = node
  while (current) {
    if (names.has(current.name)) {
      return current
    }
    current = current.parent
  }
  return null
}

function lineBreakFor(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

function lineStart(source: string, position: number): number {
  let result = Math.max(0, Math.min(position, source.length))
  while (result > 0 && source[result - 1] !== '\n' && source[result - 1] !== '\r') {
    result -= 1
  }
  return result
}

function leadingIndent(source: string, position: number): string {
  const prefix = source.slice(lineStart(source, position), position)
  return /^[ \t]*/.exec(prefix)?.[0] ?? ''
}

function typeNode(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return children(node).find((child) => TYPE_NODES.has(child.name)) ?? null
}

function typeText(
  source: string,
  node: JavaSyntaxNode,
  definition: JavaSyntaxNode,
  ownerEnd: number,
): string | null {
  const base = typeNode(node)
  if (!base) {
    return null
  }
  let type = source.slice(base.from, base.to).trim()
  const suffix = source.slice(definition.to, ownerEnd).match(/^(?:\s*\[\s*\]\s*)+/)?.[0]
  if (suffix) {
    type += suffix.replace(/\s/g, '')
  }
  return type || null
}

function classNameForBody(source: string, body: JavaSyntaxNode): string | null {
  const parent = body.parent
  if (!parent || parent.name !== 'ClassDeclaration') {
    return null
  }
  const definition = directChild(parent, 'Definition')
  return definition ? source.slice(definition.from, definition.to) : null
}

function methodReturnType(source: string, node: JavaSyntaxNode): string {
  const definition = directChild(node, 'Definition')
  if (!definition) {
    return 'Object'
  }
  const type = children(node).find((child) => child.to <= definition.from && TYPE_NODES.has(child.name))
  return type ? source.slice(type.from, type.to).trim() || 'Object' : 'Object'
}

function methodParameters(source: string, node: JavaSyntaxNode): JavaMethodParameter[] {
  const formalParameters = directChild(node, 'FormalParameters')
  if (!formalParameters) {
    return []
  }
  const result: JavaMethodParameter[] = []
  for (const parameter of children(formalParameters).filter((child) => PARAMETER_NODES.has(child.name))) {
    const definition = directChild(parameter, 'Definition')
    if (!definition) {
      continue
    }
    const type = typeText(source, parameter, definition, parameter.to)
    if (type) {
      result.push({ name: source.slice(definition.from, definition.to), type })
    }
  }
  return result
}

function methodInfo(source: string, node: JavaSyntaxNode): JavaMethodInfo | null {
  const body = directChild(node, 'Block')
  const definition = directChild(node, 'Definition')
  const classBody = node.parent?.name === 'ClassBody'
    ? node.parent
    : nearestAncestor(node.parent, new Set(['ClassBody']))
  if (!body || !definition || !classBody) {
    return null
  }
  const methodName = source.slice(definition.from, definition.to)
  const prefix = source.slice(node.from, definition.from)
  return {
    node,
    body,
    classBody,
    name: methodName,
    returnType: methodReturnType(source, node),
    parameters: methodParameters(source, node),
    static: /\bstatic\b/.test(prefix),
  }
}

function collectMethods(source: string, root: JavaSyntaxNode): JavaMethodInfo[] {
  return descendants(root, (node) => node.name === 'MethodDeclaration')
    .map((node) => methodInfo(source, node))
    .filter((method): method is JavaMethodInfo => Boolean(method))
}

function methodFor(node: JavaSyntaxNode, methods: readonly JavaMethodInfo[]): JavaMethodInfo | null {
  return methods
    .filter((method) => method.body.from < node.from && node.to < method.body.to)
    .sort((left, right) => (left.body.to - left.body.from) - (right.body.to - right.body.from))[0] ?? null
}

function classBodyFor(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return nearestAncestor(node, new Set(['ClassBody']))
}

function declarationType(
  source: string,
  declaration: JavaSyntaxNode,
  variable: JavaSyntaxNode | null = null,
): string | null {
  // Java's local and field declarations put the name inside a
  // VariableDeclarator, while method parameters put it directly in the
  // parameter node. Use the declarator that owns the invocation so an array
  // suffix (`value[]`) is preserved without assuming a direct Definition.
  const owner = variable ?? children(declaration).find((child) => child.name === 'VariableDeclarator') ?? declaration
  const definition = directChild(owner, 'Definition')
  if (!definition) {
    return null
  }
  return typeText(source, declaration, definition, owner.to)
}

function collectDeclarations(
  source: string,
  root: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
): JavaDeclaration[] {
  const result: JavaDeclaration[] = []
  for (const method of methods) {
    for (const parameter of children(directChild(method.node, 'FormalParameters') ?? method.node)
      .filter((child) => PARAMETER_NODES.has(child.name))) {
      const definition = directChild(parameter, 'Definition')
      const type = definition ? typeText(source, parameter, definition, parameter.to) : null
      if (definition && type) {
        result.push({
          name: source.slice(definition.from, definition.to),
          type,
          declaredAt: definition.from,
          classBody: method.classBody,
          method,
          scopeStart: method.body.from + 1,
          scopeEnd: Math.max(method.body.from + 1, method.body.to - 1),
        })
      }
    }
  }

  for (const variable of descendants(root, (node) => node.name === 'VariableDeclarator')) {
    const definition = directChild(variable, 'Definition')
    if (!definition) {
      continue
    }
    const declaration = nearestAncestor(variable.parent, LOCAL_DECLARATION_NODES)
    const classBody = classBodyFor(variable)
    if (!declaration || !classBody) {
      continue
    }
    const type = declarationType(source, declaration, variable)
    if (!type) {
      continue
    }
    const method = methodFor(variable, methods)
    const isField = declaration.name === 'FieldDeclaration'
    const block = !isField ? nearestAncestor(variable.parent, new Set(['Block'])) : null
    result.push({
      name: source.slice(definition.from, definition.to),
      type,
      declaredAt: definition.from,
      classBody,
      method,
      scopeStart: isField ? classBody.from + 1 : (block?.from ?? method?.body.from ?? classBody.from) + 1,
      scopeEnd: isField ? Math.max(classBody.from + 1, classBody.to - 1) : Math.max(
        (block?.from ?? method?.body.from ?? classBody.from) + 1,
        (block?.to ?? method?.body.to ?? classBody.to) - 1,
      ),
    })
  }
  return result
}

function sameMethod(left: JavaMethodInfo | null, right: JavaMethodInfo | null): boolean {
  return left !== null && right !== null && left.body.from === right.body.from && left.body.to === right.body.to
}

function declarationAt(
  declarations: readonly JavaDeclaration[],
  name: string,
  position: number,
  classBody: JavaSyntaxNode,
  method: JavaMethodInfo | null,
): JavaDeclaration | null {
  return declarations
    .filter((candidate) => candidate.name === name
      && candidate.classBody.from === classBody.from
      && candidate.classBody.to === classBody.to
      && candidate.scopeStart <= position
      && position <= candidate.scopeEnd
      && (candidate.method === null || sameMethod(candidate.method, method))
      && (candidate.method === null || candidate.declaredAt < position))
    .sort((left, right) => right.declaredAt - left.declaredAt)[0] ?? null
}

function invocationNameNode(node: JavaSyntaxNode): JavaSyntaxNode | null {
  const methodName = directChild(node, 'MethodName')
  return methodName ? directChild(methodName, 'Identifier') ?? methodName : null
}

function argumentNodes(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const argumentsNode = directChild(node, 'ArgumentList')
  if (!argumentsNode) {
    return []
  }
  return children(argumentsNode).filter((child) => !PUNCTUATION_NODES.has(child.name))
}

function eligibleReceiver(node: JavaSyntaxNode): boolean {
  const methodName = directChild(node, 'MethodName')
  if (!methodName) {
    return false
  }
  const nodeChildren = children(node)
  const nameIndex = nodeChildren.findIndex((child) => child.from === methodName.from && child.to === methodName.to)
  const meaningful = nodeChildren.slice(0, nameIndex).filter((child) => (
    child.name !== '.' && child.name !== 'TypeArguments'
  ))
  return meaningful.length === 0 || (meaningful.length === 1 && meaningful[0]?.name === 'this')
}

function previousWord(source: string, position: number): string | null {
  let cursor = position - 1
  while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor] ?? '')) cursor -= 1
  const word = source.slice(cursor + 1, end)
  return word || null
}

function invocationInfo(
  source: string,
  node: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
): JavaInvocationInfo | null {
  const nameNode = invocationNameNode(node)
  const classBody = classBodyFor(node)
  if (!nameNode || !classBody || !eligibleReceiver(node) || node.type.isError) {
    return null
  }
  if (previousWord(source, nameNode.from) === 'new') {
    return null
  }
  const name = source.slice(nameNode.from, nameNode.to)
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || JAVA_KEYWORDS.has(name)) {
    return null
  }
  return {
    node,
    name,
    nameFrom: nameNode.from,
    nameTo: nameNode.to,
    classBody,
    method: methodFor(node, methods),
    arguments: argumentNodes(node),
  }
}

function sourceLineEnd(source: string, position: number): number {
  let result = Math.max(0, Math.min(position, source.length))
  while (result < source.length && source[result] !== '\n' && source[result] !== '\r') result += 1
  return result
}

function invocationAt(
  source: string,
  root: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
  position: number,
): JavaInvocationInfo | null {
  const invocations = descendants(root, (node) => node.name === 'MethodInvocation')
    .map((node) => invocationInfo(source, node, methods))
    .filter((invocation): invocation is JavaInvocationInfo => Boolean(invocation))
  const exact = invocations
    .filter((invocation) => invocation.nameFrom <= position && position <= invocation.nameTo)
    .sort((left, right) => (left.nameTo - left.nameFrom) - (right.nameTo - right.nameFrom))[0]
  if (exact) {
    return exact
  }

  // Alt/Cmd+Enter is commonly pressed with the caret at the start of the
  // diagnostic line. Prefer the nearest call on that line in that case.
  const from = lineStart(source, position)
  const to = sourceLineEnd(source, position)
  return invocations
    .filter((invocation) => invocation.nameFrom >= from && invocation.nameTo <= to)
    .sort((left, right) => {
      const leftDistance = position < left.nameFrom
        ? left.nameFrom - position
        : Math.max(0, position - left.nameTo)
      const rightDistance = position < right.nameFrom
        ? right.nameFrom - position
        : Math.max(0, position - right.nameTo)
      return leftDistance - rightDistance || left.nameFrom - right.nameFrom
    })[0] ?? null
}

function simpleTypeName(type: string): string {
  const withoutGenerics = type.replace(/<.*>/gs, '')
  return withoutGenerics.replace(/\[\]/g, '').split('.').at(-1) ?? withoutGenerics
}

function normalizeType(type: string): string {
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

function expressionType(
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

function expressionName(source: string, node: JavaSyntaxNode): string {
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

function safeParameterName(base: string, used: ReadonlySet<string>): string {
  const normalized = /^[A-Za-z_$][\w$]*$/.test(base) && !JAVA_KEYWORDS.has(base) ? base : 'value'
  if (!used.has(normalized)) return normalized
  let suffix = 2
  while (used.has(`${normalized}${suffix}`)) suffix += 1
  return `${normalized}${suffix}`
}

function returnTypeFor(
  source: string,
  invocation: JavaInvocationInfo,
  declarations: readonly JavaDeclaration[],
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
  return 'Object'
}

function defaultReturnValue(returnType: string): string | null {
  const normalized = normalizeType(returnType)
  if (normalized === 'void') return null
  if (normalized === 'boolean') return 'false'
  if (normalized === 'char') return "'\\0'"
  if (normalized === 'byte' || normalized === 'short' || normalized === 'int') return '0'
  if (normalized === 'long') return '0L'
  if (normalized === 'float') return '0.0f'
  if (normalized === 'double') return '0.0'
  return 'null'
}

function indentationUnit(source: string, classBody: JavaSyntaxNode, fallback = '    '): string {
  const classIndent = leadingIndent(source, classBody.to - 1)
  const members = children(classBody).filter((child) => !PUNCTUATION_NODES.has(child.name))
  for (const member of members) {
    const indent = leadingIndent(source, member.from)
    if (indent.length > classIndent.length) return indent.slice(classIndent.length) || fallback
  }
  return fallback
}

function methodText(
  source: string,
  method: JavaInvocationInfo['method'],
  returnType: string,
  name: string,
  parameters: readonly JavaMethodParameter[],
  memberIndent: string,
  unit: string,
): { text: string; selectionOffset: number; selectionLength: number } {
  const lineBreak = lineBreakFor(source)
  const bodyIndent = memberIndent + unit
  const staticPrefix = method?.static ? 'static ' : ''
  const signature = `private ${staticPrefix}${returnType} ${name}(${parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')})`
  const defaultValue = defaultReturnValue(returnType)
  if (defaultValue === null) {
    const text = `${memberIndent}${signature} {${lineBreak}${memberIndent}}`
    return { text, selectionOffset: text.length - 1, selectionLength: 0 }
  }
  const text = `${memberIndent}${signature} {${lineBreak}${bodyIndent}return ${defaultValue};${lineBreak}${memberIndent}}`
  const selectionOffset = text.indexOf(defaultValue, text.indexOf('return '))
  return { text, selectionOffset, selectionLength: defaultValue.length }
}

function insertionAfterMethod(
  source: string,
  method: JavaMethodInfo,
  generated: string,
): JavaIntentionChange {
  const lineBreak = lineBreakFor(source)
  const from = method.body.to
  const following = source.slice(from)
  const existingLineBreak = /^[ \t]*(?:\r\n|\r|\n)/.exec(following)
  if (existingLineBreak) {
    return {
      from,
      to: from + existingLineBreak[0].length,
      insert: `${lineBreak}${lineBreak}${generated}${lineBreak}`,
    }
  }
  return {
    from,
    to: from,
    insert: `${lineBreak}${lineBreak}${generated}${lineBreak}`,
  }
}

function insertionBeforeClassClose(
  source: string,
  classBody: JavaSyntaxNode,
  generated: string,
): JavaIntentionChange {
  const lineBreak = lineBreakFor(source)
  const close = classBody.to - 1
  const closeLineStart = lineStart(source, close)
  const closePrefix = source.slice(closeLineStart, close)
  const classIndent = /^[ \t]*/.exec(closePrefix)?.[0] ?? ''
  if (closePrefix.trim().length === 0) {
    return {
      from: closeLineStart,
      to: close,
      insert: `${generated}${lineBreak}${classIndent}`,
    }
  }
  return {
    from: close,
    to: close,
    insert: `${lineBreak}${generated}${lineBreak}${classIndent}`,
  }
}

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
  const returnType = returnTypeFor(source, invocation, declarations)
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

/** Apply a planned create-method edit if its source snapshot is still current. */
export function applyJavaMethodCreation(view: EditorViewType, plan: JavaMethodCreationPlan): boolean {
  if (view.state.doc.toString() !== plan.source || view.state.readOnly) {
    view.dispatch({ effects: closeJavaIntentions.of(null) })
    return true
  }
  view.dispatch({
    changes: plan.change,
    selection: { anchor: plan.selection.from, head: plan.selection.to },
    scrollIntoView: true,
    userEvent: 'input.createMethod',
  })
  return true
}

export const setJavaIntentions = StateEffect.define<JavaIntentionsMenuState>()
export const closeJavaIntentions = StateEffect.define<null>()

function tooltipForMenu(menu: JavaIntentionsMenuState): { pos: number; above: boolean; arrow: boolean; create: (view: EditorView) => TooltipView } {
  return {
    pos: menu.anchor,
    above: false,
    arrow: true,
    create: (view) => new JavaIntentionsTooltip(view, menu),
  }
}

/** State backing the editor-only CodeMirror intentions tooltip. */
export const javaIntentionsState = StateField.define<JavaIntentionsMenuState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(closeJavaIntentions)) return null
      if (effect.is(setJavaIntentions)) return effect.value
    }
    if (value && (transaction.docChanged || transaction.selection !== undefined)) {
      return null
    }
    return value
  },
  provide: (field) => showTooltip.from(field, (value) => value ? tooltipForMenu(value) : null),
})

class JavaIntentionsTooltip implements TooltipView {
  readonly dom: HTMLElement

  constructor(private readonly view: EditorView, menu: JavaIntentionsMenuState) {
    const element = document.createElement('div')
    element.className = 'cm-intention-menu'
    element.setAttribute('role', 'menu')
    element.setAttribute('aria-label', 'Code actions')
    for (const [index, intention] of menu.intentions.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-intention-item'
      button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-selected', String(index === menu.selectedIndex))
      if (index === menu.selectedIndex) button.classList.add('is-selected')
      const label = document.createElement('span')
      label.className = 'cm-intention-label'
      label.textContent = intention.label
      const detail = document.createElement('span')
      detail.className = 'cm-intention-detail'
      detail.textContent = intention.detail
      button.append(label, detail)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        applyJavaMethodCreation(this.view, intention.plan)
        this.view.focus()
      })
      element.append(button)
    }
    this.dom = element
  }
}

const javaIntentionsTheme = EditorView.baseTheme({
  '.cm-intention-menu': {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '280px',
    padding: '4px',
    gap: '2px',
  },
  '.cm-intention-item': {
    display: 'flex',
    alignItems: 'baseline',
    width: '100%',
    padding: '6px 8px',
    border: '0',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '13px',
    textAlign: 'left',
  },
  '.cm-intention-item:hover, .cm-intention-item.is-selected': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-intention-label': {
    fontWeight: '600',
  },
  '.cm-intention-detail': {
    marginLeft: '16px',
    color: 'var(--text-dim)',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  },
})

/** Open the intentions menu at the current cursor, if a safe action exists. */
export function showJavaIntentions(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || !selection.empty) return false
  const source = view.state.doc.toString()
  const intentions = javaIntentionsAt(source, selection.head)
  if (intentions.length === 0) return false
  view.dispatch({
    effects: setJavaIntentions.of({
      source,
      anchor: intentions[0]!.plan.callFrom,
      selectedIndex: 0,
      intentions,
    }),
  })
  return true
}

/** Apply the preselected action when Enter is pressed while the menu is open. */
export function applySelectedJavaIntention(view: EditorView): boolean {
  const menu = view.state.field(javaIntentionsState, false)
  if (!menu || menu.intentions.length === 0) return false
  const selected = menu.intentions[Math.max(0, Math.min(menu.selectedIndex, menu.intentions.length - 1))]
  return selected ? applyJavaMethodCreation(view, selected.plan) : false
}

/** Dismiss an open intentions menu without changing the document. */
export function dismissJavaIntentions(view: EditorView): boolean {
  if (!view.state.field(javaIntentionsState, false)) return false
  view.dispatch({ effects: closeJavaIntentions.of(null) })
  return true
}

/** CodeMirror wiring for the menu's Enter and Escape behavior. */
export const javaIntentionsExtension: Extension = [
  javaIntentionsState,
  javaIntentionsTheme,
  Prec.highest(keymap.of([
    { key: 'Enter', run: applySelectedJavaIntention },
    { key: 'Escape', run: dismissJavaIntentions },
  ])),
]

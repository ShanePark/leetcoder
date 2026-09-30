import type {
  JavaDeclaration,
  JavaInvocationInfo,
  JavaMethodInfo,
  JavaMethodParameter,
  JavaSyntaxNode,
} from './types'

export const TYPE_NODES = new Set([
  'AnnotatedType', 'ArrayType', 'GenericType', 'PrimitiveType', 'ScopedTypeName', 'TypeName', 'void', 'var',
])
const PARAMETER_NODES = new Set(['FormalParameter', 'SpreadParameter'])
export const LOCAL_DECLARATION_NODES = new Set(['LocalVariableDeclaration', 'FieldDeclaration', 'VariableDeclaration', 'ForSpec'])
export const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile',
  'while', 'var', 'true', 'false', 'null', 'yield',
])
export const PUNCTUATION_NODES = new Set(['(', ')', ',', '[', ']', '{', '}', '.', ';'])

export function children(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child)
  }
  return result
}

export function directChild(node: JavaSyntaxNode, name: string): JavaSyntaxNode | null {
  return children(node).find((child) => child.name === name) ?? null
}

export function descendants(node: JavaSyntaxNode, predicate?: (candidate: JavaSyntaxNode) => boolean): JavaSyntaxNode[] {
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

export function nearestAncestor(node: JavaSyntaxNode | null, names: ReadonlySet<string>): JavaSyntaxNode | null {
  let current = node
  while (current) {
    if (names.has(current.name)) {
      return current
    }
    current = current.parent
  }
  return null
}

export function lineBreakFor(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

export function lineStart(source: string, position: number): number {
  let result = Math.max(0, Math.min(position, source.length))
  while (result > 0 && source[result - 1] !== '\n' && source[result - 1] !== '\r') {
    result -= 1
  }
  return result
}

export function leadingIndent(source: string, position: number): string {
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

export function classNameForBody(source: string, body: JavaSyntaxNode): string | null {
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

export function collectMethods(source: string, root: JavaSyntaxNode): JavaMethodInfo[] {
  return descendants(root, (node) => node.name === 'MethodDeclaration')
    .map((node) => methodInfo(source, node))
    .filter((method): method is JavaMethodInfo => Boolean(method))
}

function methodFor(node: JavaSyntaxNode, methods: readonly JavaMethodInfo[]): JavaMethodInfo | null {
  return methods
    .filter((method) => method.body.from < node.from && node.to < method.body.to)
    .sort((left, right) => (left.body.to - left.body.from) - (right.body.to - right.body.from))[0] ?? null
}

export function classBodyFor(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return nearestAncestor(node, new Set(['ClassBody']))
}

export function declarationType(
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

export function collectDeclarations(
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

export function declarationAt(
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

export function invocationNameNode(node: JavaSyntaxNode): JavaSyntaxNode | null {
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

export function invocationAt(
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

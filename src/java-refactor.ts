import { javaLanguage } from '@codemirror/lang-java'

import { maskJavaCommentsAndLiterals } from './completions'

/** A source edit expressed in the coordinates of the input document. */
export interface JavaRefactorChange {
  from: number
  to: number
  insert: string
}

export interface JavaMethodNameRange {
  from: number
  to: number
}

export interface JavaMethodExtractionPlan {
  changes: JavaRefactorChange[]
  name: string
  /** Newly introduced call and declaration name ranges in post-change coordinates. */
  nameRanges: JavaMethodNameRange[]
}

export interface JavaMethodExtractionFailure {
  reason: string
}

export type JavaMethodExtractionResult = JavaMethodExtractionPlan | JavaMethodExtractionFailure

type JavaSyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode']

interface JavaMethodInfo {
  node: JavaSyntaxNode
  name: string
  returnType: string | null
  static: boolean
  body: JavaSyntaxNode
  classBody: JavaSyntaxNode
  throwsClause: string
}

interface JavaDeclaration {
  name: string
  type: string
  declaredAt: number
  definitionFrom: number
  definitionTo: number
  kind: 'field' | 'parameter' | 'local'
  scopeStart: number
  scopeEnd: number
  static: boolean
  initialized: boolean
}

interface JavaSelection {
  from: number
  to: number
  method: JavaMethodInfo
  expression: JavaSyntaxNode | null
  statements: JavaSyntaxNode[]
}

interface JavaOutput {
  declaration: JavaDeclaration | null
  existing: JavaDeclaration | null
}

const JAVA_KEYWORDS = new Set([
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

const TYPE_NODES = new Set([
  'AnnotatedType', 'ArrayType', 'GenericType', 'PrimitiveType', 'ScopedTypeName', 'TypeName', 'void', 'var',
])

const EXPRESSION_NODES = new Set([
  'ArrayAccess', 'ArrayCreationExpression', 'ArrayInitializer', 'AssignmentExpression', 'BinaryExpression',
  'BooleanLiteral', 'CastExpression', 'CharacterLiteral', 'ClassLiteral', 'FloatingPointLiteral',
  'Identifier', 'InstanceofExpression', 'LambdaExpression', 'MethodInvocation', 'MethodReference', 'null',
  'ObjectCreationExpression', 'ParenthesizedExpression', 'StringLiteral', 'TextBlock', 'TernaryExpression',
  'UnaryExpression', 'UpdateExpression', 'IntegerLiteral',
])

const STATEMENT_NODES = new Set([
  'AssertStatement', 'Block', 'BreakStatement', 'ContinueStatement', 'DoStatement', 'EmptyStatement',
  'ExpressionStatement', 'ForStatement', 'IfStatement', 'LabeledStatement', 'LocalVariableDeclaration',
  'ReturnStatement', 'SwitchStatement', 'SynchronizedStatement', 'ThrowStatement', 'TryStatement',
  'WhileStatement', 'YieldStatement',
])

const CLASS_MEMBER_TYPE = new Set(['ClassBody'])
const PARAMETER_NODES = new Set(['FormalParameter', 'SpreadParameter'])
const LOCAL_NODES = new Set(['LocalVariableDeclaration', 'Resource'])
const LOOP_NODES = new Set(['ForStatement', 'EnhancedForStatement'])
const BLOCK_NODES = new Set(['Block'])
const DEFINITION_NODE = new Set(['Definition'])

function children(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}

function descendants(node: JavaSyntaxNode, predicate?: (candidate: JavaSyntaxNode) => boolean): JavaSyntaxNode[] {
  const result: JavaSyntaxNode[] = []
  const visit = (current: JavaSyntaxNode): void => {
    if (!predicate || predicate(current)) result.push(current)
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(node)
  return result
}

function firstChildNamed(node: JavaSyntaxNode, names: ReadonlySet<string>): JavaSyntaxNode | null {
  return children(node).find((child) => names.has(child.name)) ?? null
}

function nearestAncestor(node: JavaSyntaxNode | null, names: ReadonlySet<string>): JavaSyntaxNode | null {
  let current = node
  while (current) {
    if (names.has(current.name)) return current
    current = current.parent
  }
  return null
}

function lineBreakOf(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

function lineStart(source: string, position: number): number {
  let result = Math.max(0, Math.min(position, source.length))
  while (result > 0 && source[result - 1] !== '\n' && source[result - 1] !== '\r') result -= 1
  return result
}

function leadingIndent(source: string, position: number): string {
  const prefix = source.slice(lineStart(source, position), position)
  return /^[ \t]*/.exec(prefix)?.[0] ?? ''
}

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

function typeTextForDeclaration(
  source: string,
  typeNode: JavaSyntaxNode,
  definition: JavaSyntaxNode,
  ownerEnd: number,
): string {
  let type = source.slice(typeNode.from, typeNode.to).trim()
  const suffix = source.slice(definition.to, ownerEnd).match(/^(?:\s*\[\s*\]\s*)+/)?.[0]
  if (suffix) type += suffix.replace(/\s/g, '')
  return type
}

function declarationTypeInfo(
  source: string,
  node: JavaSyntaxNode,
): { kind: JavaDeclaration['kind']; typeNode: JavaSyntaxNode; owner: JavaSyntaxNode } | null {
  const parameter = nearestAncestor(node, PARAMETER_NODES)
  if (parameter) {
    const typeNode = firstChildNamed(parameter, TYPE_NODES)
    return typeNode ? { kind: 'parameter', typeNode, owner: parameter } : null
  }
  const field = nearestAncestor(node, new Set(['FieldDeclaration']))
  if (field) {
    const typeNode = firstChildNamed(field, TYPE_NODES)
    return typeNode ? { kind: 'field', typeNode, owner: field } : null
  }
  const local = nearestAncestor(node, LOCAL_NODES)
  if (local) {
    const typeNode = firstChildNamed(local, TYPE_NODES)
    return typeNode ? { kind: 'local', typeNode, owner: local } : null
  }
  void source
  return null
}

function declarationScope(
  node: JavaSyntaxNode,
  method: JavaMethodInfo,
  kind: JavaDeclaration['kind'],
): { start: number; end: number } {
  if (kind === 'field') {
    return { start: method.classBody.from + 1, end: Math.max(method.classBody.from + 1, method.classBody.to - 1) }
  }
  if (kind === 'parameter') return { start: method.body.from + 1, end: method.body.to - 1 }
  const loop = nearestAncestor(node, LOOP_NODES)
  if (loop) return { start: loop.from, end: loop.to }
  const block = nearestAncestor(node, BLOCK_NODES)
  if (block) return { start: block.from + 1, end: block.to - 1 }
  return { start: method.body.from + 1, end: method.body.to - 1 }
}

function methodReturnType(source: string, method: JavaSyntaxNode): string | null {
  const definition = firstChildNamed(method, DEFINITION_NODE)
  if (!definition) return null
  const type = children(method).find((child) => child.to <= definition.from && TYPE_NODES.has(child.name))
  return type ? source.slice(type.from, type.to).trim() : null
}

function methodInfo(source: string, node: JavaSyntaxNode): JavaMethodInfo | null {
  const body = node.getChild('Block')
  const definition = firstChildNamed(node, DEFINITION_NODE)
  const classBody = nearestAncestor(node.parent, CLASS_MEMBER_TYPE)
  if (!body || !definition || !classBody) return null
  const prefix = source.slice(node.from, definition.from)
  return {
    node,
    name: source.slice(definition.from, definition.to),
    returnType: methodReturnType(source, node),
    static: /\bstatic\b/.test(prefix),
    body,
    classBody,
    throwsClause: methodThrowsClause(source, node),
  }
}

function methodThrowsClause(source: string, method: JavaSyntaxNode): string {
  const parameters = method.getChild('FormalParameters')
  const body = method.getChild('Block')
  if (!parameters || !body) return ''
  const between = source.slice(parameters.to, body.from).trim()
  return /^throws\b/.test(between) ? between : ''
}

function collectMethods(source: string, tree: JavaSyntaxNode): JavaMethodInfo[] {
  return descendants(tree, (node) => node.name === 'MethodDeclaration')
    .map((node) => methodInfo(source, node))
    .filter((method): method is JavaMethodInfo => Boolean(method))
}

function containingMethod(methods: readonly JavaMethodInfo[], from: number, to: number): JavaMethodInfo | null {
  return methods
    .filter((method) => method.body.from < from && to < method.body.to)
    .sort((left, right) => (left.body.to - left.body.from) - (right.body.to - right.body.from))[0] ?? null
}

function collectDeclarations(
  source: string,
  tree: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
): JavaDeclaration[] {
  const result: JavaDeclaration[] = []
  for (const variable of descendants(tree, (node) => node.name === 'VariableDeclarator')) {
    const definition = firstChildNamed(variable, DEFINITION_NODE)
    const details = definition ? declarationTypeInfo(source, variable) : null
    if (!definition || !details) continue
    const method = methods
      .filter((candidate) => candidate.node.from < variable.from && variable.to < candidate.node.to)
      .sort((left, right) => left.node.to - left.node.from - (right.node.to - right.node.from))[0]
    if (!method && details.kind !== 'field') continue
    const context = method ?? methods[0]
    if (!context) continue
    const scope = declarationScope(variable, context, details.kind)
    const modifiers = details.kind === 'field' ? details.owner.getChild('Modifiers') : null
    result.push({
      name: source.slice(definition.from, definition.to),
      type: typeTextForDeclaration(source, details.typeNode, definition, variable.to),
      declaredAt: definition.from,
      definitionFrom: definition.from,
      definitionTo: definition.to,
      kind: details.kind,
      scopeStart: scope.start,
      scopeEnd: scope.end,
      static: Boolean(modifiers && /\bstatic\b/.test(source.slice(modifiers.from, modifiers.to))),
      initialized: children(variable).some((child) => child.name === 'AssignOp'),
    })
  }
  for (const parameter of descendants(tree, (node) => PARAMETER_NODES.has(node.name))) {
    const definition = firstChildNamed(parameter, DEFINITION_NODE)
    const typeNode = firstChildNamed(parameter, TYPE_NODES)
    if (!definition || !typeNode) continue
    const method = methods
      .filter((candidate) => candidate.node.from < parameter.from && parameter.to < candidate.node.to)
      .sort((left, right) => left.node.to - left.node.from - (right.node.to - right.node.from))[0]
    if (!method) continue
    const scope = declarationScope(parameter, method, 'parameter')
    const rawType = typeTextForDeclaration(source, typeNode, definition, parameter.to)
    result.push({
      name: source.slice(definition.from, definition.to),
      type: parameter.name === 'SpreadParameter' ? rawType + '...' : rawType,
      declaredAt: definition.from,
      definitionFrom: definition.from,
      definitionTo: definition.to,
      kind: 'parameter',
      scopeStart: scope.start,
      scopeEnd: scope.end,
      static: false,
      initialized: true,
    })
  }
  // Enhanced-for variables are represented by a Definition directly in their
  // ForSpec, rather than by VariableDeclarator.
  for (const loop of descendants(tree, (node) => node.name === 'EnhancedForStatement')) {
    const spec = loop.getChild('ForSpec')
    const definition = spec ? firstChildNamed(spec, DEFINITION_NODE) : null
    const typeNode = spec ? firstChildNamed(spec, TYPE_NODES) : null
    const method = methods
      .filter((candidate) => candidate.node.from < loop.from && loop.to < candidate.node.to)
      .sort((left, right) => left.node.to - left.node.from - (right.node.to - right.node.from))[0]
    if (!spec || !definition || !typeNode || !method) continue
    result.push({
      name: source.slice(definition.from, definition.to),
      type: source.slice(typeNode.from, typeNode.to).trim(),
      declaredAt: definition.from,
      definitionFrom: definition.from,
      definitionTo: definition.to,
      kind: 'local',
      scopeStart: loop.from,
      scopeEnd: loop.to,
      static: false,
      initialized: true,
    })
  }
  return result
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

function selectJavaSource(
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

function declarationAt(
  declarations: readonly JavaDeclaration[],
  name: string,
  position: number,
): JavaDeclaration | null {
  return declarations
    .filter((candidate) => candidate.name === name
      && candidate.declaredAt < position
      && candidate.scopeStart <= position
      && position <= candidate.scopeEnd)
    .sort((left, right) => right.declaredAt - left.declaredAt)[0] ?? null
}

function identifierOccurrences(
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

function isIdentifier(value: string): boolean {
  return /^[$A-Za-z_][$\w]*$/.test(value)
}

function freeJavaDeclarations(
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

function expressionChildren(node: JavaSyntaxNode): JavaSyntaxNode[] {
  return children(node).filter((child) => !['(', ')', '[', ']', '{', '}', ',', ';', '.'].includes(child.name))
}

function methodInvocationName(source: string, node: JavaSyntaxNode): string | null {
  const methodName = descendants(node, (candidate) => candidate.name === 'MethodName')[0]
  if (methodName) return source.slice(methodName.from, methodName.to)
  const match = /(?:^|\.)\s*([$A-Za-z_][$\w]*)\s*\(/.exec(source.slice(node.from, node.to))
  return match?.[1] ?? null
}

function methodInvocationReceiverText(source: string, node: JavaSyntaxNode): string {
  const methodName = descendants(node, (candidate) => candidate.name === 'MethodName')[0]
  if (!methodName) return ''
  return source.slice(node.from, methodName.from).trim().replace(/\.$/, '').trim()
}

function knownMethodReturnType(
  source: string,
  node: JavaSyntaxNode,
  methods: readonly JavaMethodInfo[],
  receiverType: string | null,
): string | null {
  const name = methodInvocationName(source, node)
  if (!name) return null
  const declared = [...new Set(methods
    .filter((method) => method.name === name)
    .map((method) => method.returnType)
    .filter((type): type is string => Boolean(type)))]
  if (declared.length === 1 && methodInvocationReceiverText(source, node) === '') return declared[0]
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

function inferJavaExpressionType(
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
    return knownMethodReturnType(source, node, methods, receiverType)
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

function assignmentTargets(source: string, nodes: readonly JavaSyntaxNode[]): Set<string> {
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

function outputForStatements(
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

function rejectControlFlow(nodes: readonly JavaSyntaxNode[]): JavaMethodExtractionFailure | null {
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

function checkedCallInSelection(
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

function uniqueMethodName(
  source: string,
  classBody: JavaSyntaxNode,
  requested: string | undefined,
): string {
  const base = requested && isIdentifier(requested) && !JAVA_KEYWORDS.has(requested)
    ? requested
    : 'extractedMethod'
  const used = new Set(identifierOccurrences(source, classBody.from, classBody.to)
    .map((occurrence) => occurrence.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(base + suffix)) suffix += 1
  return base + suffix
}

function indentExtractedBody(
  text: string,
  helperIndent: string,
  newline: string,
  originalIndent: string,
): string {
  const lines = text.split(/\r\n|\r|\n/)
  return lines.map((line, index) => {
    if (index === 0) return helperIndent + line
    let relative = line
    if (originalIndent && relative.startsWith(originalIndent)) {
      relative = relative.slice(originalIndent.length)
    }
    return helperIndent + relative
  }).join(newline)
}

function applyChanges(source: string, changes: readonly JavaRefactorChange[]): string {
  return [...changes]
    .sort((left, right) => right.from - left.from)
    .reduce((result, change) => (
      result.slice(0, change.from) + change.insert + result.slice(change.to)
    ), source)
}

function nameRangesAfterChanges(
  replacement: JavaRefactorChange,
  insertion: JavaRefactorChange,
  name: string,
): JavaMethodNameRange[] {
  const replacementDelta = replacement.insert.length - (replacement.to - replacement.from)
  const callOffset = replacement.insert.indexOf(name)
  const declarationOffset = insertion.insert.indexOf(name)
  if (callOffset < 0 || declarationOffset < 0) return []
  return [
    { from: replacement.from + callOffset, to: replacement.from + callOffset + name.length },
    {
      from: insertion.from + (replacement.from < insertion.from ? replacementDelta : 0) + declarationOffset,
      to: insertion.from + (replacement.from < insertion.from ? replacementDelta : 0)
        + declarationOffset + name.length,
    },
  ]
}

function helperInsertion(
  source: string,
  method: JavaMethodInfo,
  returnType: string,
  name: string,
  parameters: readonly JavaDeclaration[],
  bodyText: string,
): { from: number; insert: string } {
  const newline = lineBreakOf(source)
  const methodIndent = leadingIndent(source, method.node.from)
  const helperIndent = methodIndent + '    '
  const parameterText = parameters
    .map((parameter) => parameter.type + ' ' + parameter.name)
    .join(', ')
  const staticText = method.static ? 'static ' : ''
  const throwsText = method.throwsClause ? ' ' + method.throwsClause : ''
  const helper = [
    methodIndent + 'private ' + staticText + returnType + ' ' + name
      + '(' + parameterText + ')' + throwsText + ' {',
    bodyText,
    methodIndent + '}',
  ].join(newline)
  const closePosition = method.classBody.to - 1
  const closeLineStart = lineStart(source, closePosition)
  // For a compact one-line class, insert immediately before the closing
  // brace. Inserting at the line start would place the helper before class.
  const insertionPoint = source.slice(closeLineStart, closePosition).trim() === ''
    ? closeLineStart
    : closePosition
  const before = source.slice(0, insertionPoint)
  const prefix = before.endsWith('\n') || before.endsWith('\r') ? '' : newline
  return { from: insertionPoint, insert: prefix + helper + newline }
}

function expressionPlan(
  source: string,
  selection: JavaSelection,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  name: string,
): JavaMethodExtractionResult {
  const expression = selection.expression
  if (!expression) return { reason: 'Select an expression.' }
  const returnType = inferJavaExpressionType(source, expression, declarations, methods)
  if (!returnType || returnType === 'void' || returnType === 'var') {
    return { reason: 'Cannot determine the selected expression type.' }
  }
  const free = freeJavaDeclarations(source, selection.from, selection.to, declarations, methods)
  if (free.reason) return { reason: free.reason }
  if (free.free.some((declaration) => declaration.type === 'var')) {
    return { reason: 'A captured var does not have a resolved method parameter type.' }
  }
  if (checkedCallInSelection(source, [expression], selection.method, methods)) {
    return { reason: 'The selected expression calls a checked-exception method from a method that declares none.' }
  }
  for (const target of assignmentTargets(source, [expression])) {
    const declaration = declarationAt(declarations, target, selection.from + 1)
    if (declaration && declaration.kind !== 'field') {
      return { reason: 'An extracted expression cannot mutate a captured local variable.' }
    }
  }
  const methodIndent = leadingIndent(source, selection.method.node.from)
  const body = methodIndent + '    return ' + source.slice(selection.from, selection.to) + ';'
  const insertion = helperInsertion(source, selection.method, returnType, name, free.free, body)
  const call = name + '(' + free.free.map((declaration) => declaration.name).join(', ') + ')'
  const replacement: JavaRefactorChange = { from: selection.from, to: selection.to, insert: call }
  const changes: JavaRefactorChange[] = [
    replacement,
    { from: insertion.from, to: insertion.from, insert: insertion.insert },
  ]
  return {
    changes,
    name,
    nameRanges: nameRangesAfterChanges(replacement, changes[1], name),
  }
}

function statementPlan(
  source: string,
  selection: JavaSelection,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  name: string,
): JavaMethodExtractionResult {
  const controlFlow = rejectControlFlow(selection.statements)
  if (controlFlow) return controlFlow
  if (checkedCallInSelection(source, selection.statements, selection.method, methods)) {
    return { reason: 'The selected block calls a checked-exception method from a method that declares none.' }
  }
  const free = freeJavaDeclarations(source, selection.from, selection.to, declarations, methods)
  if (free.reason) return { reason: free.reason }
  if (free.free.some((declaration) => declaration.type === 'var')) {
    return { reason: 'A captured var does not have a resolved method parameter type.' }
  }
  const output = outputForStatements(
    source,
    selection.statements,
    selection.from,
    selection.to,
    selection.method,
    declarations,
  )
  if ('reason' in output) return output
  const outputDeclaration = output.declaration ?? output.existing
  if (outputDeclaration?.type === 'var') {
    return { reason: 'Cannot extract a variable declared with var without a resolved type.' }
  }
  if (output.existing && !output.existing.initialized) {
    return { reason: 'A selected assignment would pass an uninitialized local value.' }
  }
  const parameters = [...free.free]
  if (output.existing && !parameters.some((parameter) => parameter.name === output.existing?.name)) {
    parameters.push(output.existing)
  }
  const returnType = outputDeclaration?.type ?? 'void'
  const methodIndent = leadingIndent(source, selection.method.node.from)
  const helperIndent = methodIndent + '    '
  const body = indentExtractedBody(
    source.slice(selection.from, selection.to),
    helperIndent,
    lineBreakOf(source),
    leadingIndent(source, selection.from),
  )
  const bodyWithReturn = outputDeclaration
    ? body + lineBreakOf(source) + helperIndent + 'return ' + outputDeclaration.name + ';'
    : body
  const insertion = helperInsertion(
    source,
    selection.method,
    returnType,
    name,
    parameters,
    bodyWithReturn,
  )
  const argumentText = parameters.map((parameter) => parameter.name).join(', ')
  let replacement = name + '(' + argumentText + ');'
  if (output.declaration) {
    replacement = output.declaration.type + ' ' + output.declaration.name
      + ' = ' + name + '(' + argumentText + ');'
  } else if (output.existing) {
    replacement = output.existing.name + ' = ' + name + '(' + argumentText + ');'
  }
  const replacementChange: JavaRefactorChange = { from: selection.from, to: selection.to, insert: replacement }
  const changes: JavaRefactorChange[] = [
    replacementChange,
    { from: insertion.from, to: insertion.from, insert: insertion.insert },
  ]
  return {
    changes,
    name,
    nameRanges: nameRangesAfterChanges(replacementChange, changes[1], name),
  }
}

/**
 * Plan a bounded Extract Method operation. It accepts an exact
 * Java expression or complete direct statements inside one method body and
 * returns source edits without mutating editor state.
 */
export function planJavaMethodExtraction(
  source: string,
  selectionFrom: number,
  selectionTo: number,
  requestedName?: string,
): JavaMethodExtractionResult {
  const tree = javaLanguage.parser.parse(source).topNode
  const methods = collectMethods(source, tree)
  if (methods.length === 0) return { reason: 'No Java method was found.' }
  const declarations = collectDeclarations(source, tree, methods)
  const selection = selectJavaSource(source, tree, methods, selectionFrom, selectionTo)
  if ('reason' in selection) return selection
  if (selection.method.node.getChild('TypeParameters')) {
    return { reason: 'Generic method type parameters are not yet supported.' }
  }
  const name = uniqueMethodName(source, selection.method.classBody, requestedName)
  return selection.expression
    ? expressionPlan(source, selection, declarations, methods, name)
    : statementPlan(source, selection, declarations, methods, name)
}

import type { JavaDeclaration, JavaMethodInfo, JavaSyntaxNode } from './types'
import { TYPE_NODES, children, descendants, firstChildNamed, nearestAncestor } from './syntax'

const CLASS_MEMBER_TYPE = new Set(['ClassBody'])
const PARAMETER_NODES = new Set(['FormalParameter', 'SpreadParameter'])
const LOCAL_NODES = new Set(['LocalVariableDeclaration', 'Resource'])
const LOOP_NODES = new Set(['ForStatement', 'EnhancedForStatement'])
const BLOCK_NODES = new Set(['Block'])
const DEFINITION_NODE = new Set(['Definition'])

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

export function collectMethods(source: string, tree: JavaSyntaxNode): JavaMethodInfo[] {
  return descendants(tree, (node) => node.name === 'MethodDeclaration')
    .map((node) => methodInfo(source, node))
    .filter((method): method is JavaMethodInfo => Boolean(method))
}

export function containingMethod(methods: readonly JavaMethodInfo[], from: number, to: number): JavaMethodInfo | null {
  return methods
    .filter((method) => method.body.from < from && to < method.body.to)
    .sort((left, right) => (left.body.to - left.body.from) - (right.body.to - right.body.from))[0] ?? null
}

export function collectDeclarations(
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


export function declarationAt(
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

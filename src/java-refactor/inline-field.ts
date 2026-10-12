import { javaLanguage } from '@codemirror/lang-java'
import type { JavaRefactorChange, JavaSyntaxNode } from './types'
import { children, descendants, nearestAncestor, TYPE_NODES, EXPRESSION_NODES } from './syntax'

export interface JavaFieldInliningPlan {
  changes: JavaRefactorChange[]
  name: string
  usageCount: number
}

export type JavaFieldInliningResult = JavaFieldInliningPlan | { reason: string }

type Node = JavaSyntaxNode
interface Binding {
  definition: Node
  scope: Node
  start: number
  field: Node | null
  type: string | null
}

const CLASS_BODIES = new Set(['ClassBody', 'EnumBody', 'InterfaceBody', 'AnnotationTypeBody'])
const CURSOR_ERROR = 'Place the cursor on a field or local variable declaration or reference.'
const RESOLUTION_ERROR = 'Could not resolve every variable reference safely.'
const CONSTANT_ERROR = 'The variable needs a safe initializer with stable primitive or String values.'
const CONSTANT_NODES = new Set([
  'IntegerLiteral', 'FloatingPointLiteral', 'BooleanLiteral', 'CharacterLiteral', 'StringLiteral',
  'TextBlock', 'ParenthesizedExpression', 'BinaryExpression', 'UnaryExpression', 'TernaryExpression',
  'CastExpression', 'PrimitiveType', 'ArithOp', 'BitOp', 'LogicOp', 'CompareOp', 'UnaryOp',
  '(', ')', '?', ':', 'true', 'false', 'LineComment', 'BlockComment',
])

function bindingFor(definition: Node, source: string): Binding | null {
  const parent = definition.parent
  if (!parent) return null
  let scope: Node | null = null
  let start: number | undefined
  let field: Node | null = null
  let declaration = parent
  if (parent.name === 'VariableDeclarator') {
    declaration = parent.parent ?? parent
    if (declaration.name === 'FieldDeclaration') {
      field = declaration
      scope = nearestAncestor(declaration.parent, CLASS_BODIES)
    } else if (declaration.name === 'LocalVariableDeclaration') {
      scope = declaration.parent?.name === 'ForSpec' ? declaration.parent.parent
        : nearestAncestor(declaration.parent, new Set(['Block', 'SwitchBlock', 'ConstructorBody']))
      start = definition.from
    }
  } else if (['FormalParameter', 'SpreadParameter'].includes(parent.name)) {
    const callable = nearestAncestor(parent, new Set(['MethodDeclaration', 'ConstructorDeclaration', 'LambdaExpression']))
    scope = callable?.name === 'LambdaExpression' ? callable
      : callable?.getChild('Block') ?? callable?.getChild('ConstructorBody') ?? null
  } else if (parent.name === 'ForSpec' && parent.parent?.name === 'EnhancedForStatement') {
    scope = children(parent.parent).find((node) => node.from >= parent.to) ?? null
  } else if (parent.name === 'CatchFormalParameter') {
    scope = parent.parent?.getChild('Block') ?? null
  } else if (parent.name === 'Resource') {
    const statement = nearestAncestor(parent, new Set(['TryWithResourcesStatement']))
    scope = statement?.getChild('Block') ?? null
    // Resource scope includes subsequent resources and the try body, but not catch/finally.
    start = definition.from
  } else if (['LambdaExpression', 'InferredParameters'].includes(parent.name)) {
    scope = nearestAncestor(parent, new Set(['LambdaExpression']))
  }
  if (!scope) return null
  const type = children(declaration).find((node) => TYPE_NODES.has(node.name))
  return { definition, scope, start: start ?? scope.from, field, type: type ? source.slice(type.from, type.to) : null }
}

function nameOf(source: string, binding: Binding): string {
  return source.slice(binding.definition.from, binding.definition.to)
}

function lexicalBinding(source: string, bindings: Binding[], name: string, position: number): Binding | null {
  return bindings.filter((binding) => nameOf(source, binding) === name
    && binding.start <= position && position < binding.scope.to)
    .sort((left, right) => left.scope.to - left.scope.from - (right.scope.to - right.scope.from)
      || right.definition.from - left.definition.from)[0] ?? null
}

function className(source: string, body: Node): string | null {
  const definition = body.parent?.getChild('Definition')
  return definition ? source.slice(definition.from, definition.to) : null
}

function identifierReference(node: Node): boolean {
  return node.name === 'Identifier' && !['MethodName', 'MethodReference', 'LabeledStatement', 'BreakStatement', 'ContinueStatement']
    .includes(node.parent?.name ?? '')
}

function fieldBinding(source: string, bindings: Binding[], body: Node, name: string): Binding | null {
  return bindings.find((binding) => binding.field && binding.scope.from === body.from && nameOf(source, binding) === name) ?? null
}

function constantType(source: string, node: Node, referenceType?: (node: Node) => string | null): string | null {
  const text = source.slice(node.from, node.to)
  if (node.name === 'Identifier') return referenceType?.(node) ?? null
  if (node.name === 'IntegerLiteral') return /[lL]$/.test(text) ? 'long' : 'int'
  if (node.name === 'FloatingPointLiteral') return /[fF]$/.test(text) ? 'float' : 'double'
  if (node.name === 'CharacterLiteral') return 'char'
  if (['StringLiteral', 'TextBlock'].includes(node.name)) return 'String'
  if (node.name === 'BooleanLiteral') return 'boolean'
  if (node.name === 'CastExpression') {
    const type = children(node).find((part) => part.name === 'PrimitiveType')
    return type ? source.slice(type.from, type.to) : null
  }
  const expressions = children(node).filter((part) => EXPRESSION_NODES.has(part.name))
  if (node.name === 'ParenthesizedExpression') return expressions[0] ? constantType(source, expressions[0], referenceType) : null
  if (node.name === 'UnaryExpression') {
    const type = expressions[0] ? constantType(source, expressions[0], referenceType) : null
    if (!type) return null
    if (type === 'boolean') return 'boolean'
    return ['byte', 'short', 'char'].includes(type) ? 'int' : type
  }
  if (node.name !== 'BinaryExpression' || expressions.length !== 2) return null
  const left = constantType(source, expressions[0], referenceType)
  const right = constantType(source, expressions[1], referenceType)
  if (!left || !right) return null
  const operator = children(node).find((part) => /Op$/.test(part.name))
  const op = operator ? source.slice(operator.from, operator.to) : ''
  if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) return 'boolean'
  if (op === '+' && (left === 'String' || right === 'String')) return 'String'
  if (['&', '|', '^'].includes(op) && left === 'boolean' && right === 'boolean') return 'boolean'
  const numericType = /^(?:byte|short|char|int|long|float|double)$/
  if (!numericType.test(left) || !numericType.test(right)) return null
  if (['<<', '>>', '>>>'].includes(op)) return left === 'long' ? 'long' : 'int'
  for (const type of ['double', 'float', 'long']) if (left === type || right === type) return type
  return 'int'
}

/** Replace reads in this document only; a failed safety check never returns partial edits. */
export function planJavaFieldInlining(source: string, selectionFrom: number, selectionTo = selectionFrom): JavaFieldInliningResult {
  const root = javaLanguage.parser.parse(source).topNode
  const nodes = descendants(root)
  const syntaxErrors = nodes.filter((node) => node.type.isError)
  const syntaxFailure = { reason: 'Fix syntax errors around the variable declaration, initializer, or usages before inlining.' }
  const reliable = (node: Node): boolean => {
    if (syntaxErrors.length === 0) return true
    const reference = identifierReference(node)
    const access = reference && node.parent?.name === 'FieldAccess' && children(node.parent).at(-1)?.from === node.from
      ? node.parent : node
    if (reference && descendants(access).some((part) => part.type.isError)) return false
    if (reference) {
      for (let context = node.parent; context && !['Block', 'ConstructorBody'].includes(context.name)
        && !CLASS_BODIES.has(context.name); context = context.parent) {
        if (descendants(context).some((part) => part.name === 'MethodReference'
          && children(part).some((child) => TYPE_NODES.has(child.name))
          && descendants(part).some((child) => child.type.isError))) return false
        if (context.name === 'ExpressionStatement'
          && children(context).some((part) => part.name === 'TernaryExpression')
          && descendants(context).some((part) => part.type.isError)) return false
      }
    }
    for (let context: Node | null = reference ? null : node; context && !['Block', 'ConstructorBody'].includes(context.name)
      && !CLASS_BODIES.has(context.name); context = context.parent) {
      if (descendants(context).some((part) => {
        if (!part.type.isError) return false
        let branch = part
        while (branch.parent && (branch.parent.name !== context!.name
          || branch.parent.from !== context!.from || branch.parent.to !== context!.to)) branch = branch.parent
        return !(['Block', 'ConstructorBody'].includes(branch.name) || /Statement$/.test(branch.name))
          || (branch.from <= node.from && node.to <= branch.to)
      })) return false
    }
    for (let owner = node.parent; owner; owner = owner.parent) {
      if (!['MethodDeclaration', 'ConstructorDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration'].includes(owner.name)) continue
      if (children(owner).some((part) => !['Block', 'ConstructorBody'].includes(part.name) && !CLASS_BODIES.has(part.name)
        && descendants(part).some((nested) => nested.type.isError))) return false
    }
    return true
  }
  const understoodOccurrences = (name: string, range: { from: number; to: number }): boolean => {
    if (syntaxErrors.length === 0) return true
    for (const token of source.matchAll(/[$_\p{ID_Start}][$_\p{ID_Continue}]*/gu)) {
      if (token[0] !== name) continue
      const from = token.index
      const to = from + name.length
      if (from < range.from || to > range.to) continue
      if (nodes.some((node) => ['IntegerLiteral', 'FloatingPointLiteral'].includes(node.name)
        && node.from <= from && to <= node.to
        && !descendants(node).some((part) => part.type.isError))) continue
      if (nodes.some((node) => ['LineComment', 'BlockComment', 'StringLiteral', 'TextBlock', 'CharacterLiteral'].includes(node.name)
        && node.from <= from && to <= node.to
        && !descendants(node).some((part) => part.type.isError)
        && (node.name === 'LineComment' || (node.name === 'BlockComment' ? source.slice(node.from, node.to).endsWith('*/')
          : node.name === 'TextBlock' ? source.slice(node.from, node.to).endsWith('"""')
            : source.slice(node.from, node.to).endsWith(node.name === 'CharacterLiteral' ? "'" : '"'))))) continue
      if (from > 0 && /[0-9]/.test(source[from - 1])) return false
      const parsed = nodes.find((node) => ['Identifier', 'Definition', 'TypeName'].includes(node.name)
        && node.from === from && node.to === to)
      if (!parsed || !reliable(parsed)) return false
    }
    return true
  }
  const definitions = nodes.filter((node) => node.name === 'Definition')
  const bindings = definitions.map((node) => bindingFor(node, source)).filter((binding): binding is Binding => Boolean(binding))
  const bodies = nodes.filter((node) => CLASS_BODIES.has(node.name))
  const selected = nodes.find((node) => (node.name === 'Definition' || identifierReference(node))
    && (selectionFrom === selectionTo ? node.from <= selectionFrom && selectionFrom <= node.to
      : node.from === selectionFrom && node.to === selectionTo))
  if (!selected) return { reason: CURSOR_ERROR }
  const name = source.slice(selected.from, selected.to)
  if (!reliable(selected)) return syntaxFailure

  // Qualified reads resolve by their receiver, never by the spelling of the member alone.
  const resolve = (node: Node): Binding | null | 'ambiguous' => {
    if (node.parent?.name !== 'FieldAccess' || children(node.parent).at(-1)?.from !== node.from) {
      return lexicalBinding(source, bindings, source.slice(node.from, node.to), node.from)
    }
    const access = node.parent
    const receiver = source.slice(access.from, node.from).replace(/\.\s*$/, '').trim()
    let body: Node | null = null
    if (receiver === 'this') body = nearestAncestor(access, CLASS_BODIES)
    else if (/^[$\w]+\.this$/.test(receiver)) {
      const owner = receiver.slice(0, -5)
      for (let current = access.parent; current; current = current.parent) {
        if (CLASS_BODIES.has(current.name) && className(source, current) === owner) { body = current; break }
      }
    } else {
      const matching = bodies.filter((candidate) => className(source, candidate) === receiver)
      if (matching.length === 1 && !lexicalBinding(source, bindings, receiver, access.from)) body = matching[0]
      else {
        const receiverBinding = lexicalBinding(source, bindings, receiver, access.from)
        const typeBodies = bodies.filter((candidate) => className(source, candidate) === receiverBinding?.type)
        if (typeBodies.length === 1) {
          return fieldBinding(source, bindings, typeBodies[0], source.slice(node.from, node.to)) ? 'ambiguous' : null
        }
        return 'ambiguous'
      }
    }
    return body ? fieldBinding(source, bindings, body, source.slice(node.from, node.to)) : 'ambiguous'
  }
  const resolved = selected.name === 'Definition' ? bindings.find((binding) => binding.definition.from === selected.from) : resolve(selected)
  if (!resolved || resolved === 'ambiguous') return { reason: CURSOR_ERROR }
  const target = resolved
  const variable = target.definition.parent!
  const declaration = target.field ?? variable.parent
  if (variable.name !== 'VariableDeclarator' || !declaration
    || !['FieldDeclaration', 'LocalVariableDeclaration'].includes(declaration.name)) {
    return { reason: 'Only initialized fields and block local variables can be inlined.' }
  }
  if (!reliable(declaration)) return syntaxFailure
  if (!target.field && !['Block', 'ConstructorBody'].includes(declaration.parent?.name ?? '')) {
    return { reason: 'Local variables in loop headers or other declaration positions cannot be inlined safely.' }
  }
  const closingBrace = target.scope.getChild('}')
  const occurrenceRange = !target.field && closingBrace?.to === target.scope.to
    ? { from: target.scope.from, to: target.scope.to }
    : { from: 0, to: source.length }
  if (!understoodOccurrences(name, occurrenceRange)) return syntaxFailure
  const ownerName = className(source, target.scope)
  if (target.field && nodes.some((node) => {
    if (node.name !== 'ImportDeclaration' || !children(node).some((part) => part.name === 'static')) return false
    const identifiers = descendants(node).filter((part) => part.name === 'Identifier').map((part) => source.slice(part.from, part.to))
    return (identifiers.at(-2) === ownerName && identifiers.at(-1) === name)
      || (identifiers.at(-1) === ownerName && descendants(node).some((part) => source.slice(part.from, part.to) === '*'))
  })) return { reason: 'A static import may refer to this field; it cannot be resolved safely.' }
  const type = target.type?.trim()
  if (!type || !/^(?:byte|short|int|long|float|double|char|boolean|String|java\.lang\.String)$/.test(type)
    || source.slice(target.definition.to, variable.to).match(/^\s*\[/)) return { reason: CONSTANT_ERROR }
  const initializer = children(variable).find((node) => node.from > target.definition.to && node.name !== 'AssignOp'
    && !['LineComment', 'BlockComment'].includes(node.name))
  if (!initializer || !children(variable).some((node) => node.name === 'AssignOp')) return { reason: 'The variable has no initializer.' }
  const dependencies = new Map<number, Binding>()
  let dependencySyntaxError = false
  const proofResults = new Map<number, boolean>()
  const constantResults = new Map<number, boolean>()
  const stable = (binding: Binding, visiting: Set<number>): boolean => {
    if (visiting.has(binding.definition.from)) return false
    const cached = proofResults.get(binding.definition.from)
    if (cached !== undefined) return cached
    proofResults.set(binding.definition.from, false)
    const variableNode = binding.definition.parent
    const declarationNode = binding.field ?? variableNode?.parent
    if (variableNode?.name !== 'VariableDeclarator' || !declarationNode
      || !['FieldDeclaration', 'LocalVariableDeclaration'].includes(declarationNode.name)
      || !binding.type || !/^(?:byte|short|int|long|float|double|char|boolean|String|java\.lang\.String)$/.test(binding.type.trim())
      || source.slice(binding.definition.to, variableNode.to).match(/^\s*\[/)) return false
    const dependencyClosingBrace = binding.scope.getChild('}')
    const dependencyRange = binding.field ? occurrenceRange
      : dependencyClosingBrace?.to === binding.scope.to
        ? { from: binding.scope.from, to: binding.scope.to } : { from: 0, to: source.length }
    if (!reliable(declarationNode) || !understoodOccurrences(nameOf(source, binding), dependencyRange)) {
      dependencySyntaxError = true
      return false
    }
    const modifiersNode = declarationNode.getChild('Modifiers')
    const dependencyFinal = Boolean(modifiersNode && children(modifiersNode).some((part) => part.name === 'final'))
    if (!dependencyFinal && (binding.field || ['String', 'java.lang.String'].includes(binding.type.trim()))) return false
    const value = children(variableNode).find((part) => part.from > binding.definition.to && part.name !== 'AssignOp'
      && !['LineComment', 'BlockComment'].includes(part.name))
    if (!value || !children(variableNode).some((part) => part.name === 'AssignOp')
      || descendants(value).some((part) => part.name === 'ArithOp' && ['/', '%'].includes(source.slice(part.from, part.to)))) return false
    if (nodes.some((reference) => {
      if (!identifierReference(reference) || source.slice(reference.from, reference.to) !== nameOf(source, binding)) return false
      const referenceBinding = resolve(reference)
      if (referenceBinding !== 'ambiguous' && referenceBinding?.definition.from !== binding.definition.from) return false
      let expression = reference.parent?.name === 'FieldAccess' && children(reference.parent).at(-1)?.from === reference.from
        ? reference.parent : reference
      while (expression.parent?.name === 'ParenthesizedExpression') expression = expression.parent
      return expression.parent?.name === 'UpdateExpression'
        || (expression.parent?.name === 'AssignmentExpression' && children(expression.parent)[0]?.from === expression.from)
    })) return false
    const next = new Set(visiting).add(binding.definition.from)
    const result = stableExpression(value, next)
    if (!result) return false
    const constant = dependencyFinal && compileConstant(value)
    if (!constant && (binding.field || ['String', 'java.lang.String'].includes(binding.type.trim()))) return false
    constantResults.set(binding.definition.from, constant)
    proofResults.set(binding.definition.from, true)
    return true
  }
  const stableExpression = (expression: Node, visiting: Set<number>): boolean => descendants(expression).every((part) => {
    if (CONSTANT_NODES.has(part.name)) return true
    if (part.name !== 'Identifier' || target.field) return false
    const binding = resolve(part)
    if (!binding || binding === 'ambiguous') return false
    const owner = nearestAncestor(part, CLASS_BODIES)
    if (binding.field && owner?.from !== binding.scope.from && owner?.parent
      && (owner.parent.name === 'ObjectCreationExpression'
        || children(owner.parent).some((child) => ['Superclass', 'SuperInterfaces'].includes(child.name)))) return false
    return stable(binding, visiting)
  })
  const compileConstant = (expression: Node): boolean => descendants(expression).filter((part) => part.name === 'Identifier').every((reference) => {
    const binding = resolve(reference)
    return Boolean(binding && binding !== 'ambiguous' && constantResults.get(binding.definition.from))
  })
  if (!stableExpression(initializer, new Set([target.definition.from]))) return dependencySyntaxError ? syntaxFailure : { reason: CONSTANT_ERROR }
  const initializerConstant = compileConstant(initializer)
  if (!initializerConstant && ['String', 'java.lang.String'].includes(type)) return { reason: 'A runtime String initializer cannot be duplicated safely.' }
  for (const reference of descendants(initializer).filter((part) => part.name === 'Identifier')) {
    const binding = resolve(reference)
    if (binding && binding !== 'ambiguous') dependencies.set(binding.definition.from, binding)
  }
  const modifiers = declaration.getChild('Modifiers')
  const modifierNames = new Set(modifiers ? children(modifiers).map((node) => node.name) : [])
  if (descendants(initializer).some((node) => node.name === 'ArithOp' && ['/', '%'].includes(source.slice(node.from, node.to)))) {
    return { reason: 'A division or remainder initializer cannot be proven safe.' }
  }
  const isStatic = modifierNames.has('static')
  const isFinal = modifierNames.has('final')
  if (modifierNames.has('volatile')) return { reason: 'Volatile fields cannot be inlined safely.' }
  if (target.field && !isFinal && target.scope.parent && children(target.scope.parent).some((node) => node.name === 'Superclass')) {
    return { reason: 'A superclass constructor may read the field before it is initialized.' }
  }
  if (target.field && !isFinal && children(target.scope).some((node) => {
    if (!['FieldDeclaration', 'Block', 'StaticInitializer'].includes(node.name) || node.from > variable.from) return false
    return descendants(node).some((part) => part.from < variable.from
      && ['MethodInvocation', 'ObjectCreationExpression'].includes(part.name))
  })) {
    return { reason: 'An earlier initializer may read the field before it is initialized.' }
  }
  if (!isFinal && (type === 'String' || type === 'java.lang.String'
    || descendants(initializer).some((node) => ['StringLiteral', 'TextBlock'].includes(node.name)))) {
    // Non-constant String reads must not gain constant-expression concatenation and interning semantics.
    return { reason: 'String variables must be final to inline safely.' }
  }
  const inferredType = constantType(source, initializer, (reference) => {
    const binding = resolve(reference)
    return binding && binding !== 'ambiguous' ? binding.type?.replace(/^java\.lang\.String$/, 'String') ?? null : null
  })
  const replacement = type === 'String' || type === 'java.lang.String' || inferredType === type
    ? `(${source.slice(initializer.from, initializer.to)})`
    : `((${type}) (${source.slice(initializer.from, initializer.to)}))`
  const numeric = (node: Node): boolean => {
    if (['IntegerLiteral', 'FloatingPointLiteral', 'CharacterLiteral'].includes(node.name)) return true
    if (node.name === 'Identifier' || node.name === 'FieldAccess') {
      const reference = node.name === 'FieldAccess' ? children(node).at(-1)! : node
      const binding = resolve(reference)
      return Boolean(binding && binding !== 'ambiguous' && binding.type && /^(byte|short|int|long|float|double|char)$/.test(binding.type.trim()))
    }
    if (node.name === 'CastExpression') {
      const castType = children(node).find((part) => TYPE_NODES.has(part.name))
      return Boolean(castType && /^(byte|short|int|long|float|double|char)$/.test(source.slice(castType.from, castType.to)))
    }
    if (['BinaryExpression', 'UnaryExpression', 'ParenthesizedExpression'].includes(node.name)) {
      const expressions = children(node).filter((part) => EXPRESSION_NODES.has(part.name))
      return expressions.length > 0 && expressions.every(numeric)
        && !children(node).some((part) => ['CompareOp', 'LogicOp'].includes(part.name))
    }
    return false
  }
  const changes: JavaRefactorChange[] = []
  for (const node of nodes) {
    if (!identifierReference(node) || source.slice(node.from, node.to) !== name) continue
    if (variable.from <= node.from && node.to <= variable.to) continue
    if (!target.field && node.parent?.name === 'FieldAccess' && children(node.parent).at(-1)?.from === node.from) continue
    const binding = resolve(node)
    if (binding === 'ambiguous') return { reason: RESOLUTION_ERROR }
    if (binding?.definition.from !== target.definition.from) continue
    if (definitions.some((definition) => source.slice(definition.from, definition.to) === name
      && target.scope.from < definition.from && definition.from < node.from
      && !bindings.some((candidate) => candidate.definition.from === definition.from)
      && !['ClassDeclaration', 'MethodDeclaration', 'ConstructorDeclaration'].includes(definition.parent?.name ?? ''))) {
      return { reason: RESOLUTION_ERROR }
    }
    if ([...dependencies.values()].some((dependency) => {
      const dependencyName = nameOf(source, dependency)
      if (lexicalBinding(source, bindings, dependencyName, node.from)?.definition.from !== dependency.definition.from) return true
      return definitions.some((definition) => source.slice(definition.from, definition.to) === dependencyName
        && target.scope.from < definition.from && definition.from < node.from
        && !bindings.some((candidate) => candidate.definition.from === definition.from)
        && !['ClassDeclaration', 'MethodDeclaration', 'ConstructorDeclaration'].includes(definition.parent?.name ?? ''))
    })) return { reason: 'An initializer dependency is shadowed at a usage; it cannot be inlined safely.' }
    const access = node.parent?.name === 'FieldAccess' && children(node.parent).at(-1)?.from === node.from ? node.parent : node
    let expression = access
    while (expression.parent?.name === 'ParenthesizedExpression') expression = expression.parent
    const parent = expression.parent
    if (parent?.name === 'UpdateExpression' || (parent?.name === 'AssignmentExpression' && children(parent)[0]?.from === expression.from)) {
      return { reason: 'The variable is assigned or updated; it cannot be inlined.' }
    }
    const enclosingBody = nearestAncestor(node, CLASS_BODIES)
    const ownerBody = target.field ? target.scope : nearestAncestor(variable, CLASS_BODIES)
    if (enclosingBody?.from !== ownerBody?.from && enclosingBody?.parent
      && (enclosingBody.parent.name === 'ObjectCreationExpression'
        || children(enclosingBody.parent).some((child) => ['Superclass', 'SuperInterfaces'].includes(child.name)))
      && access.name !== 'FieldAccess') {
      return { reason: RESOLUTION_ERROR }
    }
    if (target.field && !isFinal && node.from < variable.from) return { reason: 'The field is read before its initializer.' }
    if (target.field && !isFinal && isStatic && enclosingBody?.from !== target.scope.from) {
      return { reason: 'Inlining this read could skip class initialization.' }
    }
    if (initializerConstant && (!isFinal || (access.name === 'FieldAccess' && /\bthis\s*\./.test(source.slice(access.from, access.to))))) {
      for (let context = access.parent; context && context.from >= target.scope.from; context = context.parent) {
        if (context.name === 'TernaryExpression'
          || (context.name === 'BinaryExpression' && children(context).some((part) => part.name === 'ArithOp' && source.slice(part.from, part.to) === '+') && !numeric(context))
          || (['WhileStatement', 'DoStatement', 'ForStatement'].includes(context.name)
            && children(context).some((part) => ['ParenthesizedExpression', 'ForSpec'].includes(part.name) && part.from <= access.from && access.to <= part.to))) {
          return { reason: 'This use depends on whether the variable is a constant expression.' }
        }
      }
    }
    if (descendants(access).some((part) => ['LineComment', 'BlockComment'].includes(part.name))) return { reason: 'A qualified field reference contains comments.' }
    changes.push({ from: access.from, to: access.to, insert: replacement })
  }
  const usageCount = changes.length
  if (usageCount === 0) return { reason: `${target.field ? 'Field' : 'Variable'} ${name} is never used.` }
  const declarators = children(declaration).filter((node) => node.name === 'VariableDeclarator')
  const comments = descendants(variable).filter((node) => ['LineComment', 'BlockComment'].includes(node.name))
  const preservedComments = comments.map((node) => source.slice(node.from, node.to) + (node.name === 'LineComment' ? '\n' : ' ')).join('')
  if (declarators.length === 1) {
    const allComments = descendants(declaration).filter((node) => ['LineComment', 'BlockComment'].includes(node.name))
    const insert = allComments.map((node) => source.slice(node.from, node.to) + (node.name === 'LineComment' ? (source.includes('\r\n') ? '\r\n' : '\n') : ' ')).join('')
    changes.push({ from: declaration.from, to: declaration.to, insert })
  } else {
    const index = declarators.findIndex((node) => node.from === variable.from)
    const comma = children(declaration).find((node) => node.name === ',' && (index === 0 ? node.from >= variable.to : node.to <= variable.from && node.from >= declarators[index - 1].to))
    if (!comma) return { reason: RESOLUTION_ERROR }
    changes.push({ from: variable.from, to: variable.to, insert: preservedComments.replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n') })
    changes.push({ from: comma.from, to: comma.to, insert: '' })
  }
  changes.sort((left, right) => left.from - right.from)
  return { changes, name, usageCount }
}

import { javaLanguage } from '@codemirror/lang-java'
import type { EditorState } from '@codemirror/state'
import type { JavaMethodRenameResult } from './rename'

type Node = ReturnType<typeof javaLanguage.parser.parse>['topNode']

interface Binding {
  name: string
  from: number
  to: number
  scopeFrom: number
  scopeTo: number
  field: boolean
}

const CURSOR_ERROR = 'Place the cursor on a variable declaration or reference.'

function children(node: Node): Node[] {
  const result: Node[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}

function ancestor(node: Node | null, names: readonly string[]): Node | null {
  for (let current = node; current; current = current.parent) {
    if (names.includes(current.name)) return current
  }
  return null
}

function bindingFor(definition: Node, source: string): Binding | null {
  const parent = definition.parent
  if (!parent) return null
  let scope: Node | null = null
  let scopeFrom: number | undefined
  let scopeTo: number | undefined
  let field = false
  if (parent.name === 'VariableDeclarator') {
    const declaration = parent.parent
    if (declaration?.name === 'FieldDeclaration') {
      scope = ancestor(declaration, ['ClassBody'])
      field = true
    } else if (declaration?.name === 'LocalVariableDeclaration') {
      scope = declaration.parent?.name === 'ForSpec'
        ? declaration.parent.parent
        : ancestor(declaration, ['Block', 'SwitchBlock', 'ConstructorBody'])
      scopeFrom = definition.from
    }
  } else if (['FormalParameter', 'SpreadParameter'].includes(parent.name)) {
    const callable = ancestor(parent, ['MethodDeclaration', 'ConstructorDeclaration', 'LambdaExpression'])
    scope = callable?.name === 'LambdaExpression'
      ? callable
      : callable?.getChild('Block') ?? callable?.getChild('ConstructorBody') ?? null
  } else if (parent.name === 'ForSpec' && parent.parent?.name === 'EnhancedForStatement') {
    scope = children(parent.parent).find((node) => node.from >= parent.to) ?? null
  } else if (parent.name === 'CatchFormalParameter') {
    scope = parent.parent?.getChild('Block') ?? null
  } else if (parent.name === 'Resource') {
    const statement = ancestor(parent, ['TryWithResourcesStatement'])
    const body = statement?.getChild('Block')
    scope = statement
    scopeFrom = definition.from
    scopeTo = body?.to
  } else if (parent.name === 'LambdaExpression' || parent.name === 'InferredParameters') {
    scope = ancestor(parent, ['LambdaExpression'])
  }
  if (!scope) return null
  return {
    name: source.slice(definition.from, definition.to),
    from: definition.from,
    to: definition.to,
    scopeFrom: scopeFrom ?? scope.from,
    scopeTo: scopeTo ?? scope.to,
    field,
  }
}

function isVariableReference(node: Node): boolean {
  if (node.name !== 'Identifier') return false
  const parent = node.parent
  if (!parent || parent.name === 'MethodName') return false
  if (parent.name === 'FieldAccess' || parent.name === 'MethodReference') {
    return children(parent).at(-1)?.from !== node.from
  }
  return !['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.name)
}

function resolve(bindings: readonly Binding[], name: string, position: number): Binding | null {
  return bindings.filter((binding) => binding.name === name
    && binding.scopeFrom <= position && position < binding.scopeTo)
    .sort((left, right) => (
      left.scopeTo - left.scopeFrom - (right.scopeTo - right.scopeFrom)
        || right.from - left.from
    ))[0] ?? null
}

/** Find the lexical declaration and its references without touching matching text. */
export function planJavaVariableRename(sourceOrState: string | EditorState, position: number): JavaMethodRenameResult {
  const source = typeof sourceOrState === 'string' ? sourceOrState : sourceOrState.doc.toString()
  const root = javaLanguage.parser.parse(source).topNode
  const nodes: Node[] = []
  const walk = (node: Node): void => {
    nodes.push(node)
    for (const child of children(node)) walk(child)
  }
  walk(root)
  const definitions = nodes.filter((node) => node.name === 'Definition')
  const bindings = definitions.map((node) => bindingFor(node, source))
    .filter((binding): binding is Binding => binding !== null)
  const selected = nodes.find((node) => (node.name === 'Definition' || isVariableReference(node))
    && node.from <= position && position <= node.to)
  if (!selected) return { reason: CURSOR_ERROR }
  const name = source.slice(selected.from, selected.to)
  const target = selected.name === 'Definition'
    ? bindings.find((binding) => binding.from === selected.from)
    : resolve(bindings, name, selected.from)
  if (!target || target.field) return { reason: CURSOR_ERROR }
  // Unsupported declarations can shadow a captured variable; do not leave
  // those references unchanged or accidentally rename them as the outer one.
  if (definitions.some((node) => source.slice(node.from, node.to) === name
    && target.scopeFrom <= node.from && node.from < target.scopeTo
    && !bindings.some((binding) => binding.from === node.from))) {
    return { reason: 'Could not resolve every variable reference safely.' }
  }
  const ranges = [{ from: target.from, to: target.to }]
  for (const node of nodes) {
    if (!isVariableReference(node) || source.slice(node.from, node.to) !== name) continue
    if (resolve(bindings, name, node.from)?.from === target.from) {
      ranges.push({ from: node.from, to: node.to })
    }
  }
  ranges.sort((left, right) => left.from - right.from)
  return { name, ranges }
}

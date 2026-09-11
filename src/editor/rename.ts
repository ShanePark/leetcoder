import { java } from '@codemirror/lang-java'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface JavaMethodRenameRange {
  from: number
  to: number
}

export interface JavaMethodRenamePlan {
  name: string
  ranges: JavaMethodRenameRange[]
}

export interface JavaMethodRenameFailure {
  reason: string
}

export type JavaMethodRenameResult = JavaMethodRenamePlan | JavaMethodRenameFailure

type JavaSyntaxNode = ReturnType<typeof syntaxTree>['topNode']

interface JavaOwner {
  from: number
  to: number
  className: string | null
}

interface JavaMethodInfo {
  name: string
  from: number
  to: number
  owner: JavaOwner | null
  parameterCount: number
  varargs: boolean
  static: boolean
}

interface JavaMethodUse {
  name: string
  from: number
  to: number
  owner: JavaOwner | null
  node: JavaSyntaxNode
}

interface JavaSourceAnalysis {
  methods: JavaMethodInfo[]
  invocations: JavaMethodUse[]
  references: JavaMethodUse[]
}

type ReceiverKind = 'unqualified' | 'this' | 'class' | 'new' | 'unknown'

interface ReceiverResolution {
  kind: ReceiverKind
  staticOnly: boolean
  receiverName?: string | null
}

const UNSUPPORTED_RECEIVER = 'Could not resolve every method call safely.'
const CURSOR_ERROR = 'Place the cursor on a method declaration or same-file call.'
const AMBIGUOUS_CALL = 'The method call is ambiguous; rename was cancelled.'

function directChildren(node: JavaSyntaxNode): JavaSyntaxNode[] {
  const children: JavaSyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child)
  }
  return children
}

function directChild(node: JavaSyntaxNode, name: string): JavaSyntaxNode | null {
  return directChildren(node).find((child) => child.name === name) ?? null
}

function simpleTypeName(source: string, node: JavaSyntaxNode | null): string | null {
  if (!node) return null
  const text = source.slice(node.from, node.to)
  const names = text.replace(/<.*>/gs, '').match(/[A-Za-z_$][\w$]*/g)
  return names?.at(-1) ?? null
}

function ownerForClassBody(
  source: string,
  node: JavaSyntaxNode,
  parent: JavaSyntaxNode | null,
): JavaOwner {
  if (parent?.name === 'ClassDeclaration') {
    const definition = directChild(parent, 'Definition')
    return {
      from: node.from,
      to: node.to,
      className: definition ? source.slice(definition.from, definition.to) : null,
    }
  }
  if (parent?.name === 'ObjectCreationExpression') {
    const type = directChildren(parent).find((child) => (
      child.name === 'TypeName' || child.name === 'ScopedTypeName' || child.name === 'GenericType'
    )) ?? null
    return {
      from: node.from,
      to: node.to,
      className: simpleTypeName(source, type),
    }
  }
  return { from: node.from, to: node.to, className: null }
}

function sameOwner(left: JavaOwner | null, right: JavaOwner | null): boolean {
  return left !== null && right !== null && left.from === right.from && left.to === right.to
}

function nestedOwner(owner: JavaOwner | null, outer: JavaOwner | null): boolean {
  return owner !== null && outer !== null
    && outer.from < owner.from
    && owner.to < outer.to
}

function methodParameters(node: JavaSyntaxNode): { count: number, varargs: boolean } {
  const parameters = directChild(node, 'FormalParameters')
  if (!parameters) return { count: 0, varargs: false }
  const entries = directChildren(parameters).filter((child) => (
    child.name === 'FormalParameter' || child.name === 'SpreadParameter'
  ))
  return {
    count: entries.length,
    varargs: entries.some((entry) => entry.name === 'SpreadParameter'),
  }
}

function isStaticMethod(node: JavaSyntaxNode): boolean {
  const modifiers = directChild(node, 'Modifiers')
  return Boolean(modifiers && directChild(modifiers, 'static'))
}

function methodNameNode(node: JavaSyntaxNode): JavaSyntaxNode | null {
  return directChild(node, 'Definition')
}

function useNameNode(node: JavaSyntaxNode, kind: 'MethodName' | 'MethodReference'): JavaSyntaxNode | null {
  const parent = directChild(node, kind)
  if (parent) return directChild(parent, 'Identifier') ?? parent
  const children = directChildren(node)
  return [...children].reverse().find((child) => child.name === 'Identifier') ?? null
}

function analyzeJavaSource(state: EditorState): JavaSourceAnalysis {
  const source = state.doc.toString()
  const methods: JavaMethodInfo[] = []
  const invocations: JavaMethodUse[] = []
  const references: JavaMethodUse[] = []
  const root = syntaxTree(state).topNode

  const walk = (
    node: JavaSyntaxNode,
    owner: JavaOwner | null,
    parent: JavaSyntaxNode | null,
  ): void => {
    const nextOwner = node.name === 'ClassBody'
      ? ownerForClassBody(source, node, parent)
      : owner
    if (node.name === 'MethodDeclaration') {
      const name = methodNameNode(node)
      if (name) {
        const parameters = methodParameters(node)
        methods.push({
          name: state.doc.sliceString(name.from, name.to),
          from: name.from,
          to: name.to,
          owner,
          parameterCount: parameters.count,
          varargs: parameters.varargs,
          static: isStaticMethod(node),
        })
      }
    } else if (node.name === 'MethodInvocation') {
      const name = useNameNode(node, 'MethodName')
      if (name) {
        invocations.push({
          name: state.doc.sliceString(name.from, name.to),
          from: name.from,
          to: name.to,
          owner,
          node,
        })
      }
    } else if (node.name === 'MethodReference') {
      const name = useNameNode(node, 'MethodReference')
      if (name) {
        references.push({
          name: state.doc.sliceString(name.from, name.to),
          from: name.from,
          to: name.to,
          owner,
          node,
        })
      }
    }
    for (const child of directChildren(node)) {
      walk(child, nextOwner, node)
    }
  }
  walk(root, null, null)
  return { methods, invocations, references }
}

function sourceState(source: string): EditorState | null {
  const state = EditorState.create({ doc: source, extensions: [java()] })
  return ensureSyntaxTree(state, state.doc.length, 1000) ? state : null
}

function analysisState(sourceOrState: string | EditorState): EditorState | null {
  if (typeof sourceOrState === 'string') return sourceState(sourceOrState)
  return ensureSyntaxTree(sourceOrState, sourceOrState.doc.length, 1000)
    ? sourceOrState
    : null
}

function methodAtPosition(methods: readonly JavaMethodInfo[], position: number): JavaMethodInfo | null {
  return methods.find((method) => method.from <= position && position <= method.to) ?? null
}

function useAtPosition(uses: readonly JavaMethodUse[], position: number): JavaMethodUse | null {
  return uses.find((use) => use.from <= position && position <= use.to) ?? null
}

function methodArgumentCount(node: JavaSyntaxNode): number | null {
  const argumentsNode = directChild(node, 'ArgumentList')
  if (!argumentsNode) return null
  return directChildren(argumentsNode).filter((child) => (
    child.name !== '(' && child.name !== ')' && child.name !== ','
  )).length
}

function methodMatchesCall(method: JavaMethodInfo, argumentCount: number | null): boolean {
  if (argumentCount === null) return true
  return method.varargs
    ? argumentCount >= Math.max(0, method.parameterCount - 1)
    : method.parameterCount === argumentCount
}

function methodCandidates(
  analysis: JavaSourceAnalysis,
  name: string,
  owner: JavaOwner | null,
  argumentCount: number | null,
  staticOnly: boolean,
): JavaMethodInfo[] {
  return analysis.methods.filter((method) => (
    sameOwner(method.owner, owner)
      && method.name === name
      && (!staticOnly || method.static)
      && methodMatchesCall(method, argumentCount)
  ))
}

function receiverResolution(
  source: string,
  node: JavaSyntaxNode,
  owner: JavaOwner | null,
): ReceiverResolution {
  const children = directChildren(node)
  const methodName = directChild(node, 'MethodName')
  const nameIndex = methodName
    ? children.findIndex((child) => child.from === methodName.from && child.to === methodName.to)
    : -1
  const meaningful = children.slice(0, nameIndex).filter((child) => (
    child.name !== '.' && child.name !== 'TypeArguments'
  ))
  if (meaningful.length === 0) return { kind: 'unqualified', staticOnly: false }
  if (meaningful.length === 1 && meaningful[0]?.name === 'this') {
    return { kind: 'this', staticOnly: false }
  }
  if (meaningful.length === 1 && meaningful[0]?.name === 'ObjectCreationExpression') {
    const type = directChildren(meaningful[0]).find((child) => (
      child.name === 'TypeName' || child.name === 'ScopedTypeName' || child.name === 'GenericType'
    )) ?? null
    const receiverName = simpleTypeName(source, type)
    return receiverName === owner?.className
      ? { kind: 'new', staticOnly: false, receiverName }
      : { kind: 'unknown', staticOnly: false, receiverName }
  }
  if (meaningful.length === 1 && owner?.className) {
    const receiver = meaningful[0]
    const receiverName = receiver.name === 'Identifier' || receiver.name === 'TypeName' || receiver.name === 'ScopedTypeName'
      || receiver.name === 'GenericType'
      ? simpleTypeName(source, receiver)
      : null
    if (receiverName === owner.className) return { kind: 'class', staticOnly: true, receiverName }
    return { kind: 'unknown', staticOnly: false, receiverName }
  }
  return { kind: 'unknown', staticOnly: false }
}

function referenceResolution(
  source: string,
  node: JavaSyntaxNode,
  owner: JavaOwner | null,
): ReceiverResolution {
  const children = directChildren(node)
  const nameNode = children.at(-1)
  const nameIndex = nameNode ? children.length - 1 : -1
  const meaningful = children.slice(0, nameIndex).filter((child) => child.name !== '::')
  if (meaningful.length === 0) return { kind: 'unqualified', staticOnly: false }
  if (meaningful.length === 1 && meaningful[0]?.name === 'this') {
    return { kind: 'this', staticOnly: false }
  }
  if (meaningful.length === 1 && owner?.className) {
    const receiverName = simpleTypeName(source, meaningful[0])
    if (receiverName === owner.className) {
      return { kind: 'class', staticOnly: true, receiverName }
    }
    return { kind: 'unknown', staticOnly: false, receiverName }
  }
  return { kind: 'unknown', staticOnly: false }
}

function selectedMethod(
  source: string,
  analysis: JavaSourceAnalysis,
  position: number,
): { method: JavaMethodInfo, selected: JavaMethodUse | null } | JavaMethodRenameFailure {
  const declaration = methodAtPosition(analysis.methods, position)
  if (declaration) return { method: declaration, selected: null }

  const invocation = useAtPosition(analysis.invocations, position)
  const reference = invocation ? null : useAtPosition(analysis.references, position)
  const use = invocation ?? reference
  if (!use) return { reason: CURSOR_ERROR }
  const receiver = reference
    ? referenceResolution(source, use.node, use.owner)
    : receiverResolution(source, use.node, use.owner)
  if (receiver.kind === 'unknown') return { reason: UNSUPPORTED_RECEIVER }
  const argumentCount = reference ? null : methodArgumentCount(use.node)
  const candidates = methodCandidates(analysis, use.name, use.owner, argumentCount, receiver.staticOnly)
  if (candidates.length !== 1) {
    return { reason: candidates.length > 1 ? AMBIGUOUS_CALL : UNSUPPORTED_RECEIVER }
  }
  const method = candidates[0]
  if (!method) return { reason: UNSUPPORTED_RECEIVER }
  return { method, selected: use }
}

function relatedReferences(
  source: string,
  analysis: JavaSourceAnalysis,
  target: JavaMethodInfo,
): JavaMethodRenameResult {
  const ranges: JavaMethodRenameRange[] = [{ from: target.from, to: target.to }]
  const uses = [...analysis.invocations, ...analysis.references]
  for (const use of uses) {
    if (use.name !== target.name) continue
    if (!sameOwner(use.owner, target.owner)) {
      const reference = analysis.references.includes(use)
      const receiver = reference
        ? referenceResolution(source, use.node, use.owner)
        : receiverResolution(source, use.node, use.owner)
      // A fully-qualified reference to the target class is safe to resolve
      // across sibling classes. The AST does not retain enough type data to
      // identify arbitrary variables, so those remain conservative failures.
      if (receiver.receiverName === target.owner?.className) {
        const objectCreation = directChildren(use.node).some((child) => child.name === 'ObjectCreationExpression')
        const staticOnly = !objectCreation
        const argumentCount = reference ? null : methodArgumentCount(use.node)
        const candidates = methodCandidates(
          analysis,
          use.name,
          target.owner,
          argumentCount,
          staticOnly,
        )
        if (candidates.length === 0) return { reason: UNSUPPORTED_RECEIVER }
        if (candidates.length > 1) return { reason: AMBIGUOUS_CALL }
        if (candidates[0]?.from === target.from) {
          ranges.push({ from: use.from, to: use.to })
        }
        continue
      }
      if (receiver.kind === 'unknown') return { reason: UNSUPPORTED_RECEIVER }
      // An unqualified call inside a nested/anonymous class can resolve to a
      // lexically enclosing method when that class has no local declaration.
      // Refuse the whole rename rather than silently leaving that reference
      // behind. Explicit `this` calls belong to the nested class and are safe
      // to ignore here.
      if (nestedOwner(use.owner, target.owner)) {
        const argumentCount = reference ? null : methodArgumentCount(use.node)
        const localCandidates = methodCandidates(
          analysis,
          use.name,
          use.owner,
          argumentCount,
          receiver.staticOnly,
        )
        if (receiver.kind === 'unqualified' && localCandidates.length === 0) {
          return { reason: UNSUPPORTED_RECEIVER }
        }
      }
      continue
    }
    const reference = analysis.references.includes(use)
    const receiver = reference
      ? referenceResolution(source, use.node, use.owner)
      : receiverResolution(source, use.node, use.owner)
    if (receiver.kind === 'unknown') return { reason: UNSUPPORTED_RECEIVER }
    const argumentCount = reference ? null : methodArgumentCount(use.node)
    const candidates = methodCandidates(analysis, use.name, use.owner, argumentCount, receiver.staticOnly)
    if (candidates.length === 0) return { reason: UNSUPPORTED_RECEIVER }
    if (candidates.length > 1) return { reason: AMBIGUOUS_CALL }
    if (candidates[0]?.from === target.from) {
      ranges.push({ from: use.from, to: use.to })
    }
  }
  ranges.sort((left, right) => left.from - right.from)
  return { name: target.name, ranges }
}

/**
 * Build a linked-edit selection for a method declaration and its resolvable
 * same-owner references. CodeMirror's Java tree supplies argument boundaries,
 * receiver shape, overload arity, and anonymous-class ownership, so unresolved
 * references fail the whole operation instead of being silently skipped.
 */
export function planJavaMethodRename(source: string, position: number): JavaMethodRenameResult
export function planJavaMethodRename(state: EditorState, position: number): JavaMethodRenameResult
export function planJavaMethodRename(
  sourceOrState: string | EditorState,
  position: number,
): JavaMethodRenameResult {
  const state = analysisState(sourceOrState)
  if (!state) return { reason: 'Could not parse the Java source safely.' }
  const source = state.doc.toString()
  const analysis = analyzeJavaSource(state)
  const selection = selectedMethod(source, analysis, position)
  if ('reason' in selection) return selection
  return relatedReferences(source, analysis, selection.method)
}

/** Select the declaration and safe same-file call sites for linked editing. */
export function renameJavaMethod(
  view: EditorView,
  onError?: (message: string) => void,
): boolean {
  const state = view.state
  if (state.selection.ranges.length !== 1) {
    onError?.(CURSOR_ERROR)
    return true
  }
  const position = state.selection.main.head
  const result = planJavaMethodRename(state, position)
  if ('reason' in result) {
    onError?.(result.reason)
    return true
  }
  const ranges: SelectionRange[] = result.ranges.map((range) => (
    EditorSelection.range(range.from, range.to)
  ))
  const mainIndex = Math.max(0, result.ranges.findIndex((range) => (
    range.from <= position && position <= range.to
  )))
  view.dispatch({
    selection: EditorSelection.create(ranges, mainIndex),
    scrollIntoView: true,
    userEvent: 'select.renameMethod',
  })
  return true
}

import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { JavaMethodMember, JavaTypeMembersMetadata } from '../backend'
import { collectJavaSymbols } from '../completions/source'
import { resolveJavaReceiverTypes } from '../completions/type-resolution'
import { importLines } from '../completions/imports'
import { readPsLibraryMetadata } from '../completions/library'

interface ParameterCall {
  anchor: number
  end: number
  name: string
  receiver: string | null
  argument: number
  node: SyntaxNode
}

interface ParameterInfo {
  call: ParameterCall
  signatures: JavaMethodMember[]
  source: string
}

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child)
  return result
}

/** Find the innermost method argument list; nested expressions do not add arguments. */
export function javaParameterCallAt(state: EditorState): ParameterCall | null {
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1) return null
  const position = selection.head
  let found: SyntaxNode | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (node.from > position || node.to < position) return false
      if (node.name === 'ArgumentList' && node.node.parent?.name === 'MethodInvocation'
        && position > node.from) {
        const last = node.node.lastChild
        if (last?.name !== ')' || position < last.to) found = node.node
      }
    },
  })
  if (!found) return null
  const argumentsNode = found as SyntaxNode
  if (selection.from <= argumentsNode.from || selection.to > argumentsNode.to) return null
  const invocation = argumentsNode.parent!
  const method = invocation.getChild('MethodName')
  if (!method) return null
  const source = state.doc.toString()
  const receiverText = source.slice(invocation.from, method.from).trim().replace(/\.\s*$/, '').trim()
  // Calls with arbitrary expression receivers need semantic type analysis.
  if (receiverText && !/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(receiverText)) return null
  return {
    anchor: argumentsNode.from,
    end: argumentsNode.to,
    name: source.slice(method.from, method.to),
    receiver: receiverText ? receiverText.replace(/\s/g, '') : null,
    argument: children(argumentsNode).filter((node) => node.name === ',' && node.to <= position).length,
    node: invocation,
  }
}

function containingClass(node: SyntaxNode): SyntaxNode | null {
  for (let parent: SyntaxNode | null = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'ClassBody') return parent
  }
  return null
}

function localSignatures(state: EditorState, call: ParameterCall): JavaMethodMember[] {
  const owner = containingClass(call.node)
  if (!owner) return []
  const source = state.doc.toString()
  const definition = owner.parent?.getChild('Definition')
  const className = definition ? source.slice(definition.from, definition.to) : null
  const packageName = /^[\t ]*package[\t ]+([\w.]+)[\t ]*;/m.exec(source)?.[1]
  const receiverShadowed = call.receiver && collectJavaSymbols(source, call.anchor).some((symbol) => symbol.name === call.receiver
    && symbol.scopeStart <= call.anchor && call.anchor <= symbol.scopeEnd)
  const classReceiver = Boolean(call.receiver && className && !receiverShadowed
    && (call.receiver === className || (packageName && call.receiver === `${packageName}.${className}`)))
  if (call.receiver && call.receiver !== 'this' && !classReceiver) return []
  return children(owner).filter((node) => node.name === 'MethodDeclaration').flatMap((node) => {
    const name = node.getChild('Definition')
    if (!name || source.slice(name.from, name.to) !== call.name) return []
    const isStatic = /\bstatic\b/.test(source.slice(node.from, name.from))
    if (classReceiver && !isStatic) return []
    const formal = node.getChild('FormalParameters')
    if (!formal) return []
    const parameters = children(formal).filter((parameter) => parameter.name === 'FormalParameter' || parameter.name === 'SpreadParameter')
      .flatMap((parameter) => {
        const definition = parameter.getChild('Definition') ?? parameter.getChild('VariableDeclarator')?.getChild('Definition')
        const type = children(parameter).find((child) => /^(?:PrimitiveType|TypeName|ScopedTypeName|GenericType|ArrayType|AnnotatedType)$/.test(child.name))
        if (!definition || !type) return []
        const suffix = source.slice(definition.to, parameter.to).match(/^(?:\s*\[\s*\]\s*)+/)?.[0]?.replace(/\s/g, '') ?? ''
        return [{ name: source.slice(definition.from, definition.to), typeName: source.slice(type.from, type.to) + (parameter.name === 'SpreadParameter' ? '...' : suffix) }]
      })
    const returnType = children(node).find((child) => child.to <= name.from && /^(?:void|PrimitiveType|TypeName|ScopedTypeName|GenericType|ArrayType|AnnotatedType)$/.test(child.name))
    return [{ name: call.name, returnType: returnType ? source.slice(returnType.from, returnType.to) : '', parameters, isStatic }]
  })
}

/** Manual signature help shares the completion metadata inspector and its cache. */
export function createJavaParameterInfo(
  requestJavaTypeMembers?: (typeNames: string[]) => Promise<JavaTypeMembersMetadata>,
): { extension: Extension; show: (view: EditorView) => boolean } {
  const setInfo = StateEffect.define<ParameterInfo | null>()
  let generation = 0
  let destroyed = false
  let refreshScheduled = false
  const field = StateField.define<ParameterInfo | null>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) if (effect.is(setInfo)) return effect.value
      if (!value || (!transaction.docChanged && !transaction.selection)) return value
      const call = javaParameterCallAt(transaction.state)
      if (!call || transaction.changes.mapPos(value.call.anchor) !== call.anchor || value.call.name !== call.name || value.call.receiver !== call.receiver) return null
      return { ...value, call, source: transaction.state.doc.toString() }
    },
    provide: (stateField) => showTooltip.from(stateField, (info): Tooltip | null => info ? {
      pos: info.call.anchor,
      above: false,
      create() {
        const dom = document.createElement('div')
        dom.className = 'cm-parameter-info'
        dom.setAttribute('role', 'tooltip')
        dom.setAttribute('aria-label', `Parameters for ${info.call.name}`)
        if (!info.signatures.length) dom.textContent = 'Loading parameters…'
        for (const signature of info.signatures) {
          const row = document.createElement('div')
          row.className = 'cm-parameter-signature'
          if (!signature.parameters.length) row.textContent = 'No parameters'
          for (const [index, parameter] of signature.parameters.entries()) {
            if (index) row.append(', ')
            const active = index === info.call.argument || (index === signature.parameters.length - 1 && parameter.typeName.endsWith('...') && info.call.argument >= index)
            const span = document.createElement(active ? 'strong' : 'span')
            span.textContent = parameter.typeName + (parameter.name ? ` ${parameter.name}` : '')
            row.append(span)
          }
          dom.append(row)
        }
        return { dom }
      },
    } : null),
  })
  const close = (view: EditorView): boolean => {
    if (!view.state.field(field)) return false
    generation += 1
    view.dispatch({ effects: setInfo.of(null) })
    return true
  }
  const load = (view: EditorView, call: ParameterCall): void => {
    if (destroyed) return
    const source = view.state.doc.toString()
    const currentGeneration = ++generation
    const local = localSignatures(view.state, call)
    const psMethods = readPsLibraryMetadata(view.state)?.methods ?? []
    const psImported = !call.receiver && importLines(source).some((line) => line.static && /(?:^|\.)Ps\.(?:\*|[^.]+)$/.test(line.name) && (line.name.endsWith('.*') || line.name.endsWith(`.${call.name}`)))
    const ps = (call.receiver === 'Ps' || psImported) ? psMethods.filter((method) => method.name === call.name).map((method) => ({ ...method, isStatic: true })) : []
    const initial = local.length ? local : ps
    view.dispatch({ effects: setInfo.of({ call, signatures: initial, source }) })
    if (initial.length || call.receiver === 'this' || call.receiver === 'Ps') {
      if (!initial.length) close(view)
      return
    }
    const importedTypes = !call.receiver ? [...new Set(importLines(source)
      .filter((line) => line.static && (line.name.endsWith(`.${call.name}`) || line.name.endsWith('.*')))
      .map((line) => line.name.slice(0, line.name.lastIndexOf('.'))))] : []
    const resolution = call.receiver
      ? resolveJavaReceiverTypes(source, call.receiver, call.anchor, collectJavaSymbols(source, call.anchor))
      : { kind: importedTypes.length ? 'metadata' : 'unresolved', typeNames: importedTypes, isStatic: true }
    if (!requestJavaTypeMembers || resolution.kind !== 'metadata') {
      close(view)
      return
    }
    void requestJavaTypeMembers(resolution.typeNames).then((metadata) => {
      if (generation !== currentGeneration || !view.state.field(field) || view.state.doc.toString() !== source) return
      const current = javaParameterCallAt(view.state)
      if (!current || current.anchor !== call.anchor || current.name !== call.name || current.receiver !== call.receiver) return
      const signatures = metadata.types.filter((type) => type.available && resolution.typeNames.includes(type.typeName))
        .flatMap((type) => type.methods.filter((method) => method.name === call.name && method.isStatic === resolution.isStatic))
      const unique = [...new Map(signatures.map((signature) => [signature.parameters.map((parameter) => parameter.typeName).join(','), signature])).values()]
      view.dispatch({ effects: setInfo.of(unique.length ? { call: current, signatures: unique, source } : null) })
    }).catch(() => {
      if (generation === currentGeneration && view.state.field(field)) close(view)
    })
  }
  return {
    show(view) {
      const call = javaParameterCallAt(view.state)
      if (!call) { close(view); return false }
      load(view, call)
      return true
    },
    extension: [
      field,
      ViewPlugin.fromClass(class { destroy() { destroyed = true; generation += 1 } }),
      keymap.of([{ key: 'Escape', run: close }]),
      EditorView.domEventHandlers({ blur: (_event, view) => { close(view) } }),
      EditorView.updateListener.of((update) => {
        const info = update.state.field(field)
        if (!info || !update.docChanged || refreshScheduled || destroyed) return
        refreshScheduled = true
        // A listener cannot dispatch during an update; resolve the new source afterward.
        queueMicrotask(() => {
          refreshScheduled = false
          if (destroyed) return
          const current = javaParameterCallAt(update.view.state)
          if (current && update.view.state.field(field)) load(update.view, current)
        })
      }),
      EditorView.baseTheme({
        '.cm-parameter-info': { maxHeight: '280px', maxWidth: 'min(720px, 90vw)', overflow: 'auto', padding: '4px 12px', fontSize: '13px' },
        '.cm-parameter-signature': { padding: '7px 0', whiteSpace: 'nowrap', color: 'var(--text-dim)', borderBottom: '1px solid var(--border)' },
        '.cm-parameter-signature:last-child': { borderBottom: 'none' },
        '.cm-parameter-signature strong': { color: 'var(--text)', fontWeight: '700' },
      }),
    ],
  }
}

import {
  acceptCompletion,
  clearSnippet,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  selectedCompletion,
  snippet,
  startCompletion,
  type Completion,
} from '@codemirror/autocomplete'
import {
  Annotation,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import {
  collectJavaSymbols,
  iterableElementTypeForExpression,
  javaIterableCandidates,
  javaIterableCandidatesFromAnalysis,
  maskJavaCommentsAndLiterals,
} from './source'
import type { JavaSymbolAnalysis } from './source'
import type { JavaIterableCandidate, JavaPrintTemplateKind } from './model'

export type { JavaIterableCandidate, JavaPrintTemplateKind }

type JavaTemplateKind = JavaPrintTemplateKind | 'mod' | 'iter'

const JAVA_TEMPLATE_KINDS = new Set<JavaTemplateKind>(['sout', 'soutv', 'serr', 'serrv', 'mod', 'iter'])

function isJavaTemplateKind(value: string): value is JavaTemplateKind {
  return JAVA_TEMPLATE_KINDS.has(value as JavaTemplateKind)
}

function javaPrintVariable(source: string, position: number): string {
  // Local/parameter symbols are more useful to print than fields. Keep the
  // choice deterministic so an abbreviation expands the same way as a picked
  // completion.
  const symbols = collectJavaSymbols(source, position)
    .filter((symbol) => symbol.scopeStart <= position
      && position <= symbol.scopeEnd
      && (symbol.kind === 'field' || symbol.declaredAt <= position))
    .sort((left, right) => {
      const leftKind = left.kind === 'field' ? 0 : 1
      const rightKind = right.kind === 'field' ? 0 : 1
      return rightKind - leftKind || right.declaredAt - left.declaredAt
    })
  return symbols[0]?.name ?? 'value'
}

function javaPrintTemplateBody(
  kind: JavaTemplateKind,
  variable: string,
  includeSemicolon: boolean,
): string {
  const suffix = includeSemicolon ? ';' : ''
  if (kind === 'mod') {
    return `final int MOD = (int) 1e9 + 7${suffix}`
  }

  const stream = kind.startsWith('sout') ? 'out' : 'err'
  if (!kind.endsWith('v')) {
    return `System.${stream}.println(\${})${suffix}`
  }

  // The two occurrences share snippet field 1. CodeMirror selects the first
  // field on activation, so the inferred variable can be replaced while the
  // string label and the expression stay in sync.
  const field = `\${1:${variable}}`
  return `System.${stream}.println("${field} = " + ${field})${suffix}\${0}`
}

function javaIterTemplateBody(candidate: JavaIterableCandidate | null): string {
  const elementType = candidate?.elementType ?? 'var'
  const variableName = candidate?.variableName ?? 'item'
  const target = candidate?.name ?? 'items'
  // The expression being iterated is the first stop, matching IntelliJ's
  // live-template flow. The type is updated by the extension when the target
  // resolves to a different iterable element type.
  return `for (\${2:${elementType}} \${3:${variableName}} : \${1:${target}}) {\n    \${0}\n}`
}

interface JavaIterTemplateSession {
  targetFrom: number
  targetTo: number
  typeFrom: number
  typeTo: number
  loopFrom: number
  loopTo: number
  bodyFrom: number
  bodyTo: number
  lastAutomaticType: string
  automaticType: boolean
}

const javaIterAutomaticType = Annotation.define<boolean>()
const setJavaIterTemplateSession = StateEffect.define<JavaIterTemplateSession | null>()

function mapIterTemplateRange(
  from: number,
  to: number,
  changes: Transaction['changes'],
): { from: number, to: number } | null {
  const mappedFrom = changes.mapPos(from, -1, MapMode.TrackDel)
  const mappedTo = changes.mapPos(to, 1, MapMode.TrackDel)
  return mappedFrom === null || mappedTo === null ? null : { from: mappedFrom, to: mappedTo }
}

function mapJavaIterTemplateSession(
  session: JavaIterTemplateSession,
  changes: Transaction['changes'],
): JavaIterTemplateSession | null {
  const target = mapIterTemplateRange(session.targetFrom, session.targetTo, changes)
  const type = mapIterTemplateRange(session.typeFrom, session.typeTo, changes)
  const loop = mapIterTemplateRange(session.loopFrom, session.loopTo, changes)
  const body = mapIterTemplateRange(session.bodyFrom, session.bodyTo, changes)
  if (!target || !type || !loop || !body) return null
  return {
    ...session,
    targetFrom: target.from,
    targetTo: target.to,
    typeFrom: type.from,
    typeTo: type.to,
    loopFrom: loop.from,
    loopTo: loop.to,
    bodyFrom: body.from,
    bodyTo: body.to,
  }
}

function selectionInsideIterLoop(
  selection: { ranges: readonly { from: number, to: number }[] },
  session: JavaIterTemplateSession,
): boolean {
  return selection.ranges.every((range) => range.from >= session.loopFrom && range.to <= session.loopTo)
}

function javaIterTemplateTransactionFilter(tr: Transaction): TransactionSpec | readonly TransactionSpec[] | Transaction {
  const session = tr.startState.field(javaIterTemplateState, false)
  if (!session || !tr.docChanged || !tr.changes.touchesRange(session.targetFrom, session.targetTo)) {
    return tr
  }

  // A simultaneous edit of the type field is a deliberate user choice. The
  // state field records that choice below and stops future automatic changes.
  if (tr.changes.touchesRange(session.typeFrom, session.typeTo) || !session.automaticType) {
    return tr
  }

  const mapped = mapJavaIterTemplateSession(session, tr.changes)
  if (!mapped) return tr
  const target = tr.newDoc.sliceString(mapped.targetFrom, mapped.targetTo)
  const desiredType = iterableElementTypeForExpression(tr.newDoc.toString(), target, mapped.targetFrom)
  if (!desiredType) return tr

  const currentType = tr.newDoc.sliceString(mapped.typeFrom, mapped.typeTo)
  if (currentType !== session.lastAutomaticType || currentType === desiredType) return tr
  return [
    tr,
    {
      changes: { from: mapped.typeFrom, to: mapped.typeTo, insert: desiredType },
      sequential: true,
      annotations: javaIterAutomaticType.of(true),
    },
  ]
}

const javaIterTemplateState = StateField.define<JavaIterTemplateSession | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setJavaIterTemplateSession)) return effect.value
    }
    if (!value) return null
    const mapped = tr.docChanged ? mapJavaIterTemplateSession(value, tr.changes) : value
    if (!mapped || (tr.selection && (!selectionInsideIterLoop(tr.newSelection, mapped)
      || tr.newSelection.ranges.every((range) => range.from >= mapped.bodyFrom && range.to <= mapped.bodyTo)))) return null

    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) {
      const target = tr.newDoc.sliceString(mapped.targetFrom, mapped.targetTo)
      const inferred = iterableElementTypeForExpression(tr.newDoc.toString(), target, mapped.targetFrom)
      const currentType = tr.newDoc.sliceString(mapped.typeFrom, mapped.typeTo)
      return {
        ...mapped,
        automaticType: inferred === null || inferred === currentType,
        lastAutomaticType: currentType,
      }
    }

    if (tr.docChanged && tr.changes.touchesRange(value.typeFrom, value.typeTo)
      && tr.annotation(javaIterAutomaticType) !== true) {
      return { ...mapped, automaticType: false }
    }
    if (tr.annotation(javaIterAutomaticType) === true) {
      return {
        ...mapped,
        lastAutomaticType: tr.newDoc.sliceString(mapped.typeFrom, mapped.typeTo),
      }
    }
    return mapped
  },
})

/** State needed to keep an expanded iter target and element type linked. */
export const javaIterTemplateExtension: Extension = [
  javaIterTemplateState,
  EditorState.transactionFilter.of(javaIterTemplateTransactionFilter),
]

/** Finish the active iter template at its body placeholder. */
export function finishJavaIterTemplate(view: EditorView): boolean {
  // Completion's own keymap normally runs first. Keep the same precedence for
  // callers that invoke this command directly, including the short interaction
  // delay during which acceptCompletion may decline an otherwise selected item.
  if (acceptCompletion(view)) return true
  // A selected completion can be temporarily unaccepted during CodeMirror's
  // interaction delay. Keep Enter with the popup until it can be accepted.
  if (completionStatus(view.state) === 'active' && selectedCompletion(view.state)) return true

  const session = view.state.field(javaIterTemplateState, false)
  if (!session
    || !selectionInsideIterLoop(view.state.selection, session)
    // Escape is handled by CodeMirror's private snippet state. If it has
    // already cleared that state, do not let the stale custom session turn a
    // later ordinary Enter into a template finish.
    || (!hasNextSnippetField(view.state) && !hasPrevSnippetField(view.state))) return false

  const bodyPosition = session.bodyFrom
  // clearSnippet removes snippet field ranges; the custom state effect below
  // clears the reactive iter linkage in the same user-visible action.
  clearSnippet(view)
  view.dispatch({
    selection: { anchor: bodyPosition },
    effects: setJavaIterTemplateSession.of(null),
    scrollIntoView: true,
  })
  return true
}

function matchingLoopEnd(source: string, loopFrom: number): number {
  const masked = maskJavaCommentsAndLiterals(source)
  const open = masked.indexOf('{', loopFrom)
  if (open < 0) return source.length
  let depth = 0
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1
    else if (masked[index] === '}' && --depth === 0) return index + 1
  }
  return source.length
}

function registerJavaIterTemplateSession(view: EditorView, from: number): void {
  const state = view.state
  const targetSelection = state.selection.main
  if (state.selection.ranges.length !== 1 || targetSelection.empty) return
  const source = state.doc.toString()
  const loopFrom = source.indexOf('for (', from)
  if (loopFrom < 0) return
  const lineEnd = source.indexOf('\n', loopFrom)
  const header = source.slice(loopFrom, lineEnd < 0 ? source.length : lineEnd)
  const headerMatch = /^for \((.+?)\s+[A-Za-z_$][\w$]*\s*:\s*(.+?)\)\s*\{/.exec(header)
  if (!headerMatch) return
  const parsedTypeFrom = loopFrom + 'for ('.length
  const parsedTypeTo = parsedTypeFrom + headerMatch[1].length
  const bodyLineStart = source.indexOf('\n', loopFrom) + 1
  const bodyIndent = /^[\t ]*/.exec(source.slice(bodyLineStart))?.[0].length ?? 0
  const effects: StateEffect<unknown>[] = [setJavaIterTemplateSession.of({
    targetFrom: targetSelection.from,
    targetTo: targetSelection.to,
    typeFrom: parsedTypeFrom,
    typeTo: parsedTypeTo,
    loopFrom,
    loopTo: matchingLoopEnd(source, loopFrom),
    bodyFrom: bodyLineStart + bodyIndent,
    bodyTo: bodyLineStart + bodyIndent,
    lastAutomaticType: source.slice(parsedTypeFrom, parsedTypeTo),
    automaticType: true,
  })]
  if (state.field(javaIterTemplateState, false) === undefined) {
    effects.unshift(StateEffect.appendConfig.of(javaIterTemplateExtension))
  }
  view.dispatch({ effects })
}

function followingJavaSemicolon(source: string, position: number): boolean {
  return /^[\t ]*;/.test(source.slice(position))
}

function applyJavaPrintTemplate(
  view: EditorView,
  kind: JavaTemplateKind,
  from: number,
  to: number,
  completion: Completion | null,
): void {
  const source = view.state.doc.toString()
  if (kind === 'iter') {
    const candidate = javaIterableCandidates(source, to)[0] ?? null
    snippet(javaIterTemplateBody(candidate))(view, completion, from, to)
    registerJavaIterTemplateSession(view, from)
    return
  }
  const variable = javaPrintVariable(source, to)
  const body = javaPrintTemplateBody(kind, variable, !followingJavaSemicolon(source, to))
  snippet(body)(view, completion, from, to)
}

export function javaPrintCompletion(kind: JavaPrintTemplateKind | 'mod'): Completion {
  if (kind === 'mod') {
    return {
      label: kind,
      type: 'snippet',
      detail: 'Declares the common modulo constant',
      apply: (view, completion, from, to) => applyJavaPrintTemplate(view, kind, from, to, completion),
    }
  }

  const stream = kind.startsWith('sout') ? 'out' : 'err'
  const detail = kind.endsWith('v')
    ? `Prints a value to System.${stream}`
    : `Prints a string to System.${stream}`
  return {
    label: kind,
    type: 'snippet',
    detail,
    apply: (view, completion, from, to) => applyJavaPrintTemplate(view, kind, from, to, completion),
  }
}

export function javaIterCompletion(candidate: JavaIterableCandidate | null, label = 'iter'): Completion {
  const detail = candidate
    ? `Loops over ${candidate.name}${candidate.elementType ? ` (${candidate.elementType})` : ''}`
    : 'Creates an enhanced for loop'
  return {
    label,
    type: 'snippet',
    detail,
    apply: (view, completion, from, to) => {
      snippet(javaIterTemplateBody(candidate))(view, completion, from, to)
      registerJavaIterTemplateSession(view, from)
    },
  }
}

export function javaIterCompletions(
  source: string,
  position: number,
  analysis?: JavaSymbolAnalysis,
): Completion[] {
  const candidates = analysis
    ? javaIterableCandidatesFromAnalysis(source, position, analysis)
    : javaIterableCandidates(source, position)
  if (candidates.length <= 1) {
    return [javaIterCompletion(candidates[0] ?? null)]
  }
  return candidates.map((candidate) => javaIterCompletion(candidate, `iter (${candidate.name})`))
}

function javaPrintAbbreviation(source: string, position: number): { kind: JavaTemplateKind, from: number } | null {
  const before = source.slice(0, position)
  const match = /(?:^|[^A-Za-z0-9_$])((?:soutv|serrv|sout|serr|mod|iter))$/.exec(before)
  if (!match || !isJavaTemplateKind(match[1])) {
    return null
  }
  return { kind: match[1], from: position - match[1].length }
}

/** Expand a Java live-template abbreviation at the current cursor. */
export function expandJavaPrintTemplate(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) {
    return false
  }
  const position = state.selection.main.head
  const source = state.doc.toString()
  const abbreviation = javaPrintAbbreviation(source, position)
  if (!abbreviation) {
    return false
  }

  // Keep abbreviations in comments and literals inert. Masking preserves
  // source offsets, which lets the same range be passed to the snippet API.
  const masked = maskJavaCommentsAndLiterals(source)
  if (masked.slice(abbreviation.from, position) !== source.slice(abbreviation.from, position)) {
    return false
  }
  if (/[A-Za-z0-9_$]/.test(source[position] ?? '')) {
    return false
  }

  // Live templates produce a statement. Requiring the abbreviation to be the
  // only code on its line prevents accidental expansion of `return sout` or a
  // property-like expression while retaining normal indentation.
  const lineStart = source.lastIndexOf('\n', abbreviation.from - 1) + 1
  const linePrefix = source.slice(lineStart, abbreviation.from)
  if (!/^[\t ]*$/.test(linePrefix)) {
    return false
  }

  if (abbreviation.kind === 'iter' && javaIterableCandidates(source, position).length > 1 && startCompletion(view)) {
    return true
  }

  applyJavaPrintTemplate(view, abbreviation.kind, abbreviation.from, position, null)
  return true
}

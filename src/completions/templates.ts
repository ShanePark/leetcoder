import {
  acceptCompletion,
  clearSnippet,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  nextSnippetField,
  selectedCompletion,
  snippet,
  closeCompletion,
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
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'

import {
  collectJavaSymbols,
  iterableElementTypeForExpression,
  javaIterableCandidates,
  javaIterableCandidatesFromAnalysis,
  maskJavaCommentsAndLiterals,
} from './source'
import { importLines } from './imports'
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
  // The expression being iterated is the first stop, matching the configured
  // live-template flow. The type is updated by the extension when the target
  // resolves to a different iterable element type.
  return `for (\${2:${elementType}} \${3:${variableName}} : \${1:${target}}) {\n    \${0}\n}`
}

// The configured `test` template uses fully qualified names in its stored body,
// then shortens them and applies the configured static import. The generated
// problem files already carry those imports, so the editor inserts the same
// shortened form directly.
const JAVA_TEST_TEMPLATE_BODY = '@Test\npublic void \${1}() {\n\tassertThat(\${0})\n}'

const JAVA_TEST_IMPORT = 'org.junit.jupiter.api.Test'
const JAVA_ASSERT_IMPORT = 'org.assertj.core.api.Assertions.assertThat'

interface JavaTestImportChange {
  from: number
  insert: string
}

function hasJavaImport(
  imports: ReturnType<typeof importLines>,
  fullyQualifiedName: string,
  isStatic: boolean,
): boolean {
  const packageName = fullyQualifiedName.slice(0, fullyQualifiedName.lastIndexOf('.'))
  return imports.some((line) => line.static === isStatic
    && (line.name === fullyQualifiedName || line.name === `${packageName}.*`))
}

function javaTestImportChange(source: string): JavaTestImportChange | null {
  const imports = importLines(source)
  const addTest = !hasJavaImport(imports, JAVA_TEST_IMPORT, false)
  const addAssert = !hasJavaImport(imports, JAVA_ASSERT_IMPORT, true)
  if (!addTest && !addAssert) return null

  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const ordinary = imports.filter((line) => !line.static)
  const statics = imports.filter((line) => line.static)
  const ordinaryLines = addTest ? `import ${JAVA_TEST_IMPORT};${newline}` : ''
  const staticLines = addAssert ? `import static ${JAVA_ASSERT_IMPORT};${newline}` : ''

  if (addTest && ordinary.length > 0) {
    const from = statics[0]?.from ?? ordinary.at(-1)!.to
    if (statics.length > 0) {
      return {
        from,
        insert: `${ordinaryLines}${addAssert ? newline + staticLines : ''}`,
      }
    }
    return {
      from,
      insert: `${ordinaryLines}${addAssert ? newline + staticLines : ''}`,
    }
  }

  if (addTest && statics.length > 0) {
    return {
      from: statics[0].from,
      insert: `${ordinaryLines}${addAssert ? newline + staticLines : ''}`,
    }
  }

  if (addAssert && statics.length > 0) {
    return { from: statics.at(-1)!.to, insert: staticLines }
  }

  if (addAssert && ordinary.length > 0) {
    return { from: ordinary.at(-1)!.to, insert: `${newline}${staticLines}` }
  }

  const packageMatch = /^[\t ]*package[\t ]+[\w.]+[\t ]*;[^\S\r\n]*(?:\r?\n|$)/m.exec(source)
  if (packageMatch) {
    return {
      from: packageMatch.index + packageMatch[0].length,
      insert: `${ordinaryLines}${addAssert ? newline + staticLines : ''}`,
    }
  }
  return {
    from: 0,
    insert: `${ordinaryLines}${addAssert ? newline + staticLines : ''}${newline}`,
  }
}

function javaTestAbbreviation(source: string, position: number): { from: number } | null {
  const before = source.slice(0, position)
  const match = /(?:^|[^A-Za-z0-9_$])(test)$/.exec(before)
  if (!match) return null
  return { from: position - match[1].length }
}

function javaDeclarationContext(state: EditorView['state'], position: number): boolean {
  ensureSyntaxTree(state, state.doc.length, 1000)
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(position, 1)
  while (node) {
    if (node.name === 'Block') return false
    if (node.name === 'ClassBody' || node.name === 'InterfaceBody' || node.name === 'EnumBody') {
      return true
    }
    node = node.parent
  }
  return false
}

function applyJavaTestTemplate(
  view: EditorView,
  completion: Completion | null,
  from: number,
  to: number,
): void {
  if (!javaDeclarationContext(view.state, to)) return
  const importChange = javaTestImportChange(view.state.doc.toString())
  if (importChange) {
    view.dispatch({
      changes: { from: importChange.from, insert: importChange.insert },
      userEvent: 'input.complete',
    })
    if (importChange.from <= from) {
      const offset = importChange.insert.length
      from += offset
      to += offset
    }
  }
  snippet(JAVA_TEST_TEMPLATE_BODY)(view, completion, from, to)
}

/** Completion entry for the JUnit test live template. */
export function javaTestCompletion(): Completion {
  return {
    label: 'test',
    type: 'snippet',
    detail: 'Creates a JUnit test method',
    apply: (view, completion, from, to) => applyJavaTestTemplate(view, completion, from, to),
  }
}

interface JavaIterTemplateSession {
  targetFrom: number
  targetTo: number
  typeFrom: number
  typeTo: number
  variableFrom: number
  variableTo: number
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
  const variable = mapIterTemplateRange(session.variableFrom, session.variableTo, changes)
  const loop = mapIterTemplateRange(session.loopFrom, session.loopTo, changes)
  const body = mapIterTemplateRange(session.bodyFrom, session.bodyTo, changes)
  if (!target || !type || !variable || !loop || !body) return null
  return {
    ...session,
    targetFrom: target.from,
    targetTo: target.to,
    typeFrom: type.from,
    typeTo: type.to,
    variableFrom: variable.from,
    variableTo: variable.to,
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

function selectionInsideIterVariable(
  selection: { ranges: readonly { from: number, to: number }[] },
  session: JavaIterTemplateSession,
): boolean {
  return selection.ranges.length === 1
    && selection.ranges.every((range) => range.from >= session.variableFrom && range.to <= session.variableTo)
}

/** Whether the active iter snippet is editing its loop variable name. */
export function isJavaIterVariableNameField(
  state: EditorState,
  position = state.selection.main.head,
): boolean {
  const session = state.field(javaIterTemplateState, false)
  if (!session
    || (!hasNextSnippetField(state) && !hasPrevSnippetField(state))
    || !selectionInsideIterVariable(state.selection, session)) {
    return false
  }
  return position >= session.variableFrom && position <= session.variableTo
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

/**
 * Finish the active live template at its final field.
 *
 * Completion acceptance and snippet navigation share the Enter key in the
 * editor. Once a completion is accepted, advance through the remaining
 * snippet fields in the same command so linked fields cannot receive a
 * newline as multiple cursors.
 */
function finishActiveJavaTemplate(view: EditorView): boolean {
  const session = view.state.field(javaIterTemplateState, false)
  if (session && selectionInsideIterLoop(view.state.selection, session)
    && (hasNextSnippetField(view.state) || hasPrevSnippetField(view.state))) {
    const bodyPosition = session.bodyFrom
    clearSnippet(view)
    view.dispatch({
      selection: { anchor: bodyPosition },
      effects: setJavaIterTemplateSession.of(null),
      scrollIntoView: true,
    })
    return true
  }

  if (hasNextSnippetField(view.state)) {
    while (nextSnippetField(view)) {
      // The last call selects the final field and clears CodeMirror's active
      // snippet state, collapsing linked ranges to one cursor.
    }
    return true
  }

  const cursor = view.state.selection.main.head
  if (!clearSnippet(view)) return false
  if (view.state.selection.ranges.length > 1) {
    view.dispatch({ selection: { anchor: cursor } })
  }
  return true
}

function selectionInsideJavaIterTarget(
  selection: { ranges: readonly { from: number, to: number }[] },
  session: JavaIterTemplateSession,
): boolean {
  return selection.ranges.length === 1
    && selection.ranges.every((range) => range.from >= session.targetFrom && range.to <= session.targetTo)
}

function isJavaIterCompletion(completion: Completion | null): boolean {
  return completion?.label === 'iter' || completion?.label.startsWith('iter (') === true
}

export function finishJavaTemplate(view: EditorView): boolean {
  const iterSessionBeforeAccept = view.state.field(javaIterTemplateState, false)
  const hadActiveSnippetBeforeAccept = hasNextSnippetField(view.state) || hasPrevSnippetField(view.state)
  if (iterSessionBeforeAccept
    && hadActiveSnippetBeforeAccept
    && selectionInsideIterVariable(view.state.selection, iterSessionBeforeAccept)) {
    closeCompletion(view)
    return finishActiveJavaTemplate(view)
  }
  const iterTargetBeforeAccept = iterSessionBeforeAccept
    && selectionInsideJavaIterTarget(view.state.selection, iterSessionBeforeAccept)
  const selectedBeforeAccept = selectedCompletion(view.state)
  if (acceptCompletion(view)) {
    // The target expression is the first stop when an iter template is
    // expanded. Once the user accepts a completion while editing that target,
    // skip the inferred type and select the editable loop variable instead.
    // Keep a newly inserted iter completion on its first target stop so a
    // nested template does not skip its own expression field.
    if (hadActiveSnippetBeforeAccept
      && iterTargetBeforeAccept
      && !isJavaIterCompletion(selectedBeforeAccept)) {
      nextSnippetField(view)
      nextSnippetField(view)
    } else if (hadActiveSnippetBeforeAccept && !iterSessionBeforeAccept) {
      finishActiveJavaTemplate(view)
    }
    return true
  }

  // A selected completion can be temporarily unaccepted during CodeMirror's
  // interaction delay. Keep Enter with the popup until it can be accepted.
  if (completionStatus(view.state) === 'active' && selectedCompletion(view.state)) {
    return true
  }

  return finishActiveJavaTemplate(view)
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
  const headerMatch = /^for \((.+?)\s+([A-Za-z_$][\w$]*)\s*:\s*(.+?)\)\s*\{/.exec(header)
  if (!headerMatch) return
  const parsedTypeFrom = loopFrom + 'for ('.length
  const parsedTypeTo = parsedTypeFrom + headerMatch[1].length
  const variableFrom = parsedTypeTo + (/^[\t ]*/.exec(source.slice(parsedTypeTo))?.[0].length ?? 0)
  const variableTo = variableFrom + headerMatch[2].length
  const bodyLineStart = source.indexOf('\n', loopFrom) + 1
  const bodyIndent = /^[\t ]*/.exec(source.slice(bodyLineStart))?.[0].length ?? 0
  const effects: StateEffect<unknown>[] = [setJavaIterTemplateSession.of({
    targetFrom: targetSelection.from,
    targetTo: targetSelection.to,
    typeFrom: parsedTypeFrom,
    typeTo: parsedTypeTo,
    variableFrom,
    variableTo,
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

  applyJavaPrintTemplate(view, abbreviation.kind, abbreviation.from, position, null)
  return true
}

/** Expand the `test` live-template abbreviation at a class declaration. */
export function expandJavaTestTemplate(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) {
    return false
  }
  const position = state.selection.main.head
  const source = state.doc.toString()
  const abbreviation = javaTestAbbreviation(source, position)
  if (!abbreviation || !javaDeclarationContext(state, abbreviation.from)) {
    return false
  }

  const masked = maskJavaCommentsAndLiterals(source)
  if (masked.slice(abbreviation.from, position) !== source.slice(abbreviation.from, position)) {
    return false
  }
  if (/[A-Za-z0-9_$]/.test(source[position] ?? '')) {
    return false
  }

  const lineStart = source.lastIndexOf('\n', abbreviation.from - 1) + 1
  const linePrefix = source.slice(lineStart, abbreviation.from)
  if (!/^[\t ]*$/.test(linePrefix)) {
    return false
  }

  applyJavaTestTemplate(view, null, abbreviation.from, position)
  return true
}

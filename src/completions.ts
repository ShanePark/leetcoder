import {
  acceptCompletion,
  clearSnippet,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  pickedCompletion,
  selectedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
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

/**
 * This is intentionally a small, source-text based completion provider.  It is
 * not intended to replace a Java language server.  The editor only needs the
 * handful of JDK/AssertJ APIs used repeatedly while solving LeetCode problems.
 */

export interface JavaSymbol {
  name: string
  /** All useful views of a value.  For example `List` declared with
   * `new ArrayList<>()` has both `List` and `ArrayList` here. */
  bases: string[]
  /** The source declaration type, used to avoid treating an Object as iterable. */
  declaredType?: string
  /** The declared element type when this value is an array or generic iterable. */
  elementType?: string
  kind: 'field' | 'parameter' | 'local'
  declaredAt: number
  scopeStart: number
  scopeEnd: number
}

export interface JavaMethod {
  name: string
  parameters: string[]
  declaredAt: number
  /** Exact source range of the method name, used by definition navigation. */
  nameStart: number
  nameEnd: number
}

export interface JavaIdentifier {
  name: string
  from: number
  to: number
}

export interface JavaDefinition {
  name: string
  /** Exact source range of the declaration name. */
  from: number
  to: number
  parameters: string[]
  declaredAt: number
}

interface MethodSpec {
  name: string
  parameters?: string[]
  detail?: string
}

interface DotContext {
  receiver: string
  from: number
  assertJ: boolean
}

interface ReceiverResolution {
  bases: string[]
  static: boolean
  unknown: boolean
  primitive: boolean
  array: boolean
  thisReceiver: boolean
}

const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new', 'null',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var', 'void',
  'volatile', 'while',
]

const JAVA_TYPES = [
  'ArrayDeque', 'ArrayList', 'Arrays', 'BigDecimal', 'BigInteger', 'Boolean', 'Byte', 'Character',
  'Collections', 'Comparator', 'Deque', 'Double', 'Float', 'HashMap', 'HashSet', 'Integer',
  'InputStream', 'Iterable', 'Iterator', 'LinkedHashMap', 'LinkedHashSet', 'LinkedList', 'List', 'Long', 'Map',
  'Math', 'Object', 'PrintStream', 'PriorityQueue', 'Queue', 'Set', 'Short', 'Stack', 'String', 'StringBuilder',
  'StringBuffer', 'System', 'TreeMap', 'TreeSet',
]

export const JAVA_TYPE_IMPORTS: Readonly<Record<string, string>> = {
  ArrayDeque: 'java.util.ArrayDeque',
  ArrayList: 'java.util.ArrayList',
  Arrays: 'java.util.Arrays',
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  Collections: 'java.util.Collections',
  Comparator: 'java.util.Comparator',
  Deque: 'java.util.Deque',
  HashMap: 'java.util.HashMap',
  HashSet: 'java.util.HashSet',
  InputStream: 'java.io.InputStream',
  Iterator: 'java.util.Iterator',
  LinkedHashMap: 'java.util.LinkedHashMap',
  LinkedHashSet: 'java.util.LinkedHashSet',
  LinkedList: 'java.util.LinkedList',
  List: 'java.util.List',
  Map: 'java.util.Map',
  PrintStream: 'java.io.PrintStream',
  PriorityQueue: 'java.util.PriorityQueue',
  Queue: 'java.util.Queue',
  Set: 'java.util.Set',
  Stack: 'java.util.Stack',
  TreeMap: 'java.util.TreeMap',
  TreeSet: 'java.util.TreeSet',
}

export interface ImportLine {
  name: string
  static: boolean
  from: number
  to: number
}

export function importLines(source: string): ImportLine[] {
  const lines: ImportLine[] = []
  const pattern = /^[\t ]*import[\t ]+(static[\t ]+)?([\w.*]+)[\t ]*;[^\S\r\n]*(?:\r?\n|$)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    lines.push({
      name: match[2],
      static: Boolean(match[1]),
      from: match.index,
      to: match.index + match[0].length,
    })
  }
  return lines
}

function localTypeDeclared(source: string, typeName: string): boolean {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(?:class|interface|enum|record)\\s+${escaped}\\b`).test(maskJavaCommentsAndLiterals(source))
}

function importInsertion(source: string, fullyQualifiedName: string): { from: number, insert: string } | null {
  const packageName = fullyQualifiedName.slice(0, fullyQualifiedName.lastIndexOf('.'))
  const typeName = fullyQualifiedName.slice(fullyQualifiedName.lastIndexOf('.') + 1)
  const imports = importLines(source)
  if (imports.some((line) => !line.static && (line.name === fullyQualifiedName || line.name === `${packageName}.*`))) {
    return null
  }
  if (imports.some((line) => !line.static && !line.name.endsWith('.*') && line.name.split('.').at(-1) === typeName)) {
    return null
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const ordinaryImports = imports.filter((line) => !line.static)
  const followingImport = ordinaryImports.find((line) => line.name.localeCompare(fullyQualifiedName) > 0)
  if (followingImport) {
    return { from: followingImport.from, insert: `import ${fullyQualifiedName};${newline}` }
  }
  if (ordinaryImports.length > 0) {
    const lastImport = ordinaryImports.at(-1)!
    const prefix = lastImport.to === source.length || !source.slice(lastImport.from, lastImport.to).endsWith('\n') ? newline : ''
    return { from: lastImport.to, insert: `${prefix}import ${fullyQualifiedName};${newline}` }
  }

  const firstStaticImport = imports.find((line) => line.static)
  if (firstStaticImport) {
    return { from: firstStaticImport.from, insert: `import ${fullyQualifiedName};${newline}${newline}` }
  }

  const packageMatch = /^[\t ]*package[\t ]+[\w.]+[\t ]*;[^\S\r\n]*(?:\r?\n|$)/m.exec(source)
  if (packageMatch) {
    const afterPackage = packageMatch.index + packageMatch[0].length
    let firstCode = afterPackage
    while (firstCode < source.length && /\s/.test(source[firstCode])) firstCode += 1
    const separator = source.slice(afterPackage, firstCode).includes('\n') ? '' : newline
    return { from: firstCode, insert: `${separator}import ${fullyQualifiedName};${newline}${newline}` }
  }
  return { from: 0, insert: `import ${fullyQualifiedName};${newline}${newline}` }
}

export function addJavaTypeImports(source: string, typeNames: Iterable<string>): string {
  const imports = [...new Set(typeNames)]
    .map((typeName) => ({ typeName, fullyQualifiedName: JAVA_TYPE_IMPORTS[typeName] }))
    .filter((candidate): candidate is { typeName: string; fullyQualifiedName: string } => Boolean(candidate.fullyQualifiedName))
    .sort((left, right) => left.fullyQualifiedName.localeCompare(right.fullyQualifiedName))

  let updated = source
  for (const { typeName, fullyQualifiedName } of imports) {
    if (localTypeDeclared(updated, typeName)) continue
    const insertion = importInsertion(updated, fullyQualifiedName)
    if (!insertion) continue
    updated = `${updated.slice(0, insertion.from)}${insertion.insert}${updated.slice(insertion.from)}`
  }
  return updated
}

function applyJavaType(fullyQualifiedName: string): Completion['apply'] {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const source = view.state.doc.toString()
    const typeName = fullyQualifiedName.slice(fullyQualifiedName.lastIndexOf('.') + 1)
    const maskedSelection = maskJavaCommentsAndLiterals(source).slice(from, to)
    const selectionIsCode = maskedSelection === source.slice(from, to)
    const insertion = selectionIsCode && !localTypeDeclared(source, typeName)
      ? importInsertion(source, fullyQualifiedName)
      : null
    const changes = insertion
      ? [{ from: insertion.from, insert: insertion.insert }, { from, to, insert: completion.label }]
      : [{ from, to, insert: completion.label }]
    const importOffset = insertion && insertion.from <= from ? insertion.insert.length : 0
    view.dispatch({
      changes,
      selection: { anchor: from + completion.label.length + importOffset },
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
      userEvent: 'input.complete',
    })
  }
}

export type JavaPrintTemplateKind = 'sout' | 'soutv' | 'serr' | 'serrv'

type JavaTemplateKind = JavaPrintTemplateKind | 'mod' | 'iter'

const JAVA_TEMPLATE_KINDS = new Set<JavaTemplateKind>(['sout', 'soutv', 'serr', 'serrv', 'mod', 'iter'])

function isJavaTemplateKind(value: string): value is JavaTemplateKind {
  return JAVA_TEMPLATE_KINDS.has(value as JavaTemplateKind)
}

export interface JavaIterableCandidate {
  name: string
  elementType?: string
  variableName: string
}

function visibleJavaSymbols(symbols: JavaSymbol[], position: number): JavaSymbol[] {
  const visible = symbols.filter((symbol) => symbol.scopeStart <= position
    && position <= symbol.scopeEnd
    && (symbol.kind === 'field' || symbol.declaredAt <= position))
  const byName = new Map<string, JavaSymbol>()
  for (const symbol of visible) {
    const current = byName.get(symbol.name)
    if (!current) {
      byName.set(symbol.name, symbol)
      continue
    }
    const symbolWidth = symbol.scopeEnd - symbol.scopeStart
    const currentWidth = current.scopeEnd - current.scopeStart
    if (symbolWidth < currentWidth || (symbolWidth === currentWidth && symbol.declaredAt > current.declaredAt)) {
      byName.set(symbol.name, symbol)
    }
  }
  return [...byName.values()]
}

const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = {
  children: 'child',
  feet: 'foot',
  geese: 'goose',
  indices: 'index',
  matrices: 'matrix',
  men: 'man',
  people: 'person',
  teeth: 'tooth',
  vertices: 'vertex',
  women: 'woman',
}

function singularIdentifier(name: string): string {
  const match = /^(.*?)([A-Za-z_$][\w$]*)$/.exec(name)
  if (!match) return name
  const prefix = match[1]
  const word = match[2]
  const lower = word.toLowerCase()
  const irregular = IRREGULAR_SINGULARS[lower]
  if (irregular) return `${prefix}${irregular}`
  if (lower.endsWith('ies') && word.length > 3) return `${prefix}${word.slice(0, -3)}y`
  if (lower.endsWith('ses') && word.length > 3) return `${prefix}${word.slice(0, -2)}`
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) {
    return `${prefix}${word.slice(0, -1)}`
  }
  return name
}

function typeVariableName(elementType: string | undefined): string {
  if (!elementType) return 'item'
  if (elementType.endsWith('[]')) return 'row'
  const base = simpleTypeName(elementType.replace(/<.*>/, ''))
  if (!base) return 'item'
  const candidate = `${base[0].toLowerCase()}${base.slice(1)}`
  return JAVA_KEYWORDS.includes(candidate) ? 'item' : candidate
}

function uniqueVariableName(base: string, symbols: JavaSymbol[], position: number): string {
  if (JAVA_KEYWORDS.includes(base)) base = 'item'
  const used = new Set(visibleJavaSymbols(symbols, position).map((symbol) => symbol.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}${suffix}`)) suffix += 1
  return `${base}${suffix}`
}

function iterVariableName(target: string, elementType: string | undefined, symbols: JavaSymbol[], position: number): string {
  const targetName = target.split('.').at(-1) ?? target
  const singular = singularIdentifier(targetName)
  const base = singular !== targetName ? singular : typeVariableName(elementType)
  return uniqueVariableName(base || 'item', symbols, position)
}

function isIterableSymbol(symbol: JavaSymbol): boolean {
  const declaredType = symbol.declaredType
  if (declaredType && declaredType !== 'var') {
    // The declared type controls whether enhanced-for is legal.  Initializer
    // bases are still collected for member completion, so they must not make
    // an `Object` or other unrelated declaration look iterable here.
    if (declaredType.includes('[]')) return symbol.bases.includes('array')
    if (!isIterableType(declaredType)) return false
  }
  return symbol.bases.includes('array') || symbol.bases.includes('Iterable')
}

/** Return iterable values visible at a Java cursor, with loop defaults inferred. */
export function javaIterableCandidates(source: string, position = source.length): JavaIterableCandidate[] {
  const symbols = collectJavaSymbols(source, position)
  const masked = maskJavaCommentsAndLiterals(source)
  const codeSymbols = symbols.filter((symbol) => masked.slice(symbol.declaredAt, symbol.declaredAt + symbol.name.length)
    === source.slice(symbol.declaredAt, symbol.declaredAt + symbol.name.length))
  return visibleJavaSymbols(codeSymbols, position)
    .filter(isIterableSymbol)
    .sort((left, right) => {
      const leftKind = left.kind === 'field' ? 0 : 1
      const rightKind = right.kind === 'field' ? 0 : 1
      return rightKind - leftKind || right.declaredAt - left.declaredAt
    })
    .map((symbol) => ({
      name: symbol.name,
      ...(symbol.elementType ? { elementType: symbol.elementType } : {}),
      variableName: iterVariableName(symbol.name, symbol.elementType, codeSymbols, position),
    }))
}

function javaPrintVariable(source: string, position: number): string {
  const symbols = collectJavaSymbols(source, position)
  const visible = symbols
    .filter((symbol) => symbol.scopeStart <= position
      && position <= symbol.scopeEnd
      && (symbol.kind === 'field' || symbol.declaredAt <= position))
    .sort((left, right) => {
      // A local or parameter is more useful to print than a field. Among
      // equally useful symbols the latest declaration is the best default.
      const leftKind = left.kind === 'field' ? 0 : 1
      const rightKind = right.kind === 'field' ? 0 : 1
      return rightKind - leftKind || right.declaredAt - left.declaredAt
    })
  return visible[0]?.name ?? 'value'
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
  // live template flow.  The type is updated by javaIterTemplateExtension
  // when that expression resolves to a different iterable element type.
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

function iterableElementTypeForExpression(source: string, target: string, position: number): string | null {
  const expression = target.trim()
  if (!expression) return null

  const symbols = visibleJavaSymbols(collectJavaSymbols(source, position), position)
  const simpleTarget = /^([A-Za-z_$][\w$]*)$/.exec(expression)
  if (simpleTarget) {
    const symbol = symbols.find((candidate) => candidate.name === simpleTarget[1])
    if (symbol && isIterableSymbol(symbol)) return symbol.elementType ?? 'var'
    return null
  }

  // String#toCharArray is the one expression form that is especially useful
  // while solving LeetCode string problems and has an unambiguous char type.
  const chars = /^([A-Za-z_$][\w$]*)\s*\.\s*toCharArray\s*\(\s*\)$/.exec(expression)
  if (!chars) return null
  const symbol = symbols.find((candidate) => candidate.name === chars[1])
  if (!symbol) return null
  const declaredType = symbol.declaredType
  if (declaredType && declaredType !== 'var') {
    return !declaredType.includes('[]') && simpleTypeName(baseType(declaredType)) === 'String' ? 'char' : null
  }
  return declaredType === 'var' && symbol.bases.includes('String') ? 'char' : null
}

function javaIterTemplateTransactionFilter(tr: Transaction): TransactionSpec | readonly TransactionSpec[] | Transaction {
  const session = tr.startState.field(javaIterTemplateState, false)
  if (!session || !tr.docChanged || !tr.changes.touchesRange(session.targetFrom, session.targetTo)) {
    return tr
  }

  // A simultaneous edit of the type field is a deliberate user choice.  The
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

/**
 * Finish the active iter template at its body placeholder. Enter should act
 * as live-template confirmation while the template is active, then return to
 * ordinary editor behavior once the session is cleared.
 */
export function finishJavaIterTemplate(view: EditorView): boolean {
  // Completion's own keymap normally runs first. Keep the same precedence for
  // callers that invoke this command directly, including the short interaction
  // delay during which acceptCompletion may decline an otherwise selected item.
  if (acceptCompletion(view)) return true
  // A selected completion can be temporarily unaccepted during CodeMirror's
  // interaction delay. Keep Enter with the popup until it can be accepted;
  // otherwise it could finish the iter template and lose the user's choice.
  if (completionStatus(view.state) === 'active' && selectedCompletion(view.state)) return true

  const session = view.state.field(javaIterTemplateState, false)
  if (!session
    || !selectionInsideIterLoop(view.state.selection, session)
    // Escape is handled by CodeMirror's private snippet state. If it has
    // already cleared that state, do not let the stale custom session turn a
    // later ordinary Enter into a template finish.
    || (!hasNextSnippetField(view.state) && !hasPrevSnippetField(view.state))) return false

  const bodyPosition = session.bodyFrom
  // snippetState is intentionally private to CodeMirror. clearSnippet removes
  // its field ranges; the custom state effect below clears the reactive iter
  // linkage in the same user-visible action without changing the document.
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

function javaPrintCompletion(kind: JavaPrintTemplateKind | 'mod'): Completion {
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

function javaIterCompletion(candidate: JavaIterableCandidate | null, label = 'iter'): Completion {
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

function javaIterCompletions(source: string, position: number): Completion[] {
  const candidates = javaIterableCandidates(source, position)
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

const JAVA_COMPLETIONS: Completion[] = [
  ...JAVA_KEYWORDS.map((label) => ({ label, type: 'keyword' as const })),
  ...JAVA_TYPES.map((label) => ({
    label,
    type: 'type' as const,
    apply: JAVA_TYPE_IMPORTS[label] ? applyJavaType(JAVA_TYPE_IMPORTS[label]) : label,
  })),
  methodCompletion({ name: 'assertThat', parameters: ['value'], detail: 'AssertJ' }, 'function'),
  snippetCompletion('assertThat(...).isEqualTo(...)', 'AssertJ', 'assertThat(${actual}).isEqualTo(${expected})'),
  snippetCompletion('assertThat(...).isTrue()', 'AssertJ', 'assertThat(${actual}).isTrue()'),
  snippetCompletion('assertThat(...).isFalse()', 'AssertJ', 'assertThat(${actual}).isFalse()'),
  snippetCompletion('List.of(...)', 'List', 'List.of(${items})'),
  snippetCompletion('Map.of(...)', 'Map', 'Map.of(${entries})'),
  snippetCompletion('Set.of(...)', 'Set', 'Set.of(${items})'),
  javaPrintCompletion('sout'),
  javaPrintCompletion('soutv'),
  javaPrintCompletion('serr'),
  javaPrintCompletion('serrv'),
  javaPrintCompletion('mod'),
  snippetCompletion('new ArrayList<>()', 'ArrayList', 'new ArrayList<>()'),
  snippetCompletion('new HashMap<>()', 'HashMap', 'new HashMap<>()'),
  snippetCompletion('for (int i = 0; i < ...; i++)', 'loop', 'for (int ${i} = 0; ${i} < ${length}; ${i}++) {\n    ${}\n}'),
  snippetCompletion('for (var item : ...)', 'loop', 'for (var ${item} : ${items}) {\n    ${}\n}'),
]

const CATALOG: Record<string, MethodSpec[]> = {
  Iterable: specs([
    ['forEach', ['action']], ['iterator'], ['spliterator'], ['stream'], ['parallelStream'],
  ]),
  Collection: specs([
    ['add', ['element']], ['addAll', ['collection']], ['clear'], ['contains', ['object']],
    ['containsAll', ['collection']], ['isEmpty'], ['remove', ['object']], ['removeAll', ['collection']],
    ['removeIf', ['filter']], ['retainAll', ['collection']], ['size'], ['toArray'], ['toArray', ['array']],
    ['stream'], ['parallelStream'], ['equals', ['object']], ['hashCode'],
  ]),
  List: specs([
    ['add', ['element']], ['add', ['index', 'element']], ['addAll', ['collection']],
    ['addAll', ['index', 'collection']], ['clear'], ['contains', ['object']], ['containsAll', ['collection']],
    ['get', ['index']], ['indexOf', ['object']], ['isEmpty'], ['iterator'], ['lastIndexOf', ['object']],
    ['listIterator'], ['listIterator', ['index']], ['remove', ['index']], ['remove', ['object']],
    ['removeAll', ['collection']], ['removeIf', ['filter']], ['replaceAll', ['operator']], ['retainAll', ['collection']],
    ['set', ['index', 'element']], ['size'], ['sort', ['comparator']], ['subList', ['fromIndex', 'toIndex']],
    ['toArray'], ['toArray', ['array']], ['spliterator'], ['stream'], ['parallelStream'], ['equals', ['object']],
    ['hashCode'],
  ]),
  Map: specs([
    ['clear'], ['compute', ['key', 'remappingFunction']], ['computeIfAbsent', ['key', 'mappingFunction']],
    ['computeIfPresent', ['key', 'remappingFunction']], ['containsKey', ['key']], ['containsValue', ['value']],
    ['entrySet'], ['equals', ['object']], ['forEach', ['action']], ['get', ['key']],
    ['getOrDefault', ['key', 'defaultValue']], ['hashCode'], ['isEmpty'], ['keySet'], ['merge', ['key', 'value', 'remappingFunction']],
    ['put', ['key', 'value']], ['putAll', ['map']], ['putIfAbsent', ['key', 'value']], ['remove', ['key']],
    ['remove', ['key', 'value']], ['replace', ['key', 'value']], ['replace', ['key', 'oldValue', 'newValue']],
    ['replaceAll', ['function']], ['size'], ['values'],
  ]),
  Set: specs([
    ['add', ['element']], ['addAll', ['collection']], ['clear'], ['contains', ['object']],
    ['containsAll', ['collection']], ['isEmpty'], ['iterator'], ['remove', ['object']], ['removeAll', ['collection']],
    ['removeIf', ['filter']], ['retainAll', ['collection']], ['size'], ['toArray'], ['toArray', ['array']],
    ['stream'], ['parallelStream'], ['spliterator'], ['equals', ['object']], ['hashCode'],
  ]),
  Queue: specs([
    ['add', ['element']], ['element'], ['offer', ['element']], ['peek'], ['poll'], ['remove'],
    ['remove', ['object']], ['size'], ['isEmpty'], ['contains', ['object']], ['iterator'], ['toArray'],
    ['clear'], ['stream'], ['parallelStream'],
  ]),
  Deque: specs([
    ['addFirst', ['element']], ['addLast', ['element']], ['offerFirst', ['element']], ['offerLast', ['element']],
    ['getFirst'], ['getLast'], ['peekFirst'], ['peekLast'], ['pollFirst'], ['pollLast'], ['removeFirst'],
    ['removeLast'], ['removeFirstOccurrence', ['object']], ['removeLastOccurrence', ['object']], ['add', ['element']],
    ['offer', ['element']], ['remove'], ['poll'], ['element'], ['peek'], ['push', ['element']], ['pop'],
    ['descendingIterator'], ['iterator'], ['size'], ['isEmpty'], ['contains', ['object']], ['clear'],
  ]),
  String: specs([
    ['length'], ['isEmpty'], ['isBlank'], ['charAt', ['index']], ['codePointAt', ['index']], ['codePointCount', ['beginIndex', 'endIndex']],
    ['compareTo', ['anotherString']], ['compareToIgnoreCase', ['str']], ['concat', ['str']], ['contains', ['sequence']],
    ['contentEquals', ['sequence']], ['endsWith', ['suffix']], ['equals', ['object']], ['equalsIgnoreCase', ['anotherString']],
    ['getBytes'], ['getBytes', ['charset']], ['getChars', ['srcBegin', 'srcEnd', 'dst', 'dstBegin']], ['hashCode'],
    ['indexOf', ['str']], ['indexOf', ['str', 'fromIndex']], ['intern'], ['lastIndexOf', ['str']],
    ['lines'], ['matches', ['regex']], ['regionMatches', ['toffset', 'other', 'ooffset', 'len']], ['repeat', ['count']],
    ['replace', ['target', 'replacement']], ['replaceAll', ['regex', 'replacement']], ['replaceFirst', ['regex', 'replacement']],
    ['split', ['regex']], ['split', ['regex', 'limit']], ['startsWith', ['prefix']], ['strip'], ['stripIndent'], ['stripLeading'],
    ['stripTrailing'], ['substring', ['beginIndex']], ['substring', ['beginIndex', 'endIndex']], ['toCharArray'], ['toLowerCase'],
    ['toString'], ['toUpperCase'], ['trim'], ['formatted', ['args']], ['transform', ['function']],
  ]),
  StringBuilder: specs([
    ['append', ['value']], ['appendCodePoint', ['codePoint']], ['capacity'], ['charAt', ['index']], ['codePoints'],
    ['codePointAt', ['index']], ['codePointBefore', ['index']], ['delete', ['start', 'end']], ['deleteCharAt', ['index']],
    ['ensureCapacity', ['minimumCapacity']], ['getChars', ['srcBegin', 'srcEnd', 'dst', 'dstBegin']], ['indexOf', ['str']],
    ['indexOf', ['str', 'fromIndex']], ['insert', ['offset', 'value']], ['lastIndexOf', ['str']], ['length'],
    ['offsetByCodePoints', ['index', 'codePointOffset']], ['replace', ['start', 'end', 'str']], ['reverse'],
    ['setCharAt', ['index', 'ch']], ['setLength', ['newLength']], ['subSequence', ['start', 'end']],
    ['substring', ['start']], ['substring', ['start', 'end']], ['toString'], ['trimToSize'],
  ]),
  Character: specs([
    ['charValue'], ['compareTo', ['another']], ['equals', ['object']], ['hashCode'], ['toString'],
  ]),
  Integer: numberInstanceMethods('int'),
  Long: numberInstanceMethods('long'),
  Double: numberInstanceMethods('double'),
  Float: numberInstanceMethods('float'),
  Short: numberInstanceMethods('short'),
  Byte: numberInstanceMethods('byte'),
  Boolean: specs([
    ['booleanValue'], ['toString'],
  ]),
  PrintStream: specs([
    ['print'], ['print', ['value']], ['print', ['booleanValue']], ['print', ['charValue']], ['print', ['intValue']],
    ['print', ['longValue']], ['print', ['floatValue']], ['print', ['doubleValue']], ['print', ['text']],
    ['println'], ['println', ['value']], ['println', ['booleanValue']], ['println', ['charValue']], ['println', ['intValue']],
    ['println', ['longValue']], ['println', ['floatValue']], ['println', ['doubleValue']], ['println', ['text']],
    ['printf', ['format', 'args']], ['format', ['format', 'args']], ['append', ['value']], ['append', ['charValue']],
    ['append', ['sequence', 'start', 'end']], ['flush'], ['close'], ['checkError'], ['write', ['value']],
    ['write', ['buffer', 'offset', 'length']], ['writeBytes', ['buffer']],
  ]),
  InputStream: specs([
    ['available'], ['close'], ['mark', ['readLimit']], ['markSupported'], ['read'], ['read', ['buffer']],
    ['read', ['buffer', 'offset', 'length']], ['readAllBytes'], ['readNBytes', ['length']],
    ['readNBytes', ['buffer', 'offset', 'length']], ['reset'], ['skip', ['count']], ['transferTo', ['out']],
  ]),
}

const TYPE_GROUPS: Record<string, string[]> = {
  Collection: ['Collection', 'Iterable'], Iterable: ['Iterable'],
  ArrayList: ['ArrayList', 'List', 'Collection', 'Iterable'],
  LinkedList: ['LinkedList', 'List', 'Deque', 'Queue', 'Collection', 'Iterable'],
  Stack: ['Stack', 'List', 'Collection', 'Iterable'],
  HashMap: ['HashMap', 'Map'], LinkedHashMap: ['LinkedHashMap', 'HashMap', 'Map'], TreeMap: ['TreeMap', 'Map'],
  HashSet: ['HashSet', 'Set', 'Collection', 'Iterable'], LinkedHashSet: ['LinkedHashSet', 'HashSet', 'Set', 'Collection', 'Iterable'],
  TreeSet: ['TreeSet', 'Set', 'Collection', 'Iterable'],
  ArrayDeque: ['ArrayDeque', 'Deque', 'Queue', 'Collection', 'Iterable'], PriorityQueue: ['PriorityQueue', 'Queue', 'Collection', 'Iterable'],
  List: ['List', 'Collection', 'Iterable'], Set: ['Set', 'Collection', 'Iterable'], Queue: ['Queue', 'Collection', 'Iterable'],
  Deque: ['Deque', 'Queue', 'Collection', 'Iterable'],
}

const STATIC_CATALOG: Record<string, MethodSpec[]> = {
  List: specs([
    ['of'], ['of', ['element']], ['of', ['e1', 'e2']], ['of', ['elements']], ['copyOf', ['collection']],
  ]),
  Set: specs([
    ['of'], ['of', ['element']], ['of', ['e1', 'e2']], ['of', ['elements']], ['copyOf', ['collection']],
  ]),
  Map: specs([
    ['of'], ['of', ['key', 'value']], ['of', ['k1', 'v1', 'k2', 'v2']], ['ofEntries', ['entries']], ['copyOf', ['map']],
  ]),
  String: specs([
    ['copyValueOf', ['data']], ['format', ['format', 'args']], ['join', ['delimiter', 'elements']], ['valueOf', ['value']],
  ]),
  Arrays: specs([
    ['asList', ['array']], ['binarySearch', ['array', 'key']], ['copyOf', ['original', 'newLength']],
    ['copyOfRange', ['original', 'from', 'to']], ['deepEquals', ['a1', 'a2']], ['deepHashCode', ['a']],
    ['deepToString', ['a']], ['equals', ['a', 'a2']], ['fill', ['array', 'value']], ['hashCode', ['a']],
    ['mismatch', ['a', 'a2']], ['parallelPrefix', ['array', 'op']], ['parallelSort', ['array']], ['setAll', ['array', 'generator']],
    ['sort', ['array']], ['spliterator', ['array']], ['stream', ['array']], ['toString', ['array']],
  ]),
  Collections: specs([
    ['addAll', ['collection', 'elements']], ['binarySearch', ['list', 'key']], ['copy', ['dest', 'src']],
    ['disjoint', ['c1', 'c2']], ['emptyList'], ['emptyMap'], ['emptySet'], ['fill', ['list', 'object']],
    ['frequency', ['collection', 'object']], ['indexOfSubList', ['source', 'target']], ['lastIndexOfSubList', ['source', 'target']],
    ['max', ['collection']], ['min', ['collection']], ['nCopies', ['n', 'object']], ['replaceAll', ['list', 'oldValue', 'newValue']],
    ['reverse', ['list']], ['reverseOrder'], ['rotate', ['list', 'distance']], ['shuffle', ['list']], ['singleton', ['object']],
    ['singletonList', ['object']], ['sort', ['list']], ['swap', ['list', 'i', 'j']], ['unmodifiableCollection', ['collection']],
    ['unmodifiableList', ['list']], ['unmodifiableMap', ['map']], ['unmodifiableSet', ['set']],
  ]),
  Math: specs([
    ['abs', ['value']], ['acos', ['value']], ['asin', ['value']], ['atan', ['value']], ['atan2', ['y', 'x']],
    ['cbrt', ['value']], ['ceil', ['value']], ['copySign', ['magnitude', 'sign']], ['cos', ['value']],
    ['decrementExact', ['value']], ['exp', ['value']], ['expm1', ['value']], ['floor', ['value']],
    ['floorDiv', ['x', 'y']], ['floorMod', ['x', 'y']], ['getExponent', ['value']], ['hypot', ['x', 'y']],
    ['incrementExact', ['value']], ['log', ['value']], ['log10', ['value']], ['log1p', ['value']], ['max', ['a', 'b']],
    ['min', ['a', 'b']], ['multiplyExact', ['x', 'y']], ['negateExact', ['value']], ['nextAfter', ['start', 'direction']],
    ['nextDown', ['value']], ['nextUp', ['value']], ['pow', ['a', 'b']], ['random'], ['round', ['value']],
    ['scalb', ['d', 'scaleFactor']], ['signum', ['value']], ['sin', ['value']], ['sqrt', ['value']],
    ['subtractExact', ['x', 'y']], ['tan', ['value']], ['toDegrees', ['value']], ['toIntExact', ['value']],
    ['toRadians', ['value']], ['ulp', ['value']],
  ]),
  Character: specs([
    ['charCount', ['codePoint']], ['codePointAt', ['seq', 'index']], ['codePointBefore', ['seq', 'index']],
    ['digit', ['ch', 'radix']], ['forDigit', ['digit', 'radix']], ['getNumericValue', ['ch']], ['highSurrogate', ['codePoint']],
    ['isAlphabetic', ['codePoint']], ['isBmpCodePoint', ['codePoint']], ['isDigit', ['ch']], ['isHighSurrogate', ['ch']],
    ['isLetter', ['ch']], ['isLetterOrDigit', ['ch']], ['isLowerCase', ['ch']], ['isLowSurrogate', ['ch']],
    ['isSpaceChar', ['ch']], ['isSupplementaryCodePoint', ['codePoint']], ['isSurrogate', ['ch']], ['isTitleCase', ['ch']],
    ['isUpperCase', ['ch']], ['isValidCodePoint', ['codePoint']], ['isWhitespace', ['ch']], ['lowSurrogate', ['codePoint']],
    ['toChars', ['codePoint']], ['toCodePoint', ['high', 'low']], ['toLowerCase', ['ch']], ['toTitleCase', ['ch']], ['toUpperCase', ['ch']],
  ]),
  Integer: numberStaticMethods('int'), Long: numberStaticMethods('long'), Double: numberStaticMethods('double'),
  Float: numberStaticMethods('float'), Short: numberStaticMethods('short'), Byte: numberStaticMethods('byte'),
  Boolean: specs([
    ['compare', ['x', 'y']], ['getBoolean', ['name']], ['logicalAnd', ['a', 'b']], ['logicalOr', ['a', 'b']],
    ['logicalXor', ['a', 'b']], ['parseBoolean', ['value']], ['toString', ['value']], ['valueOf', ['value']],
  ]),
  System: specs([
    ['arraycopy', ['source', 'sourcePosition', 'destination', 'destinationPosition', 'length']],
    ['clearProperty', ['key']], ['currentTimeMillis'], ['exit', ['status']], ['gc'], ['getProperties'],
    ['getProperty', ['key']], ['getProperty', ['key', 'defaultValue']], ['getenv'], ['getenv', ['name']],
    ['identityHashCode', ['object']], ['lineSeparator'], ['load', ['filename']], ['loadLibrary', ['name']],
    ['nanoTime'], ['runFinalization'], ['setErr', ['err']], ['setIn', ['in']], ['setOut', ['out']],
    ['setProperty', ['key', 'value']], ['setSecurityManager', ['manager']],
  ]),
}

interface StaticFieldSpec {
  name: string
  type: string
}

const STATIC_FIELDS: Record<string, StaticFieldSpec[]> = {
  System: [
    { name: 'out', type: 'PrintStream' },
    { name: 'err', type: 'PrintStream' },
    { name: 'in', type: 'InputStream' },
  ],
}

const OBJECT_METHODS = specs([
  ['equals', ['object']], ['hashCode'], ['toString'], ['getClass'],
])

const ARRAY_METHODS = specs([['clone']])
const PRIMITIVE_BASES = new Set(['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short'])

const ASSERTJ_METHODS = specs([
  ['as', ['description']], ['describedAs', ['description']], ['contains', ['values']], ['containsExactly', ['values']],
  ['containsExactlyInAnyOrder', ['values']], ['containsEntry', ['key', 'value']], ['containsKey', ['key']], ['containsValue', ['value']],
  ['doesNotContain', ['values']], ['doesNotContainEntry', ['key', 'value']], ['doesNotContainKey', ['key']],
  ['doesNotContainValue', ['value']], ['hasSameSizeAs', ['other']], ['hasSize', ['size']], ['isBetween', ['start', 'end']],
  ['isCloseTo', ['expected', 'offset']], ['isEqualTo', ['expected']], ['isFalse'], ['isGreaterThan', ['other']],
  ['isGreaterThanOrEqualTo', ['other']], ['isIn', ['values']], ['isInstanceOf', ['type']], ['isLessThan', ['other']],
  ['isLessThanOrEqualTo', ['other']], ['isNaN'], ['isNegative'], ['isNotBetween', ['start', 'end']], ['isNotEqualTo', ['expected']],
  ['isNotIn', ['values']], ['isNotInstanceOf', ['type']], ['isNotNull'], ['isNotSameAs', ['other']], ['isNotZero'],
  ['isNull'], ['isSameAs', ['other']], ['isTrue'], ['isZero'], ['startsWith', ['prefix']], ['endsWith', ['suffix']],
  ['allMatch', ['condition']], ['anyMatch', ['condition']], ['noneMatch', ['condition']], ['extracting', ['function']],
  ['withFailMessage', ['message']],
])

function specs(values: Array<[string, string[]?]>): MethodSpec[] {
  return values.map(([name, parameters]) => ({ name, parameters }))
}

function numberInstanceMethods(kind: string): MethodSpec[] {
  return specs([
    ['toString'], ['compareTo', ['another']], ['intValue'], ['longValue'], ['doubleValue'], ['floatValue'],
    ['shortValue'], ['byteValue'], ['numberValue'],
  ])
}

function numberStaticMethods(kind: string): MethodSpec[] {
  const parseName = kind === 'long' ? 'parseLong' : kind === 'double' ? 'parseDouble' : kind === 'float' ? 'parseFloat' : 'parseInt'
  return specs([
    [parseName, ['value']], ['valueOf', ['value']], ['toString', ['value']], ['compare', ['x', 'y']],
    ['max', ['a', 'b']], ['min', ['a', 'b']], ['sum', ['a', 'b']],
    ...(kind === 'int' || kind === 'long' ? [['compareUnsigned', ['x', 'y']] as [string, string[]]] : []),
    ...(kind === 'double' || kind === 'float' ? [['isFinite', ['value']] as [string, string[]], ['isNaN', ['value']] as [string, string[]]] : []),
  ])
}

function methodCompletion(spec: MethodSpec, type: Completion['type'] = 'method'): Completion {
  const parameters = spec.parameters ?? []
  const label = `${spec.name}(${parameters.join(', ')})`
  if (parameters.length === 0) {
    return { label, type, detail: spec.detail, apply: `${spec.name}()` }
  }
  const body = `${spec.name}(${parameters.map((parameter) => `\${${parameter}}`).join(', ')})`
  return { label, type, detail: spec.detail, apply: snippet(body) }
}

function snippetCompletion(label: string, detail: string | undefined, body: string): Completion {
  return { label, type: 'snippet', detail, apply: snippet(body) }
}

function normalizeType(raw: string): string {
  return raw
    .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
    .replace(/\b(?:final|volatile|transient)\s+/g, '')
    .replace(/\s+/g, '')
    .replace(/\.\.\./g, '[]')
}

function simpleTypeName(raw: string): string {
  return raw.replace(/\[\]/g, '').split('.').at(-1) ?? raw
}

function baseType(raw: string): string {
  const normalized = normalizeType(raw).replace(/\[\]/g, '')
  const generic = normalized.indexOf('<')
  return (generic >= 0 ? normalized.slice(0, generic) : normalized).replace(/^\?extends/, '')
}

function genericArguments(raw: string): string[] {
  const normalized = normalizeType(raw)
  const opening = normalized.indexOf('<')
  if (opening < 0) return []
  let depth = 0
  for (let index = opening; index < normalized.length; index += 1) {
    if (normalized[index] === '<') {
      depth += 1
    } else if (normalized[index] === '>') {
      depth -= 1
      if (depth === 0) {
        return splitTopLevel(normalized.slice(opening + 1, index))
      }
    }
  }
  return []
}

function isIterableType(raw: string): boolean {
  const base = simpleTypeName(baseType(raw))
  return base === 'Iterable' || (TYPE_GROUPS[base] ?? []).includes('Iterable')
}

function cleanElementType(raw: string): string | null {
  const normalized = normalizeType(raw)
  if (!normalized || normalized === '?') return 'Object'
  if (normalized.startsWith('?extends')) return normalized.slice('?extends'.length) || 'Object'
  if (normalized.startsWith('?super')) return 'Object'
  return normalized
    .replace(/\?extends(?=[A-Za-z_$])/g, '? extends ')
    .replace(/\?super(?=[A-Za-z_$])/g, '? super ')
}

function literalElementType(raw: string): string | null {
  const value = raw.trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return 'String'
  if (/^'(?:[^'\\]|\\.)*'$/.test(value)) return 'Character'
  if (/^(?:true|false)$/.test(value)) return 'Boolean'
  if (/^[+-]?\d+[lL]$/.test(value)) return 'Long'
  if (/^[+-]?(?:\d+\.\d*[dD]?|\d+[dD])$/.test(value)) return 'Double'
  if (/^[+-]?\d+$/.test(value)) return 'Integer'
  return null
}

function initializerElementType(initializer: string): string | null {
  const value = initializer.trim()
  const array = /^new\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\[[^\]]*\]\s*)+/.exec(value)
  if (array) {
    const dimensions = array[0].match(/\[[^\]]*\]/g)?.length ?? 1
    return `${normalizeType(array[1])}${'[]'.repeat(Math.max(0, dimensions - 1))}`
  }

  const created = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()]*>)?)/.exec(value)
  if (created) {
    const typeArguments = genericArguments(created[1])
    if (typeArguments.length > 0) return cleanElementType(typeArguments[0])
  }

  const factory = /\b(?:Arrays\s*\.\s*asList|List\s*\.\s*of|Set\s*\.\s*of|Collections\s*\.\s*singletonList)\s*\(([^)]*)\)/.exec(value)
  if (factory) {
    const first = splitTopLevel(factory[1])[0]
    if (first) return literalElementType(first) ?? initializerElementType(first)
  }
  return literalElementType(value)
}

function inferElementType(typeText: string, initializer: string | undefined): string | undefined {
  const normalized = normalizeType(typeText)
  let element: string | null = null
  const array = normalized.indexOf('[]')
  if (array >= 0) {
    // Remove one array dimension.  A two-dimensional array therefore iterates
    // over rows (`int[]`), just as Java's enhanced-for loop does.
    element = normalized.slice(0, array) + normalized.slice(array + 2)
  } else if (normalized !== 'var' && isIterableType(normalized)) {
    element = genericArguments(normalized)[0] ?? null
  }
  // An initializer can supply the type for `var`, but Java's declared type is
  // authoritative for explicit raw or unrelated declarations.
  if (!element && initializer && normalized === 'var') element = initializerElementType(initializer)
  const cleaned = element ? cleanElementType(element) : null
  return cleaned || undefined
}

function inferBases(typeText: string, initializer: string | undefined): string[] {
  const normalized = normalizeType(typeText)
  const declared = baseType(normalized)
  const bases = new Set<string>()
  const addBase = (base: string): void => {
    if (!base) return
    bases.add(base)
    const simple = simpleTypeName(base)
    if (simple && simple !== base) bases.add(simple)
  }
  if (declared && declared !== 'var') {
    addBase(declared)
  }
  if (initializer) {
    const newMatch = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()]*>)?)/.exec(initializer)
    if (newMatch) {
      addBase(baseType(newMatch[1]))
    }
    if (/^\s*"(?:[^"\\]|\\.)*"/.test(initializer) || /^\s*'/.test(initializer)) bases.add('String')
    if (/\b(?:Arrays\s*\.\s*asList|List\s*\.\s*of|Collections\s*\.\s*(?:emptyList|singletonList))\s*\(/.test(initializer)) addBase('List')
    if (/\b(?:Set\s*\.\s*of)\s*\(/.test(initializer)) addBase('Set')
    if (/\bMap\s*\.\s*of(?:Entries)?\s*\(/.test(initializer)) addBase('Map')
    if (/^\s*new\s+[A-Za-z_$][\w$]*\s*\[/.test(initializer)) bases.add('array')
  }
  if (normalized.endsWith('[]')) bases.add('array')
  const expanded = new Set<string>()
  for (const base of bases) {
    for (const group of TYPE_GROUPS[base] ?? [base]) expanded.add(group)
  }
  return [...expanded]
}

function matchingBraces(source: string): { openToClose: Map<number, number>; closeToOpen: Map<number, number> } {
  const openToClose = new Map<number, number>()
  const closeToOpen = new Map<number, number>()
  const stack: number[] = []
  const masked = maskJavaCommentsAndLiterals(source)
  for (let i = 0; i < masked.length; i += 1) {
    const char = masked[i]
    if (char === '{') stack.push(i)
    if (char === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        openToClose.set(open, i)
        closeToOpen.set(i, open)
      }
    }
  }
  return { openToClose, closeToOpen }
}

function enclosingScope(position: number, braces: ReturnType<typeof matchingBraces>): { start: number; end: number; depth: number } {
  const containing = [...braces.openToClose.entries()]
    .filter(([open, close]) => open < position && position < close)
  if (containing.length === 0) return { start: 0, end: Number.MAX_SAFE_INTEGER, depth: 0 }
  // The map is populated as closing braces are found, so insertion order is
  // innermost-first. Select the narrowest scope explicitly and count all
  // containing blocks for reliable field-vs-local classification.
  const [open, close] = containing.reduce((best, current) => {
    const bestWidth = best[1] - best[0]
    const currentWidth = current[1] - current[0]
    return currentWidth < bestWidth ? current : best
  })
  return { start: open + 1, end: close, depth: containing.length }
}

function splitTopLevel(value: string): string[] {
  const result: string[] = []
  let start = 0
  let angle = 0
  let paren = 0
  let bracket = 0
  let quote = ''
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (char === '<') angle += 1
    else if (char === '>' && angle > 0) angle -= 1
    else if (char === '(') paren += 1
    else if (char === ')' && paren > 0) paren -= 1
    else if (char === '[') bracket += 1
    else if (char === ']' && bracket > 0) bracket -= 1
    else if (char === ',' && angle === 0 && paren === 0 && bracket === 0) {
      result.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parameterNameAndType(parameter: string): { name: string; type: string } | null {
  const clean = parameter
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/g, ' ')
    .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
    .replace(/\bfinal\s+/g, '')
    .trim()
  const match = /^(.*?)\s+([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)$/.exec(clean)
  if (!match) return null
  if (clean.includes(':')) return null
  if (/^(?:if|while|switch|catch|for)$/.test(match[1].trim())) return null
  return { type: `${match[1].trim()}${match[3] ?? ''}`, name: match[2] }
}

function extractParameters(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  const methodBody = /\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/g
  let match: RegExpExecArray | null
  while ((match = methodBody.exec(source))) {
    const openBrace = methodBody.lastIndex - 1
    const closeBrace = braces.openToClose.get(openBrace) ?? source.length
    if (!(openBrace < position && position < closeBrace)) continue
    const parameters = splitTopLevel(match[1])
    for (const parameter of parameters) {
      const parsed = parameterNameAndType(parameter)
      if (!parsed) continue
      const nameStart = match.index + match[0].indexOf(parsed.name)
      const elementType = inferElementType(parsed.type, undefined)
      result.push({
        name: parsed.name,
        bases: inferBases(parsed.type, undefined),
        declaredType: normalizeType(parsed.type),
        ...(elementType ? { elementType } : {}),
        kind: 'parameter',
        declaredAt: nameStart,
        scopeStart: openBrace + 1,
        scopeEnd: closeBrace,
      })
    }
  }
  return result
}

function extractDeclarations(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  // A declaration starts after a statement/block boundary.  Keeping the
  // boundary in the expression avoids treating method calls as declarations.
  const declaration = /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|volatile|transient|synchronized)\s+)*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}=]*?>)?\s*(?:\[\s*\])*)\s+([^;{}]+);/gm
  // Primitive names are legal declaration types even though Java classifies
  // them as keywords.  Only these statement/control-flow words invalidate the
  // first token of a declaration match.
  const reserved = new Set(['return', 'throw', 'new', 'case', 'default', 'if', 'for', 'while', 'switch', 'do', 'else', 'try', 'catch'])
  let match: RegExpExecArray | null
  while ((match = declaration.exec(source))) {
    const typeText = match[1].trim()
    const typeBase = baseType(typeText)
    if (reserved.has(typeBase) || typeBase === 'void') continue
    const declarators = splitTopLevel(match[2])
    const boundaryOffset = match[0].indexOf(typeText)
    const declarationStart = match.index + Math.max(0, boundaryOffset)
    const scope = enclosingScope(declarationStart, braces)
    for (const declarator of declarators) {
      const variable = /^([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)?(?:\s*=\s*([\s\S]*))?$/.exec(declarator)
      if (!variable) continue
      const declaredAt = match.index + match[0].indexOf(variable[1], boundaryOffset)
      const isField = scope.depth <= 1
      // Fields are visible throughout the class, including from methods
      // written before the field declaration. Local variables still obey the
      // normal declaration-before-use rule.
      if (declaredAt > position && !isField) continue
      const variableType = `${typeText}${variable[2] ?? ''}`
      const elementType = inferElementType(variableType, variable[3])
      result.push({
        name: variable[1],
        bases: inferBases(variableType, variable[3]),
        declaredType: normalizeType(variableType),
        ...(elementType ? { elementType } : {}),
        kind: isField ? 'field' : 'local',
        declaredAt,
        scopeStart: scope.start,
        scopeEnd: scope.end,
      })
    }
  }
  // `for (int i = 0; ...` has a parenthesis boundary rather than a statement
  // boundary.  It is common enough in LeetCode solutions to handle separately.
  const forDeclaration = /\bfor\s*\(\s*(?:final\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;(){}]*?>)?\s*(?:\[\s*\])*)\s+([A-Za-z_$][\w$]*)(\s*(?:\[\s*\])*)\s*=\s*([^;]*)/g
  while ((match = forDeclaration.exec(source))) {
    const declaredAt = match.index + match[0].lastIndexOf(match[2])
    if (declaredAt > position) continue
    const scope = enclosingScope(match.index, braces)
    const variableType = `${match[1]}${match[3] ?? ''}`
    const elementType = inferElementType(variableType, match[4])
    result.push({
      name: match[2], bases: inferBases(variableType, match[4]), declaredType: normalizeType(variableType), ...(elementType ? { elementType } : {}), kind: 'local', declaredAt,
      scopeStart: scope.start, scopeEnd: scope.end,
    })
  }
  const enhancedForDeclaration = /\bfor\s*\(\s*(?:final\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;(){}]*?>)?\s*(?:\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*:\s*[^)]*\)/g
  while ((match = enhancedForDeclaration.exec(source))) {
    const declaredAt = match.index + match[0].lastIndexOf(match[2])
    if (declaredAt > position) continue
    const bodyOpen = source.indexOf('{', match.index + match[0].length)
    const bodyClose = bodyOpen >= 0 ? braces.openToClose.get(bodyOpen) : undefined
    const scope = bodyOpen >= 0 && bodyClose !== undefined
      ? { start: bodyOpen + 1, end: bodyClose }
      : enclosingScope(match.index, braces)
    const elementType = inferElementType(match[1], undefined)
    result.push({
      name: match[2], bases: inferBases(match[1], undefined), declaredType: normalizeType(match[1]), ...(elementType ? { elementType } : {}), kind: 'local', declaredAt,
      scopeStart: scope.start, scopeEnd: scope.end,
    })
  }
  return result
}

export function collectJavaSymbols(source: string, position = source.length): JavaSymbol[] {
  const braces = matchingBraces(source)
  return [...extractDeclarations(source, position, braces), ...extractParameters(source, position, braces)]
}

/**
 * Keep source offsets stable while hiding comments and literals from the
 * lightweight Java scanners below.  This prevents a string such as
 * `"helper() {"` from looking like a declaration or a clickable call.
 */
export function maskJavaCommentsAndLiterals(source: string): string {
  // `split('')` intentionally keeps UTF-16 code-unit indexing. CodeMirror
  // positions are UTF-16 offsets, while spreading a string would collapse
  // astral characters and shift every later source range.
  const chars = source.split('')
  let state: 'normal' | 'lineComment' | 'blockComment' | 'string' | 'char' | 'textBlock' = 'normal'
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index]
    const next = chars[index + 1]
    if (state === 'lineComment') {
      if (current === '\n' || current === '\r') {
        state = 'normal'
      } else {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'blockComment') {
      if (current === '*' && next === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'string' || state === 'char') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) {
        chars[index] = ' '
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (state === 'textBlock') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n' && chars[index + 1] !== '\r') {
          chars[index + 1] = ' '
          index += 1
        }
      } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
        chars[index] = ' '
        chars[index + 1] = ' '
        chars[index + 2] = ' '
        index += 2
        state = 'normal'
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' '
      }
      continue
    }
    if (current === '/' && next === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'lineComment'
    } else if (current === '/' && next === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      state = 'blockComment'
    } else if (current === '"' && next === '"' && chars[index + 2] === '"') {
      // Keep one non-whitespace placeholder so a literal counts as an
      // argument even when its contents are masked.
      chars[index] = '\u0001'
      chars[index + 1] = ' '
      chars[index + 2] = ' '
      index += 2
      state = 'textBlock'
    } else if (current === '"') {
      chars[index] = '\u0001'
      state = 'string'
    } else if (current === "'") {
      chars[index] = '\u0001'
      state = 'char'
    }
  }
  return chars.join('')
}

function javaClassNames(maskedSource: string): Set<string> {
  const names = new Set<string>()
  const classPattern = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = classPattern.exec(maskedSource))) {
    names.add(match[1])
  }
  return names
}

function methodHasReturnType(match: RegExpExecArray, nameStartInMatch: number): boolean {
  let prefix = match[0].slice(0, nameStartInMatch)
  const boundary = Math.max(prefix.lastIndexOf('{'), prefix.lastIndexOf('}'), prefix.lastIndexOf(';'))
  if (boundary >= 0) {
    prefix = prefix.slice(boundary + 1)
  }
  const normalized = prefix
    .replace(/(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+/g, ' ')
    .replace(/\b(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\b/g, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .trim()
  return normalized.length > 0
}

export function collectJavaMethods(source: string): JavaMethod[] {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  const classNames = javaClassNames(maskedSource)
  const result: JavaMethod[] = []
  const method = /(?:^|[;{}])\s*(?:(?:@(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\([^)]*\))?\s*)+)?(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{}]+>\s*)?(?:(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(?:\s*<[^>{}]*>)?\s*(?:\[\s*\])*\s+)?([A-Za-z_$][\w$]*)\s*\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm
  let match: RegExpExecArray | null
  while ((match = method.exec(maskedSource))) {
    const name = match[1]
    if (/^(?:if|for|while|switch|catch|try|synchronized)$/.test(name)) continue
    // Constructors have the class name but no return type.  They are not
    // method definitions for the editor's same-file navigation feature.
    const signatureOpenParen = match[0].lastIndexOf('(')
    const nameStartInMatch = match[0].lastIndexOf(name, signatureOpenParen)
    const hasReturnType = methodHasReturnType(match, nameStartInMatch)
    if (!hasReturnType && classNames.has(name)) continue
    const nameStart = match.index + nameStartInMatch
    const parameters = splitTopLevel(match[2]).map(parameterNameAndType).filter((value): value is { name: string; type: string } => value !== null).map((value) => value.name)
    result.push({ name, parameters, declaredAt: match.index, nameStart, nameEnd: nameStart + name.length })
  }
  return result
}

/** Return the Java identifier under a source position, if it is code. */
export function javaIdentifierAt(source: string, position: number): JavaIdentifier | null {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  let cursor = Math.max(0, Math.min(Math.trunc(position), source.length))
  if (cursor === source.length || !/[A-Za-z0-9_$]/.test(maskedSource[cursor] ?? '')) {
    cursor -= 1
  }
  if (cursor < 0 || !/[A-Za-z_$]/.test(maskedSource[cursor] ?? '')) {
    return null
  }
  let from = cursor
  let to = cursor + 1
  while (from > 0 && /[A-Za-z0-9_$]/.test(maskedSource[from - 1])) from -= 1
  while (to < maskedSource.length && /[A-Za-z0-9_$]/.test(maskedSource[to])) to += 1
  const name = source.slice(from, to)
  if (!name || maskedSource.slice(from, to) !== name) {
    return null
  }
  return { name, from, to }
}

function previousIdentifier(maskedSource: string, from: number): string | null {
  let cursor = from - 1
  while (cursor >= 0 && /\s/.test(maskedSource[cursor])) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[cursor])) cursor -= 1
  const start = cursor + 1
  return start < end ? maskedSource.slice(start, end) : null
}

function callOpenParen(maskedSource: string, end: number): number | null {
  let cursor = end
  while (cursor < maskedSource.length && /\s/.test(maskedSource[cursor])) cursor += 1
  return maskedSource[cursor] === '(' ? cursor : null
}

function isGenericAngleOpen(maskedSource: string, index: number): boolean {
  let previous = index - 1
  while (previous >= 0 && /\s/.test(maskedSource[previous])) previous -= 1
  let next = index + 1
  while (next < maskedSource.length && /\s/.test(maskedSource[next])) next += 1
  if (previous < 0 || next >= maskedSource.length) return false
  const before = maskedSource.slice(0, index)
  const explicitTypeArguments = /\.\s*$/.test(before)
  if (!explicitTypeArguments && !/[A-Za-z0-9_$>\]]/.test(maskedSource[previous])) return false
  if (!/[A-Za-z0-9_$?@]/.test(maskedSource[next])) return false

  let previousStart = previous
  while (previousStart >= 0 && /[A-Za-z0-9_$]/.test(maskedSource[previousStart])) previousStart -= 1
  const previousToken = maskedSource.slice(previousStart + 1, previous + 1)
  const typeName = /^[A-Z_$]/.test(previousToken)
  const constructedType = /\bnew\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(before)
  if (!explicitTypeArguments && !typeName && !constructedType) return false

  // A comparison (`left < right`) has no closing angle before the current
  // call's argument boundary. Generic types do, including nested `>>`.
  let depth = 1
  let nestedParen = 0
  for (let cursor = next; cursor < maskedSource.length; cursor += 1) {
    const current = maskedSource[cursor]
    if (current === '<') {
      depth += 1
    } else if (current === '>') {
      depth -= 1
      if (depth === 0) {
        if (explicitTypeArguments || constructedType) return true
        let after = cursor + 1
        while (after < maskedSource.length && /\s/.test(maskedSource[after])) after += 1
        return after >= maskedSource.length || /[,)\]}.(]/.test(maskedSource[after] ?? '')
      }
    } else if (current === '(') {
      nestedParen += 1
    } else if (current === ')') {
      if (nestedParen > 0) {
        nestedParen -= 1
      } else {
        return false
      }
    } else if (depth === 1 && current === ';') {
      return false
    }
  }
  return false
}

function callArgumentCount(maskedSource: string, openParen: number): number | null {
  let paren = 0
  let bracket = 0
  let brace = 0
  let angle = 0
  let commas = 0
  let hasValue = false
  for (let index = openParen + 1; index < maskedSource.length; index += 1) {
    const current = maskedSource[index]
    if (current === '<' && isGenericAngleOpen(maskedSource, index)) {
      angle += 1
    } else if (current === '>' && angle > 0) {
      angle -= 1
    } else if (current === '(') {
      paren += 1
      hasValue = true
    } else if (current === ')') {
      if (paren > 0) {
        paren -= 1
        hasValue = true
      } else if (bracket === 0 && brace === 0 && angle === 0) {
        return hasValue ? commas + 1 : commas
      }
    } else if (current === '[') {
      bracket += 1
      hasValue = true
    } else if (current === ']') {
      bracket = Math.max(0, bracket - 1)
      hasValue = true
    } else if (current === '{') {
      brace += 1
      hasValue = true
    } else if (current === '}') {
      brace = Math.max(0, brace - 1)
      hasValue = true
    } else if (current === ',' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      commas += 1
      hasValue = false
    } else if (!/\s/.test(current)) {
      hasValue = true
    }
  }
  return null
}

/**
 * Resolve a same-file method call to the exact declaration name range.
 *
 * This deliberately stays conservative: only unqualified/`this.` calls are
 * considered, constructors and control-flow keywords are ignored, and an
 * unresolved overload falls back to the first declaration in source order.
 */
export function resolveJavaDefinition(source: string, position: number): JavaDefinition | null {
  const identifier = javaIdentifierAt(source, position)
  if (!identifier) return null
  const methods = collectJavaMethods(source)
  const declaration = methods.find((method) => identifier.from === method.nameStart && identifier.to === method.nameEnd)
  if (declaration) {
    return {
      name: declaration.name,
      from: declaration.nameStart,
      to: declaration.nameEnd,
      parameters: declaration.parameters,
      declaredAt: declaration.declaredAt,
    }
  }

  const maskedSource = maskJavaCommentsAndLiterals(source)
  const openParen = callOpenParen(maskedSource, identifier.to)
  if (openParen === null) return null
  if (previousIdentifier(maskedSource, identifier.from) === 'new') return null
  const beforeIdentifier = maskedSource.slice(0, identifier.from)
  if (/\.\s*$/.test(beforeIdentifier) && !/(?:^|[^\w$.])this\s*\.\s*$/.test(beforeIdentifier)) {
    return null
  }

  const candidates = methods.filter((method) => method.name === identifier.name)
  if (candidates.length === 0) return null
  const argumentCount = callArgumentCount(maskedSource, openParen)
  const selected = argumentCount === null
    ? candidates[0]
    : candidates.find((method) => method.parameters.length === argumentCount) ?? candidates[0]
  return {
    name: selected.name,
    from: selected.nameStart,
    to: selected.nameEnd,
    parameters: selected.parameters,
    declaredAt: selected.declaredAt,
  }
}

function findDotContext(source: string, position: number): DotContext | null {
  const before = source.slice(0, position)
  // Keep the complete receiver so chains such as `System.out.` can be
  // resolved.  The resolver remains conservative for arbitrary dotted
  // expressions, but recognizing the chain here preserves the typed prefix
  // range (`System.out.pr|` -> `pr`).
  const dotWord = /(?:^|[^\w$])((?:(?:this\.)?[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(before)
  if (dotWord) {
    const typed = dotWord[2] ?? ''
    return { receiver: dotWord[1], from: position - typed.length, assertJ: false }
  }
  const assertStart = before.lastIndexOf('assertThat')
  if (assertStart >= 0) {
    const chain = before.slice(assertStart)
    if (/^assertThat\b[\s\S]*\.\s*[A-Za-z_$]*$/.test(chain)) {
      const typed = /\.\s*([A-Za-z_$]*)$/.exec(chain)?.[1] ?? ''
      return { receiver: chain, from: position - typed.length, assertJ: true }
    }
  }
  return null
}

function symbolFor(symbols: JavaSymbol[], name: string, position: number): JavaSymbol | null {
  const candidates = symbols.filter((symbol) => symbol.name === name && symbol.scopeStart <= position && position <= symbol.scopeEnd)
  candidates.sort((left, right) => {
    const leftWidth = left.scopeEnd - left.scopeStart
    const rightWidth = right.scopeEnd - right.scopeStart
    return leftWidth - rightWidth || right.declaredAt - left.declaredAt
  })
  return candidates[0] ?? null
}

function completionOptions(items: MethodSpec[]): Completion[] {
  return items.map((item) => methodCompletion(item))
}

function staticFieldOptions(fields: StaticFieldSpec[]): Completion[] {
  return fields.map((field) => ({
    label: field.name,
    type: 'field' as const,
    detail: field.type,
    apply: field.name,
  }))
}

function methodOptions(resolution: ReceiverResolution, assertJ = false): Completion[] {
  if (assertJ) {
    return completionOptions([...ASSERTJ_METHODS, ...OBJECT_METHODS])
  }
  if (resolution.array) {
    return [
      { label: 'length', type: 'field' as const, detail: 'array length', apply: 'length' },
      ...completionOptions(ARRAY_METHODS),
    ]
  }
  if (resolution.thisReceiver || resolution.unknown || resolution.primitive) {
    return completionOptions(OBJECT_METHODS)
  }
  if (resolution.static) {
    const allStatic = resolution.bases.flatMap((base) => STATIC_CATALOG[base] ?? [])
    const allFields = resolution.bases.flatMap((base) => STATIC_FIELDS[base] ?? [])
    return uniqueOptions([
      ...staticFieldOptions(allFields),
      ...completionOptions(uniqueMethodSpecs(allStatic)),
    ])
  }

  const all = new Map<string, MethodSpec>()
  for (const base of resolution.bases) {
    for (const group of TYPE_GROUPS[base] ?? [base]) {
      for (const item of CATALOG[group] ?? []) {
        const key = `${item.name}(${(item.parameters ?? []).join(',')})`
        if (!all.has(key)) all.set(key, item)
      }
    }
  }
  for (const item of OBJECT_METHODS) {
    const key = `${item.name}(${(item.parameters ?? []).join(',')})`
    if (!all.has(key)) all.set(key, item)
  }
  return [...all.values()].map((item) => methodCompletion(item))
}

function uniqueMethodSpecs(items: MethodSpec[]): MethodSpec[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.name}(${(item.parameters ?? []).join(',')})`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function receiverResolution(receiver: string, position: number, symbols: JavaSymbol[]): ReceiverResolution {
  if (receiver === 'this') {
    return { bases: [], static: false, unknown: false, primitive: false, array: false, thisReceiver: true }
  }
  if (receiver === 'System.out' || receiver === 'System.err') {
    return { bases: ['PrintStream'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (receiver === 'System.in') {
    return { bases: ['InputStream'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  const symbolName = receiver.startsWith('this.') ? receiver.slice('this.'.length) : receiver
  const symbol = symbolFor(symbols, symbolName, position)
  if (symbol) {
    return {
      bases: symbol.bases,
      static: false,
      unknown: false,
      primitive: symbol.bases.some((base) => PRIMITIVE_BASES.has(base)),
      array: symbol.bases.includes('array'),
      thisReceiver: false,
    }
  }
  const staticBase = receiver.replace(/^this\./, '')
  const knownType = JAVA_TYPES.includes(staticBase)
  if (knownType) {
    return { bases: [staticBase], static: true, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (/^new\s+StringBuilder/.test(receiver)) {
    return { bases: ['StringBuilder'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (/^new\s+ArrayList/.test(receiver)) {
    return { bases: ['ArrayList'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  // Keep unresolved receivers deliberately conservative.  Offering list
  // methods here is worse than showing only Object methods because it makes
  // invalid code look valid and is particularly noisy for primitive values.
  return { bases: [], static: false, unknown: true, primitive: false, array: false, thisReceiver: false }
}

function symbolCompletions(symbols: JavaSymbol[]): Completion[] {
  const seen = new Set<string>()
  return symbols
    .sort((left, right) => right.declaredAt - left.declaredAt)
    .filter((symbol) => {
      if (seen.has(symbol.name)) return false
      seen.add(symbol.name)
      return true
    })
    .map((symbol) => ({ label: symbol.name, type: 'variable' as const, detail: symbol.bases[0] ?? 'value', apply: symbol.name }))
}

function methodCompletions(methods: JavaMethod[]): Completion[] {
  const seen = new Set<string>()
  return methods.filter((method) => {
    if (seen.has(method.name)) return false
    seen.add(method.name)
    return true
  }).map((method) => methodCompletion({ name: method.name, parameters: method.parameters }, 'function'))
}

function thisMemberCompletions(symbols: JavaSymbol[], methods: JavaMethod[]): Completion[] {
  return uniqueOptions([
    ...symbolCompletions(symbols.filter((symbol) => symbol.kind === 'field')),
    ...methodCompletions(methods),
  ])
}

function uniqueOptions(options: Completion[]): Completion[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    if (seen.has(option.label)) return false
    seen.add(option.label)
    return true
  })
}

export function javaCompletions(context: CompletionContext): CompletionResult | null {
  const source = context.state.doc.toString()
  const position = context.pos
  const dot = findDotContext(source, position)
  const symbols = collectJavaSymbols(source, position)
  const methods = collectJavaMethods(source)
  if (dot) {
    if (dot.receiver === 'this') {
      return {
        from: dot.from,
        options: thisMemberCompletions(symbols, methods),
        validFor: /^[\w$]*$/,
      }
    }
    const resolution = receiverResolution(dot.receiver, position, symbols)
    return {
      from: dot.from,
      options: methodOptions(resolution, dot.assertJ),
      validFor: /^[\w$]*$/,
    }
  }
  const word = context.matchBefore(/[\w$]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return {
    from: word.from,
    options: uniqueOptions([
      ...symbolCompletions(symbols),
      ...methodCompletions(methods),
      ...javaIterCompletions(source, position),
      ...JAVA_COMPLETIONS,
    ]),
    validFor: /^[\w$]*$/,
  }
}

export { JAVA_COMPLETIONS }

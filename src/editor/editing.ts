import {
  acceptCompletion,
  nextSnippetField,
} from '@codemirror/autocomplete'
import {
  indentRange,
  syntaxTree,
} from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  expandJavaPrintTemplate,
  expandJavaTestTemplate,
} from '../completions'
import type { ClipboardBridge } from '../clipboard'
import {
  formatJavaSource,
} from '../java-format'
import {
  findJavaRefactorSelection,
  planJavaMethodExtraction,
} from '../java-refactor'
import {
  balancedJavaDelimiters,
  isInsideCommentOrString,
  isStatementCandidate,
  lineAt,
  lineBreakFor,
  lineCodeEnd,
  type SourceLine,
} from './statement-completion'

/** Compute one CodeMirror change for replacing the differing source suffix. */
export function minimalDocumentChange(before: string, after: string) {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1

  let beforeTo = before.length
  let afterTo = after.length
  while (beforeTo > from && afterTo > from && before[beforeTo - 1] === after[afterTo - 1]) {
    beforeTo -= 1
    afterTo -= 1
  }
  return { from, to: beforeTo, insert: after.slice(from, afterTo) }
}

/** Reformat the whole document and then re-indent through Java language support. */
export function reformatJavaDocument(view: EditorView): boolean {
  const source = view.state.doc.toString()
  const formatted = formatJavaSource(source)
  if (formatted !== source) {
    view.dispatch({ changes: minimalDocumentChange(source, formatted), userEvent: 'format' })
  }
  const indentation = indentRange(view.state, 0, view.state.doc.length)
  if (!indentation.empty) {
    view.dispatch({ changes: indentation, userEvent: 'format' })
  }
  return true
}

/** The line blocks `deleteLine` would remove for the current selection. */
export function selectedLineBlocks(state: EditorState): Array<{ from: number; to: number }> {
  const blocks: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from)
    let endLine = state.doc.lineAt(range.to)
    if (range.to > range.from && endLine.from === range.to) {
      endLine = state.doc.lineAt(range.to - 1)
    }
    const from = startLine.from
    const to = Math.min(state.doc.length, endLine.to + 1)
    const previous = blocks[blocks.length - 1]
    if (previous && previous.to >= from) {
      previous.to = to
    } else {
      blocks.push({ from, to })
    }
  }
  return blocks
}

export interface JavaVariableInsertion {
  from: number
  insert: string
  replaceFrom: number
  replaceTo: number
  selected: string
  name: string
  nameFrom: number
  nameTo: number
}

type JavaSyntaxNode = ReturnType<typeof syntaxTree>['topNode']

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'true',
  'false', 'null', 'record', 'sealed', 'permits', 'non-sealed', 'yield',
])

function javaVariableBase(expression: string): string {
  const value = expression.trim()
  const method = /(?:^|\.)([A-Za-z_$][\w$]*)\s*\(/.exec(value)
  if (method) {
    const methodName = method[1]
    const property = /^(?:get|is|has)([A-Z][A-Za-z0-9_$]*)$/.exec(methodName)
    return property ? property[1][0].toLowerCase() + property[1].slice(1) : methodName
  }
  const created = /\bnew\s+(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)/.exec(value)
  if (created) {
    return created[1][0].toLowerCase() + created[1].slice(1)
  }
  const identifier = /^[A-Za-z_$][\w$]*$/.exec(value)
  if (identifier) {
    return identifier[0]
  }
  const property = /\.([A-Za-z_$][\w$]*)$/.exec(value)
  return property?.[1] ?? 'value'
}

function uniqueJavaVariableName(source: string, from: number, to: number, base: string): string {
  const fallback = /^[A-Za-z_$][\w$]*$/.test(base) && !JAVA_KEYWORDS.has(base) ? base : 'value'
  const surrounding = `${source.slice(0, from)} ${source.slice(to)}`
  const used = new Set(surrounding.match(/[A-Za-z_$][\w$]*/g) ?? [])
  if (!used.has(fallback) && !JAVA_KEYWORDS.has(fallback)) {
    return fallback
  }
  let suffix = 2
  while (used.has(`${fallback}${suffix}`) || JAVA_KEYWORDS.has(`${fallback}${suffix}`)) {
    suffix += 1
  }
  return `${fallback}${suffix}`
}

function exactJavaSyntaxNode(
  state: EditorState,
  from: number,
  to: number,
): JavaSyntaxNode | null {
  let node: JavaSyntaxNode | null = syntaxTree(state).resolveInner(from, 1)
  while (node) {
    if (node.from === from && node.to === to) {
      return node
    }
    node = node.parent
  }
  return null
}

function allowsJavaExpressionSelection(state: EditorState, from: number, to: number): boolean {
  const exact = exactJavaSyntaxNode(state, from, to)
  if (!exact) {
    return true
  }
  if (exact.name === 'Definition' || exact.name === 'TypeName' || exact.name === 'PrimitiveType'
    || exact.name === 'MethodName' || exact.name.endsWith('Statement')) {
    return false
  }
  for (let node = exact.parent; node; node = node.parent) {
    if (node.name === 'FieldDeclaration') {
      return false
    }
  }
  return true
}

/** Plan introducing a `var` for one single-line expression selection. */
export function planJavaVariableInsertion(
  source: string,
  selectionFrom: number,
  selectionTo: number,
): JavaVariableInsertion | null {
  if (selectionFrom < 0 || selectionTo <= selectionFrom || selectionTo > source.length) {
    return null
  }
  const line = lineAt(source, selectionFrom)
  if (lineAt(source, selectionTo).from !== line.from
    || isInsideCommentOrString(source, line.from)
    || isInsideCommentOrString(source, selectionFrom)
    || isInsideCommentOrString(source, selectionTo)) {
    return null
  }
  const codeEnd = line.from + lineCodeEnd(line.text)
  const code = source.slice(line.from, codeEnd)
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? ''
  const codeStart = line.from + indent.length
  const rawSelected = source.slice(selectionFrom, selectionTo)
  const selected = rawSelected.endsWith(';')
    ? rawSelected.slice(0, -1).trimEnd()
    : rawSelected
  if (code.includes('/*')
    || selectionFrom < codeStart
    || selectionTo > codeEnd
    || rawSelected.trim() !== rawSelected
    || !balancedJavaDelimiters(selected)
    || !isStatementCandidate(code.slice(indent.length))) {
    return null
  }
  if (/;/.test(selected) || /(?:^|[^=!<>])=(?!=|>)/.test(selected)) {
    return null
  }
  const name = uniqueJavaVariableName(source, selectionFrom, selectionTo, javaVariableBase(selected))
  if (/^[A-Za-z_$][\w$]*$/.test(selected)) {
    return null
  }
  const lineBreak = lineBreakFor(source, line)
  const insert = `${indent}var ${name} = ${selected};${lineBreak}`
  const nameFrom = line.from + indent.length + 4
  return {
    from: line.from,
    insert,
    replaceFrom: selectionFrom,
    replaceTo: selectionTo,
    selected,
    name,
    nameFrom,
    nameTo: nameFrom + name.length,
  }
}

/** Introduce a local `var` for the current single expression selection. */
export function introduceJavaVariable(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1) {
    return false
  }
  const source = state.doc.toString()
  let from = Math.min(selection.from, selection.to)
  let to = Math.max(selection.from, selection.to)
  if (selection.empty) {
    if (isInsideCommentOrString(source, selection.head)) return false
    const inferred = findJavaRefactorSelection(source, selection.head, 'expression')
    if (!inferred) return false
    from = inferred.from
    to = inferred.to
  }
  const plan = planJavaVariableInsertion(state.doc.toString(), from, to)
  if (!plan || !allowsJavaExpressionSelection(state, from, from + plan.selected.length)) {
    return false
  }
  const line = state.doc.lineAt(from)
  const codeEnd = line.from + lineCodeEnd(line.text)
  const indent = /^[\t ]*/.exec(line.text)?.[0] ?? ''
  if (from === line.from + indent.length
    && /^\s*;?\s*$/.test(state.sliceDoc(from + plan.selected.length, codeEnd))) {
    view.dispatch({
      changes: { from, to: codeEnd, insert: `var ${plan.name} = ${plan.selected};` },
      selection: { anchor: from + 4, head: from + 4 + plan.name.length },
      userEvent: 'input.introduceVariable',
    })
    return true
  }
  let changes
  if (plan.replaceFrom === plan.from + plan.insert.indexOf('var ')) {
    changes = [{
      from: plan.from,
      to: plan.replaceTo,
      insert: `${plan.insert}${state.sliceDoc(plan.from, plan.replaceFrom)}${plan.name}`,
    }]
  } else {
    changes = [
      { from: plan.from, insert: plan.insert },
      { from: plan.replaceFrom, to: plan.replaceTo, insert: plan.name },
    ]
  }
  const usageEnd = state.changes(changes).mapPos(plan.replaceTo, 1)
  view.dispatch({
    changes,
    selection: EditorSelection.create([
      EditorSelection.range(plan.nameFrom, plan.nameTo),
      EditorSelection.range(usageEnd - plan.name.length, usageEnd),
    ]),
    userEvent: 'input.introduceVariable',
  })
  return true
}

/** Extract a selected expression or complete statement range into a helper. */
export function extractJavaMethod(view: EditorView, onError?: (message: string) => void): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1) {
    onError?.('Select an expression or complete statements to extract a method.')
    return true
  }
  const selection = state.selection.main
  const source = state.doc.toString()
  const candidates: Array<{ from: number; to: number }> = []
  if (selection.empty) {
    if (isInsideCommentOrString(source, selection.head)) {
      onError?.('Select an expression or complete statements to extract a method.')
      return true
    }
    for (const preference of ['expression', 'statement'] as const) {
      const inferred = findJavaRefactorSelection(source, selection.head, preference)
      if (inferred && !candidates.some((candidate) => (
        candidate.from === inferred.from && candidate.to === inferred.to
      ))) {
        candidates.push({ from: inferred.from, to: inferred.to })
      }
    }
    if (candidates.length === 0) {
      onError?.('Select an expression or complete statements to extract a method.')
      return true
    }
  } else {
    candidates.push({ from: selection.from, to: selection.to })
  }

  let failure: string | null = null
  for (const candidate of candidates) {
    const plan = planJavaMethodExtraction(source, candidate.from, candidate.to)
    if ('reason' in plan) {
      failure = plan.reason
      continue
    }
    view.dispatch({
      changes: plan.changes,
      selection: EditorSelection.create(plan.nameRanges.map((range) => EditorSelection.range(range.from, range.to))),
      scrollIntoView: true,
      userEvent: 'input.extractMethod',
    })
    return true
  }
  if (failure) onError?.(failure)
  return true
}

/** Snippet navigation takes precedence over expanding a fresh abbreviation. */
export function expandJavaTemplateOnTab(view: EditorView): boolean {
  return nextSnippetField(view)
    || acceptCompletion(view)
    || expandJavaTestTemplate(view)
    || expandJavaPrintTemplate(view)
}

function previousLine(source: string, lineFrom: number): SourceLine | null {
  if (lineFrom <= 0) {
    return null
  }
  let to = lineFrom - 1
  if (source[to] === '\n' && to > 0 && source[to - 1] === '\r') {
    to -= 1
  }
  let from = to
  while (from > 0 && source[from - 1] !== '\n' && source[from - 1] !== '\r') {
    from -= 1
  }
  return { from, to, text: source.slice(from, to) }
}

export interface JavaDocInsertion {
  from: number
  insert: string
  cursor: number
}

const JAVA_CLASS_DECLARATION = /^[ \t]*(?:(?:public|protected|private|abstract|final|static|strictfp|sealed|non-sealed)[ \t]+)*class[ \t]+[A-Za-z_$][\w$]*/

function javaDocBodyCursor(line: SourceLine): number | null {
  const match = /^([ \t]*)\* (.*)$/.exec(line.text)
  if (!match) {
    return null
  }
  return line.from + match[1].length + 2
}

function existingJavaDocCursor(source: string, classLine: SourceLine): number | null {
  let line = previousLine(source, classLine.from)
  if (!line || (!/^[ \t]*\*\/[ \t]*$/.test(line.text)
    && !/^[ \t]*\/\*\*.*\*\/[ \t]*$/.test(line.text))) {
    return null
  }

  const closingLine = line
  let lastBodyCursor: number | null = null
  while (line) {
    const opening = /^[ \t]*\/\*\*/.exec(line.text)
    if (opening) {
      const openingEnd = line.text.indexOf('/**') + 3
      const closing = line.text.indexOf('*/', openingEnd)
      if (closing >= 0) {
        if (lastBodyCursor !== null) {
          return lastBodyCursor
        }
        let cursor = openingEnd
        while (cursor < closing && /[ \t]/.test(line.text[cursor] ?? '')) {
          cursor += 1
        }
        return line.from + cursor
      }
      return lastBodyCursor ?? (closingLine.from + closingLine.text.search(/\*\//))
    }

    if (line === closingLine && /^[ \t]*\*\/[ \t]*$/.test(line.text)) {
      line = previousLine(source, line.from)
      continue
    }

    const bodyCursor = javaDocBodyCursor(line)
    if (bodyCursor !== null && lastBodyCursor === null) {
      lastBodyCursor = bodyCursor
    } else if (!/^[ \t]*$/.test(line.text) && !/^[ \t]*\*\*?[ \t]*$/.test(line.text)) {
      return null
    }
    line = previousLine(source, line.from)
  }
  return null
}

/** Plan the JavaDoc edit for a cursor on a Java class declaration line. */
export function planJavaDocInsertion(source: string, position: number): JavaDocInsertion | null {
  const classLine = lineAt(source, position)
  if (isInsideCommentOrString(source, classLine.from) || !JAVA_CLASS_DECLARATION.test(classLine.text)) {
    return null
  }

  const existingCursor = existingJavaDocCursor(source, classLine)
  if (existingCursor !== null) {
    return { from: existingCursor, insert: '', cursor: existingCursor }
  }

  const indent = /^[ \t]*/.exec(classLine.text)?.[0] ?? ''
  const lineBreak = lineBreakFor(source, classLine)
  const lines = [
    `${indent}/**`,
    `${indent} * `,
    `${indent} */`,
  ]
  const insert = `${lines.join(lineBreak)}${lineBreak}`
  const cursor = classLine.from + lines[0].length + lineBreak.length + lines[1].length
  return { from: classLine.from, insert, cursor }
}

function isJavaDocBodyAt(source: string, position: number): { prefix: string } | null {
  const line = lineAt(source, position)
  const body = /^([ \t]*)\* /.exec(line.text)
  if (!body || position < line.from + body[0].length) {
    return null
  }
  const beforeLine = source.slice(0, line.from)
  if (beforeLine.lastIndexOf('/**') <= beforeLine.lastIndexOf('*/')) {
    return null
  }
  return { prefix: `${body[1]}* ` }
}

/** Format a multiline clipboard payload when it is pasted into JavaDoc text. */
export function formatJavaDocClipboard(text: string, source: string, position: number): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.includes('\n')) {
    return text
  }
  const body = isJavaDocBodyAt(source, position)
  if (!body) {
    return text
  }
  const withoutTrailingNewlines = normalized.replace(/\n+$/, '')
  const lines = withoutTrailingNewlines.split('\n')
  return [lines[0], ...lines.slice(1).map((line) => `${body.prefix}${line}`)].join('\n')
}

/** Copy the selected text, or the current line when there is no selection. */
export function copySelectedText(
  state: EditorState,
  clipboard: Pick<ClipboardBridge, 'writeText'>,
): boolean {
  const selected = state.selection.ranges.filter((range) => !range.empty)
  const text = selected.length > 0
    ? selected
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak)
    : selectedLineBlocks(state)
      .map((block) => state.sliceDoc(block.from, block.to))
      .join('')
  if (!text) {
    return false
  }
  void clipboard.writeText(text)
  return true
}

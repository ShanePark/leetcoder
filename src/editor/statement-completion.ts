import { javaLanguage } from '@codemirror/lang-java'
import {
  getIndentation,
  indentString,
  indentUnit,
  syntaxTree,
} from '@codemirror/language'
import { countColumn, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { maskJavaCommentsAndLiterals } from '../completions/source'
import { collectJavaSymbolsFromMasked } from '../completions/source/symbols'

/** A source line represented with offsets into the original document. */
export interface SourceLine {
  from: number
  to: number
  text: string
}

/** Return the source line containing a document position. */
export function lineAt(source: string, position: number): SourceLine {
  const bounded = Math.max(0, Math.min(position, source.length))
  let from = bounded
  while (from > 0 && source[from - 1] !== '\n' && source[from - 1] !== '\r') {
    from -= 1
  }
  let to = bounded
  while (to < source.length && source[to] !== '\n' && source[to] !== '\r') {
    to += 1
  }
  return { from, to, text: source.slice(from, to) }
}

/** Preserve the line-ending convention used by a source fragment. */
export function lineBreakFor(source: string, line?: SourceLine): string {
  if (line) {
    const following = /^(?:\r\n|\r|\n)/.exec(source.slice(line.to))
    if (following) {
      return following[0]
    }
    const preceding = source.slice(Math.max(0, line.from - 2), line.from)
    if (preceding.endsWith('\r\n')) {
      return '\r\n'
    }
    if (preceding.endsWith('\r')) {
      return '\r'
    }
    if (preceding.endsWith('\n')) {
      return '\n'
    }
  }
  const match = /\r\n|\r|\n/.exec(source)
  return match?.[0] ?? '\n'
}

function isEscaped(source: string, position: number): boolean {
  let backslashes = 0
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

/** Return whether a source position is inside a Java comment or string. */
export function isInsideCommentOrString(source: string, position: number): boolean {
  let blockComment = false
  let lineComment = false
  let textBlock = false
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < position; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (textBlock) {
      if (character === '"' && next === '"' && source[index + 2] === '"'
        && !isEscaped(source, index)) {
        textBlock = false
        index += 2
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (character === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (character === '"' && next === '"' && source[index + 2] === '"'
      && !isEscaped(source, index)) {
      textBlock = true
      index += 2
    } else if (character === '"' || character === "'") {
      quote = character
    }
  }
  return blockComment || lineComment || textBlock || quote !== null
}

/** Return the code portion of one source line, excluding a trailing comment. */
export function lineCodeEnd(text: string): number {
  let blockComment = false
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '/') {
      return index
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (character === '"' || character === "'") {
      quote = character
    }
  }
  return text.length
}

export function balancedJavaDelimiters(text: string): boolean {
  const stack: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character)
      continue
    }
    if (character !== ')' && character !== ']' && character !== '}') {
      continue
    }
    const opening = character === ')' ? '(' : character === ']' ? '[' : '{'
    if (stack.pop() !== opening) {
      return false
    }
  }
  return quote === null && stack.length === 0
}

function missingJavaClosingDelimiters(text: string): string | null {
  const stack: string[] = []
  let blockComment = false
  let lineComment = false
  let quote: '"' | "'" | null = null
  let escaped = false
  let textBlock = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (textBlock) {
      if (character === '"' && next === '"' && text[index + 2] === '"'
        && !isEscaped(text, index)) {
        textBlock = false
        index += 2
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (character === '"' && next === '"' && text[index + 2] === '"'
      && !isEscaped(text, index)) {
      textBlock = true
      index += 2
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      stack.push(')')
      continue
    }
    if (character === '[') {
      stack.push(']')
      continue
    }
    if (character === '{') {
      stack.push('}')
      continue
    }
    if (character !== ')' && character !== ']' && character !== '}') {
      continue
    }
    if (stack.pop() !== character) {
      return null
    }
  }

  if (blockComment || textBlock || quote !== null || stack.includes('}')) {
    return null
  }
  return stack.reverse().join('')
}

type JavaSyntaxNode = ReturnType<typeof syntaxTree>['topNode']

function hasJavaSyntaxError(node: JavaSyntaxNode): boolean {
  if (node.type.isError) {
    return true
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (hasJavaSyntaxError(child)) {
      return true
    }
  }
  return false
}

function isControlHeaderCandidate(text: string, closing: string): boolean {
  if (!closing || !/^(?:if|for|while|switch|catch|synchronized)\s*\(/.test(text)) {
    return false
  }
  const tree = javaLanguage.parser.parse(`${text}${closing};`)
  const node = tree.topNode.firstChild
  return Boolean(
    node
      && !node.nextSibling
      && !hasJavaSyntaxError(tree.topNode)
      && new Set(['IfStatement', 'ForStatement', 'WhileStatement', 'SwitchStatement',
        'CatchClause', 'SynchronizedStatement']).has(node.name),
  )
}

/** Check whether the parser recognizes a fragment as one complete statement. */
export function isStatementCandidate(text: string, closing = ''): boolean {
  const statement = text.trim().replace(/;\s*$/, '').trimEnd()
  if (!statement || missingJavaClosingDelimiters(statement) === null) {
    return false
  }
  if (/^(?:package|import|@)\b/.test(statement)) {
    return false
  }
  const tree = javaLanguage.parser.parse(`${statement}${closing};`)
  const node = tree.topNode.firstChild
  if (!node || node.nextSibling || hasJavaSyntaxError(tree.topNode)) {
    return false
  }
  return new Set([
    'AssertStatement',
    'BreakStatement',
    'ContinueStatement',
    'ExpressionStatement',
    'LocalVariableDeclaration',
    'ReturnStatement',
    'ThrowStatement',
    'YieldStatement',
  ]).has(node.name)
}

export interface JavaStatementCompletion {
  /** Position at which completion text is inserted, before trailing spaces/comments. */
  semicolonFrom: number
  /** Empty when the current statement already has its semicolon. */
  semicolon: string
  /** Closing parentheses/brackets needed to make the statement syntactically complete. */
  closing: string
  /** Cursor position after completion, inside a newly opened block when present. */
  cursor: number
  /** Expands the trailing identifier when it uniquely prefixes one visible symbol. */
  identifier?: { from: number; to: number; insert: string }
  /** Replaces the header's trailing text with a new empty block. */
  block?: { from: number; to: number; insert: string }
}

function planEmptyIfBlock(
  source: string,
  position: number,
  line: SourceLine,
  codeEnd: number,
  indentationUnit: string,
): JavaStatementCompletion | null {
  const statement = source.slice(line.from, codeEnd).trim()
  const closing = missingJavaClosingDelimiters(statement)
  if (!/^if\s*\(/.test(statement) || closing === null) {
    return null
  }
  const header = `${statement}${closing}`
  const tree = javaLanguage.parser.parse(`${header} {}`)
  const node = tree.topNode.firstChild
  if (node?.name !== 'IfStatement' || node.nextSibling || hasJavaSyntaxError(tree.topNode)
    || node.lastChild?.name !== 'Block' || node.lastChild.from !== header.length + 1) {
    return null
  }
  const indent = /^[\t ]*/.exec(line.text)?.[0] ?? ''
  const following = maskJavaCommentsAndLiterals(source.slice(line.to))
  const followingOffset = /\S/.exec(following)?.index
  if (followingOffset !== undefined) {
    const code = following.slice(followingOffset)
    const followingLine = lineAt(source, line.to + followingOffset)
    const followingIndent = /^[\t ]*/.exec(followingLine.text)?.[0] ?? ''
    // Keep explicit and indented bodies; a sibling at the header's indent stays outside the new block.
    if (code.startsWith('{') || /^else\b/.test(code)
      || (!code.startsWith('}') && countColumn(followingIndent, 4) > countColumn(indent, 4))) {
      return null
    }
  }
  const from = line.from + source.slice(line.from, codeEnd).trimEnd().length
  const statementFrom = line.from + line.text.length - line.text.trimStart().length
  const identifier = expandTrailingIdentifier(source, statement, statementFrom, position, `${header};`)
  const growth = identifier ? identifier.insert.length - (identifier.to - identifier.from) : 0
  const lineBreak = lineBreakFor(source, line)
  const opening = `${closing} {${source.slice(from, line.to)}${lineBreak}${indent}${indentationUnit}`
  return {
    semicolonFrom: from,
    semicolon: '',
    closing,
    cursor: from + opening.length + growth,
    block: { from, to: line.to, insert: `${opening}${lineBreak}${indent}}` },
    ...(identifier ? { identifier } : {}),
  }
}

/** Return the one visible symbol name that a trailing, undeclared identifier abbreviates. */
function expandTrailingIdentifier(
  source: string,
  statement: string,
  statementFrom: number,
  position: number,
  parsed: string,
): JavaStatementCompletion['identifier'] | null {
  if (position !== statementFrom + statement.length) {
    return null
  }
  const prefix = /[A-Za-z_$][\w$]*$/.exec(statement)?.[0]
  if (!prefix) {
    return null
  }
  // The parse rejects keywords, declared names, labels, types, and members
  // after `.` or `::`, leaving only bare expression identifiers.
  const node = javaLanguage.parser.parse(parsed).resolveInner(statement.length, -1)
  if (node.name !== 'Identifier' || node.from !== statement.length - prefix.length
    || node.parent?.name === 'FieldAccess' || node.parent?.name === 'MethodReference') {
    return null
  }
  const masked = maskJavaCommentsAndLiterals(source)
  const visible = new Set(collectJavaSymbolsFromMasked(source, position, masked)
    .filter((symbol) => symbol.scopeStart <= position
      && position <= symbol.scopeEnd
      && (symbol.kind === 'field' || symbol.declaredAt <= position)
      // Declarations inside comments or literals are not real symbols.
      && masked.startsWith(symbol.name, symbol.declaredAt))
    .map((symbol) => symbol.name))
  if (visible.has(prefix)) {
    return null
  }
  const matches = [...visible].filter((name) => name.startsWith(prefix))
  return matches.length === 1
    ? { from: position - prefix.length, to: position, insert: matches[0] }
    : null
}

function* multilineStatementStarts(source: string, codeEnd: number): Generator<number> {
  const masked = maskJavaCommentsAndLiterals(source.slice(0, codeEnd)).trimEnd()
  // Semicolons inside a closed lambda body belong to the enclosing statement.
  const stack: string[] = []
  let index = masked.length - 1
  if (masked[index] === ';') index -= 1
  for (; index >= 0; index -= 1) {
    const character = masked[index]
    if (character === ')' || character === ']' || character === '}') {
      // A preceding block may end here; syntax validation distinguishes it
      // from a lambda or anonymous class belonging to the current expression.
      if (character === '}' && stack.length === 0) yield index + 1
      stack.push(character === ')' ? '(' : character === ']' ? '[' : '{')
    } else if (character === '(' || character === '[' || character === '{') {
      if (stack.at(-1) === character) {
        stack.pop()
      } else if (character === '{') {
        yield index + 1
        return
      }
    } else if (character === ';' && stack.length === 0) {
      yield index + 1
      return
    }
  }
  yield 0
}

/** Plan the minimal syntax completion for the current Java statement. */
export function planJavaStatementCompletion(
  source: string,
  position: number,
  indentationUnit = '    ',
): JavaStatementCompletion | null {
  const line = lineAt(source, position)
  if (isInsideCommentOrString(source, line.from) || isInsideCommentOrString(source, position)) {
    return null
  }
  const codeEnd = line.from + lineCodeEnd(line.text)
  if (!source.slice(line.from, codeEnd).trim()) return null
  const block = planEmptyIfBlock(source, position, line, codeEnd, indentationUnit)
  if (block) return block
  const plan = planJavaStatementFrom(source, position, line.from, codeEnd)
  if (plan) return plan
  for (const from of multilineStatementStarts(source, codeEnd)) {
    if (from >= line.from) continue
    const multilinePlan = planJavaStatementFrom(source, position, from, codeEnd)
    if (multilinePlan) return multilinePlan
  }
  return null
}

function planJavaStatementFrom(
  source: string,
  position: number,
  from: number,
  codeEnd: number,
): JavaStatementCompletion | null {
  const code = source.slice(from, codeEnd)
  const trimmed = code.trim()
  if (!trimmed) {
    return null
  }
  const hasSemicolon = /;\s*$/.test(trimmed)
  const statement = hasSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed
  const closing = missingJavaClosingDelimiters(statement)
  const controlHeader = closing !== null && !hasSemicolon
    && isControlHeaderCandidate(statement, closing)
  if (closing === null || (!isStatementCandidate(statement, closing) && !controlHeader)) {
    return null
  }
  const codeEndWithoutSpaces = from + code.trimEnd().length
  const semicolonPosition = hasSemicolon ? codeEndWithoutSpaces - 1 : codeEndWithoutSpaces
  const semicolonFrom = closing && hasSemicolon ? semicolonPosition : codeEndWithoutSpaces
  const semicolon = hasSemicolon || controlHeader ? '' : ';'
  const statementFrom = from + code.length - code.trimStart().length
  const identifier = expandTrailingIdentifier(
    source, statement, statementFrom, position, `${statement}${closing};`,
  )
  const growth = identifier ? identifier.insert.length - (identifier.to - identifier.from) : 0
  return {
    semicolonFrom,
    semicolon,
    closing,
    cursor: growth + (hasSemicolon
      ? codeEndWithoutSpaces + closing.length
      : semicolonFrom + closing.length + semicolon.length),
    ...(identifier ? { identifier } : {}),
  }
}

/** Complete the current Java statement, opening an empty if body when needed. */
export function completeJavaStatement(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1 || !selection.empty) {
    return false
  }
  const plan = planJavaStatementCompletion(state.doc.toString(), selection.head, state.facet(indentUnit))
  if (!plan) {
    return false
  }
  const insert = plan.block ? '' : `${plan.closing}${plan.semicolon}`
  const changes = [
    ...(plan.block ? [plan.block] : []),
    ...(plan.identifier ? [plan.identifier] : []),
    ...(insert ? [{ from: plan.semicolonFrom, insert }] : []),
  ]
  view.dispatch({
    ...(changes.length > 0 ? { changes } : {}),
    selection: { anchor: plan.cursor },
    userEvent: 'input.completeStatement',
  })
  return true
}

/** Move every cursor to its physical line end, correcting blank-line indent when known. */
export function moveToJavaLineEnd(view: EditorView): boolean {
  const { state } = view
  const changes: Array<{ from: number; to: number; insert: string }> = []
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head)
    if (line.text.trim() !== '' || lines.has(line.number)) {
      continue
    }
    lines.add(line.number)
    const columns = getIndentation(state, line.from)
    if (columns === null) {
      continue
    }
    const indent = indentString(state, columns)
    if (indent !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: indent })
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: 'input.indent' })
  }
  const selection = EditorSelection.create(
    view.state.selection.ranges.map((range) => (
      EditorSelection.cursor(view.state.doc.lineAt(range.head).to)
    )),
  )
  view.dispatch({ selection })
  return true
}

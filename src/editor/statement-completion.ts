import { javaLanguage } from '@codemirror/lang-java'
import {
  getIndentation,
  indentString,
  syntaxTree,
} from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

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
  let quote: '"' | "'" | null = null
  let escaped = false
  let textBlock = false

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
  /** Cursor position immediately after the completed statement. */
  cursor: number
}

/** Plan the minimal syntax completion for the current Java statement. */
export function planJavaStatementCompletion(
  source: string,
  position: number,
): JavaStatementCompletion | null {
  const line = lineAt(source, position)
  if (isInsideCommentOrString(source, line.from) || isInsideCommentOrString(source, position)) {
    return null
  }
  const codeEnd = line.from + lineCodeEnd(line.text)
  const code = source.slice(line.from, codeEnd)
  const trimmed = code.trim()
  if (!trimmed || code.includes('/*')) {
    return null
  }
  const hasSemicolon = /;\s*$/.test(trimmed)
  const statement = hasSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed
  const closing = missingJavaClosingDelimiters(statement)
  if (closing === null || !isStatementCandidate(statement, closing)) {
    return null
  }
  const codeEndWithoutSpaces = line.from + code.trimEnd().length
  const semicolonPosition = hasSemicolon ? codeEndWithoutSpaces - 1 : codeEndWithoutSpaces
  const semicolonFrom = closing && hasSemicolon ? semicolonPosition : codeEndWithoutSpaces
  const semicolon = hasSemicolon ? '' : ';'
  return {
    semicolonFrom,
    semicolon,
    closing,
    cursor: hasSemicolon
      ? codeEndWithoutSpaces + closing.length
      : semicolonFrom + closing.length + semicolon.length,
  }
}

/** Complete the current Java statement without inserting a line break. */
export function completeJavaStatement(view: EditorView): boolean {
  const { state } = view
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1 || !selection.empty) {
    return false
  }
  const plan = planJavaStatementCompletion(state.doc.toString(), selection.head)
  if (!plan) {
    return false
  }
  const insert = `${plan.closing}${plan.semicolon}`
  view.dispatch({
    ...(insert ? { changes: { from: plan.semicolonFrom, insert } } : {}),
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

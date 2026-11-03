import { javaLanguage } from '@codemirror/lang-java'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  findBareJavaTest,
  findJavaTestBlock,
  isJavaTestMethod,
  javaBlockStatements,
  type JavaBodyRange,
} from './test-markers'

export const AI_TESTS_USER_EVENT = 'input.aiTests'
export const MAX_AI_TEST_STATEMENTS = 64
export const MAX_AI_TEST_STATEMENT_LENGTH = 8192

export type AiTestRejectionReason =
  | 'stub-missing'
  | 'stub-filled'
  | 'no-statements'
  | 'too-many-statements'
  | 'statement-too-long'
  | 'not-one-line'
  | 'comment'
  | 'unicode-escape'
  | 'unterminated-literal'
  | 'unbalanced-brackets'
  | 'semicolon'
  | 'syntax-error'
  | 'not-one-statement'
  | 'outside-test-body'

export interface AiTestRejection {
  ok: false
  reason: AiTestRejectionReason
}

/** One replacement of the body of `test()`. */
export interface AiTestPlan {
  ok: true
  from: number
  to: number
  insert: string
}

export type AiTestResult = AiTestPlan | AiTestRejection

const OPENING_BRACKET: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

/**
 * Whitespace around a statement, a trailing newline included, never reaches the
 * document, so only what is left is checked. A line break inside it still fails.
 */
function statementRejection(untrimmed: string): AiTestRejectionReason | null {
  const statement = untrimmed.trim()
  if (statement.length > MAX_AI_TEST_STATEMENT_LENGTH) {
    return 'statement-too-long'
  }
  if (/[\r\n\u2028\u2029]/.test(statement)) {
    return 'not-one-line'
  }
  // javac expands these before tokenizing, so `}` would be a real `}` that
  // no check here could see. A rare literal `\\u` is rejected along with them.
  if (statement.includes('\\u')) {
    return 'unicode-escape'
  }
  const open: string[] = []
  let literal: string | null = null
  let semicolon = -1
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index]
    if (literal) {
      if (character === '\\') index += 1
      else if (character === literal) literal = null
    } else if (character === '"' || character === "'") {
      literal = character
    } else if (character === '/' && (statement[index + 1] === '/' || statement[index + 1] === '*')) {
      return 'comment'
    } else if (character === '(' || character === '[' || character === '{') {
      open.push(character)
    } else if (OPENING_BRACKET[character]) {
      if (open.pop() !== OPENING_BRACKET[character]) return 'unbalanced-brackets'
    } else if (character === ';') {
      if (semicolon >= 0) return 'semicolon'
      semicolon = index
    }
  }
  if (literal) {
    return 'unterminated-literal'
  }
  if (open.length > 0) {
    return 'unbalanced-brackets'
  }
  return semicolon >= 0 && semicolon === statement.length - 1 && statement !== ';'
    ? null
    : 'semicolon'
}

/** Check count, length, and the shape of each statement, without any document. */
export function validateAiTestStatements(statements: readonly string[]): AiTestRejectionReason | null {
  if (statements.length === 0) {
    return 'no-statements'
  }
  if (statements.length > MAX_AI_TEST_STATEMENTS) {
    return 'too-many-statements'
  }
  for (const statement of statements) {
    const rejection = statementRejection(statement)
    if (rejection) return rejection
  }
  return null
}

/** Render a replacement body: one indented line per statement, and `}` on its own line. */
export function formatAiTestBody(
  source: string,
  body: JavaBodyRange,
  statements: readonly string[],
): string {
  const text = source.slice(body.from, body.to)
  const lineStart = source.lastIndexOf('\n', body.from - 1) + 1
  const openingIndent = /^[\t ]*/.exec(source.slice(lineStart, body.from))?.[0] ?? ''
  const closingIndent = /\n([\t ]*)$/.exec(text)?.[1] ?? openingIndent
  const statementIndent = /^\s*\n([\t ]*)\S/.exec(text)?.[1]
    ?? `${closingIndent}${closingIndent.includes('\t') ? '\t' : '    '}`
  const lines = statements.map((statement) => `${statementIndent}${statement.trim()}`)
  return `\n${lines.join('\n')}\n${closingIndent}`
}

/**
 * Every node outside the Block with its position after the edit. The Block
 * itself is listed, but not its contents.
 */
function outlineAroundBlock(
  tree: Tree,
  block: JavaBodyRange,
  position: (value: number) => number,
): string[] {
  const outline: string[] = []
  tree.iterate({
    enter(node) {
      outline.push(`${node.name}:${position(node.from)}:${position(node.to)}`)
      return node.name === 'Block' && node.from === block.from && node.to === block.to ? false : undefined
    },
  })
  return outline
}

/**
 * Parse the document with `insert` as the body of `test()` and require that only
 * that body changed. The template's unfinished `assertThat()` and any errors the
 * user has elsewhere are not this edit's to answer for, so errors are not counted
 * across the document. Instead the body must be free of errors, and the tree
 * around it must match the document with an empty body node for node, which also
 * catches a new error outside the body. The empty body is the baseline because
 * an error inside the stub can change how the parser recovers from a later one.
 */
export function checkAiTestCandidate(
  source: string,
  body: JavaBodyRange,
  insert: string,
): AiTestRejectionReason | null {
  const before = source.slice(0, body.from)
  const after = source.slice(body.to)
  const candidate = `${before}${insert}${after}`
  const candidateTree = javaLanguage.parser.parse(candidate)
  const block = findJavaTestBlock(candidate, candidateTree.topNode)
  if (!block || block.from !== body.from - 1 || block.to !== body.from + insert.length + 1) {
    return 'outside-test-body'
  }

  let hasError = false
  block.cursor().iterate((node) => {
    if (node.type.isError) hasError = true
    return !hasError
  })
  if (hasError) {
    return 'syntax-error'
  }

  const emptyBlock = { from: block.from, to: body.from + 1 }
  const original = outlineAroundBlock(
    javaLanguage.parser.parse(`${before}${after}`),
    emptyBlock,
    (position) => (position >= emptyBlock.to ? position + insert.length : position),
  )
  const updated = outlineAroundBlock(candidateTree, block, (position) => position)
  if (original.length !== updated.length || original.some((entry, index) => entry !== updated[index])) {
    return 'outside-test-body'
  }

  // Each line must be exactly one statement. This refuses `class A {} int x = 1;`
  // and an `else` line that merges into the `if` above it.
  const expected: JavaBodyRange[] = []
  let lineFrom = body.from
  for (const line of insert.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) {
      const from = lineFrom + line.indexOf(trimmed)
      expected.push({ from, to: from + trimmed.length })
    }
    lineFrom += line.length + 1
  }
  const statements = javaBlockStatements(block)
  return statements.length === expected.length
    && statements.every((node, index) => node.from === expected[index].from && node.to === expected[index].to)
    ? null
    : 'not-one-statement'
}

/**
 * Decide how to fill the bare stub of `source`. Model output is untrusted, so the
 * whole result is rejected on any failed check.
 */
export function planAiTestInsertion(source: string, statements: readonly string[]): AiTestResult {
  const stub = findBareJavaTest(source)
  if (stub.status !== 'bare') {
    return { ok: false, reason: stub.status === 'missing' ? 'stub-missing' : 'stub-filled' }
  }
  const invalid = validateAiTestStatements(statements)
  if (invalid) {
    return { ok: false, reason: invalid }
  }
  const insert = formatAiTestBody(source, stub.body, statements)
  const rejected = checkAiTestCandidate(source, stub.body, insert)
  return rejected
    ? { ok: false, reason: rejected }
    : { ok: true, from: stub.body.from, to: stub.body.to, insert }
}

/**
 * Apply statements in one transaction, planned against the current document. The
 * `input` event lets `javaAutoImports` add imports to that same transaction, and
 * its `aiTests` subtype matches neither the events that reindent or open the
 * completion popup nor those that history joins with neighbouring edits.
 */
export function applyAiTestStatements(view: EditorView, statements: readonly string[]): AiTestResult {
  const plan = planAiTestInsertion(view.state.doc.toString(), statements)
  if (plan.ok) {
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      userEvent: AI_TESTS_USER_EVENT,
    })
  }
  return plan
}

function methodHeader(source: string, method: SyntaxNode): string {
  const end = method.getChild('Block')?.from ?? method.to
  const parts: string[] = []
  let cursor = method.from
  method.cursor().iterate((node) => {
    if (node.name === 'Block') {
      return false
    }
    if (['MarkerAnnotation', 'Annotation', 'LineComment', 'BlockComment'].includes(node.name)) {
      parts.push(source.slice(cursor, node.from))
      cursor = node.to
      return false
    }
    return undefined
  })
  parts.push(source.slice(cursor, end))
  return parts.join(' ').replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim()
}

/**
 * List the headers of non-test methods for the model, without annotations,
 * comments, or bodies. Methods of local and anonymous classes live inside a body
 * and stay out with it.
 */
export function listJavaMethodHeaders(source: string): string[] {
  const headers: string[] = []
  javaLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== 'MethodDeclaration') return undefined
      if (!isJavaTestMethod(source, node.node)) headers.push(methodHeader(source, node.node))
      return false
    },
  })
  return headers
}

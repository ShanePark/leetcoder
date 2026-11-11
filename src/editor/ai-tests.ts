import { javaLanguage } from '@codemirror/lang-java'
import { EditorSelection } from '@codemirror/state'
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
  | 'class-missing'

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

/** One insertion of a new test method, named so the user can find it. */
export type AiCaseTestResult = (AiTestPlan & { methodName: string }) | AiTestRejection

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
  methodName = 'test',
): AiTestRejectionReason | null {
  const before = source.slice(0, body.from)
  const after = source.slice(body.to)
  const candidate = `${before}${insert}${after}`
  const candidateTree = javaLanguage.parser.parse(candidate)
  const block = findJavaTestBlock(candidate, candidateTree.topNode, methodName)
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

/** Where a new test method goes, and how it is written. */
export interface AiCaseTestSlot {
  methodName: string
  /** Right after the last @Test method, or after the class's last member. */
  at: number
  /** Blank line, annotation, header, and opening brace, as inserted at `at`. */
  head: string
}

function directChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child)
  return children
}

function lineIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf('\n', position - 1) + 1
  return /^[\t ]*/.exec(source.slice(lineStart))?.[0] ?? ''
}

function methodName(source: string, method: SyntaxNode): string | null {
  const definition = method.getChild('Definition')
  return definition ? source.slice(definition.from, definition.to) : null
}

/**
 * Find where a failing case's test method goes: the class of the last @Test
 * method among top-level classes, or else the first top-level class. The name
 * is one past the highest of `test` (1) and `test<digits>` among the class's
 * methods, at least `test2`. Indentation and modifiers follow the last @Test
 * method. Null when no top-level class has an intact body.
 */
export function findAiCaseTestSlot(source: string): AiCaseTestSlot | null {
  const root = javaLanguage.parser.parse(source).topNode
  const bodies = directChildren(root)
    .filter((node) => node.name === 'ClassDeclaration')
    .map((node) => node.getChild('ClassBody'))
    .filter((body): body is SyntaxNode => body?.firstChild?.name === '{' && body.lastChild?.name === '}')
  const testsOf = (body: SyntaxNode): SyntaxNode[] => directChildren(body)
    .filter((node) => node.name === 'MethodDeclaration' && isJavaTestMethod(source, node))
  const body = [...bodies].reverse().find((candidate) => testsOf(candidate).length > 0) ?? bodies[0]
  if (!body) {
    return null
  }

  const members = directChildren(body).slice(1, -1)
  const numbers = members
    .filter((node) => node.name === 'MethodDeclaration')
    .map((node) => /^test(\d*)$/.exec(methodName(source, node) ?? ''))
    .map((match) => (match ? Number(match[1] || '1') : 0))
  const name = `test${Math.max(1, ...numbers) + 1}`

  const lastTest = testsOf(body).at(-1)
  const anchor = lastTest ?? members.at(-1)
  const indent = anchor
    ? lineIndent(source, anchor.from)
    : `${lineIndent(source, body.from)}    `
  // A @Test method always has Modifiers, since they hold the annotation.
  const modifiers = lastTest
    ? directChildren(lastTest.getChild('Modifiers')!)
      .filter((node) => !['MarkerAnnotation', 'Annotation', 'LineComment', 'BlockComment'].includes(node.name))
      .map((node) => source.slice(node.from, node.to))
    : ['public']
  const header = [...modifiers, 'void', `${name}()`].join(' ')
  return {
    methodName: name,
    at: anchor?.to ?? body.from + 1,
    head: `${anchor ? '\n\n' : '\n'}${indent}@Test\n${indent}${header} {`,
  }
}

/**
 * Decide how to add a new test method holding `statements`. The method is
 * placed with an empty body first, and the body is then checked exactly like
 * a fill of `test()`, so the statements cannot reach outside the new method.
 */
export function planAiCaseTestInsertion(source: string, statements: readonly string[]): AiCaseTestResult {
  const slot = findAiCaseTestSlot(source)
  if (!slot) {
    return { ok: false, reason: 'class-missing' }
  }
  const invalid = validateAiTestStatements(statements)
  if (invalid) {
    return { ok: false, reason: invalid }
  }
  const withMethod = `${source.slice(0, slot.at)}${slot.head}}${source.slice(slot.at)}`
  const bodyFrom = slot.at + slot.head.length
  const body = { from: bodyFrom, to: bodyFrom }
  const insert = formatAiTestBody(withMethod, body, statements)
  const rejected = checkAiTestCandidate(withMethod, body, insert, slot.methodName)
  return rejected
    ? { ok: false, reason: rejected }
    : { ok: true, from: slot.at, to: slot.at, insert: `${slot.head}${insert}}`, methodName: slot.methodName }
}

/**
 * Add the new test method in one transaction, as `applyAiTestStatements` does,
 * and put the cursor on its first statement so it is in view and the run-test-
 * at-cursor shortcut targets it.
 */
export function applyAiCaseTestStatements(view: EditorView, statements: readonly string[]): AiCaseTestResult {
  const plan = planAiCaseTestInsertion(view.state.doc.toString(), statements)
  if (plan.ok) {
    const firstLine = plan.insert.indexOf('\n', plan.insert.indexOf('{')) + 1
    const firstStatement = firstLine + /^[\t ]*/.exec(plan.insert.slice(firstLine))![0].length
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: EditorSelection.cursor(plan.from + firstStatement),
      scrollIntoView: true,
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

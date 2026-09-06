import {
  importLines,
  JAVA_TYPE_IMPORTS,
  maskJavaCommentsAndLiterals,
  type ImportLine,
} from './completions'
import { javaLanguage } from '@codemirror/lang-java'

/** A run of import statements separated only by blank lines. */
export interface ImportBlock {
  /** Offset of the first import line's first character. */
  from: number
  /** Offset just past the last import statement, excluding its line break. */
  to: number
  /** How many import statements the block contains. */
  count: number
}

/** At most one blank line in a row survives a reformat. */
const MAX_CONSECUTIVE_BLANK_LINES = 1

function lineBreakOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * The contiguous import section at the top of a Java file.
 *
 * `importLines` also matches imports that appear after code, which is invalid
 * Java but possible while editing. Only the leading run is treated as a block
 * so folding and sorting never reach across unrelated source.
 */
export function importBlockRange(source: string): ImportBlock | null {
  const lines = importLines(source)
  const first = lines[0]
  if (!first) {
    return null
  }
  let last = first
  let count = 1
  for (const line of lines.slice(1)) {
    if (source.slice(last.to, line.from).trim() !== '') {
      break
    }
    last = line
    count += 1
  }
  let to = last.to
  while (to > last.from && (source[to - 1] === '\n' || source[to - 1] === '\r')) {
    to -= 1
  }
  return { from: first.from, to, count }
}

/** The source with comments, literals, and every import line blanked out. */
function codeOutsideImports(source: string, lines: readonly ImportLine[]): string {
  let masked = maskJavaCommentsAndLiterals(source)
  for (const line of lines) {
    masked = masked.slice(0, line.from) + ' '.repeat(line.to - line.from) + masked.slice(line.to)
  }
  return masked
}

function referencesType(code: string, typeName: string): boolean {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(code)
}

/**
 * Drop imports for types this editor knows how to add back.
 *
 * Only imports matching the auto-import catalog are removed. An import the
 * user wrote by hand can be used in ways a regex cannot see — annotations,
 * nested types, JavaDoc references — so leaving it alone is the safe default.
 *
 * `typingPrefix` is the identifier under the cursor. A type whose name starts
 * with it is kept, so a half-retyped `Lis` does not drop the `List` import
 * that the next keystroke would ask for again.
 */
export function removeUnusedJavaTypeImports(source: string, typingPrefix: string | null = null): string {
  const lines = importLines(source)
  if (lines.length === 0) {
    return source
  }
  const code = codeOutsideImports(source, lines)
  const unused = lines.filter((line) => {
    if (line.static || line.name.endsWith('.*')) {
      return false
    }
    const typeName = line.name.slice(line.name.lastIndexOf('.') + 1)
    if (typingPrefix && typeName.startsWith(typingPrefix)) {
      return false
    }
    return JAVA_TYPE_IMPORTS[typeName] === line.name && !referencesType(code, typeName)
  })
  if (unused.length === 0) {
    return source
  }

  let updated = source
  for (const line of [...unused].reverse()) {
    updated = updated.slice(0, line.from) + updated.slice(line.to)
  }
  if (importLines(updated).length === 0) {
    // Removing the whole section leaves the blank line above it next to the
    // blank line below it.
    updated = updated.replace(/(\r?\n)(?:\r?\n)+/, (_match, first: string) => `${first}${first}`)
  }
  return updated
}

/** Sort and de-duplicate the leading import block, ordinary imports first. */
export function organizeJavaImports(source: string): string {
  const block = importBlockRange(source)
  if (!block) {
    return source
  }
  const lines = importLines(source).slice(0, block.count)
  const newline = lineBreakOf(source)
  const names = (isStatic: boolean): string[] => [
    ...new Set(lines.filter((line) => line.static === isStatic).map((line) => line.name)),
  ].sort((left, right) => left.localeCompare(right))

  const ordinary = names(false)
  const statics = names(true)
  const text = [
    ...ordinary.map((name) => `import ${name};`),
    ...(ordinary.length > 0 && statics.length > 0 ? [''] : []),
    ...statics.map((name) => `import static ${name};`),
  ].join(newline)
  return source.slice(0, block.from) + text + source.slice(block.to)
}

type JavaSyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode']

interface JavaSyntaxToken {
  name: string
  from: number
  to: number
}

interface JavaWhitespaceEdit {
  from: number
  to: number
  insert: string
}

const CONTROL_KEYWORDS_REQUIRING_SPACE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized',
])

const BINARY_OPERATOR_NODES = new Set([
  'AssignOp', 'ArithOp', 'CompareOp', 'LogicOp', 'BitOp',
])

const UNARY_OPERATOR_NODES = new Set(['ArithOp', 'LogicOp', 'BitOp'])

function isInlineWhitespace(source: string, from: number, to: number): boolean {
  return /^[ \t]*$/.test(source.slice(from, to))
}

function collectJavaSyntaxTokens(node: JavaSyntaxNode, tokens: JavaSyntaxToken[]): void {
  if (node.firstChild === null) {
    if (node.to > node.from) {
      tokens.push({ name: node.type.name, from: node.from, to: node.to })
    }
    return
  }
  let child: JavaSyntaxNode | null = node.firstChild
  while (child !== null) {
    const next: JavaSyntaxNode | null = child.nextSibling
    collectJavaSyntaxTokens(child, tokens)
    child = next
  }
}

function previousToken(tokens: readonly JavaSyntaxToken[], index: number): JavaSyntaxToken | null {
  return index > 0 ? tokens[index - 1] : null
}

function nextToken(tokens: readonly JavaSyntaxToken[], index: number): JavaSyntaxToken | null {
  return index + 1 < tokens.length ? tokens[index + 1] : null
}

/**
 * Add a single inline space to a token boundary while leaving comments and
 * multiline layout untouched. Parser token ranges let this pass distinguish
 * operators from generic type brackets and unary/update operators.
 */
function ensureInlineSpace(
  source: string,
  from: number,
  to: number,
  edits: JavaWhitespaceEdit[],
): void {
  if (!isInlineWhitespace(source, from, to)) {
    return
  }
  edits.push({ from, to, insert: ' ' })
}

function collectJavaTokenWhitespaceEdits(source: string): JavaWhitespaceEdit[] {
  const tree = javaLanguage.parser.parse(source).topNode
  const tokens: JavaSyntaxToken[] = []
  collectJavaSyntaxTokens(tree, tokens)
  tokens.sort((left, right) => left.from - right.from || left.to - right.to)
  const tokenIndexByRange = new Map<string, number>()
  tokens.forEach((token, index) => tokenIndexByRange.set(`${token.from}:${token.to}`, index))

  const edits: JavaWhitespaceEdit[] = []

  const addOperatorSpacing = (node: JavaSyntaxNode, parentName: string | null): void => {
    const index = tokenIndexByRange.get(`${node.from}:${node.to}`) ?? -1
    if (index < 0) {
      return
    }
    const previous = previousToken(tokens, index)
    const next = nextToken(tokens, index)
    if (!previous || !next) {
      return
    }

    const operator = source.slice(node.from, node.to)
    if (UNARY_OPERATOR_NODES.has(node.type.name) && parentName === 'UnaryExpression') {
      return
    }

    const isBinary = node.type.name === 'AssignOp'
      || (BINARY_OPERATOR_NODES.has(node.type.name)
        && (parentName === 'BinaryExpression' || parentName === 'TernaryExpression'))
    if (!isBinary) {
      return
    }
    // `?` is represented as LogicOp in a ternary expression. It follows the
    // same inline spacing rule as the other binary operators.
    if (operator === '!' || operator === '~' || operator === '++' || operator === '--') {
      return
    }
    ensureInlineSpace(source, previous.to, node.from, edits)
    ensureInlineSpace(source, node.to, next.from, edits)
  }

  const visit = (node: JavaSyntaxNode, parentName: string | null): void => {
    if (BINARY_OPERATOR_NODES.has(node.type.name)) {
      addOperatorSpacing(node, parentName)
    }
    if (node.firstChild !== null) {
      let child: JavaSyntaxNode | null = node.firstChild
      while (child !== null) {
        const next: JavaSyntaxNode | null = child.nextSibling
        visit(child, node.type.name)
        child = next
      }
    }
  }
  visit(tree, null)

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const previous = previousToken(tokens, index)
    const next = nextToken(tokens, index)

    if (CONTROL_KEYWORDS_REQUIRING_SPACE.has(token.name) && next?.name === '(') {
      ensureInlineSpace(source, token.to, next.from, edits)
    }

    if (token.name === '{' && previous) {
      if (previous.name !== '(' && previous.name !== '[' && previous.name !== '{') {
        ensureInlineSpace(source, previous.to, token.from, edits)
      }
    } else if (token.name === '}' && next && ['else', 'catch', 'finally', 'while'].includes(next.name)) {
      ensureInlineSpace(source, token.to, next.from, edits)
    }
  }

  // Multiple rules can address the same boundary, such as `={`. Keep one
  // deterministic edit for it before applying changes from right to left.
  const unique = new Map<string, JavaWhitespaceEdit>()
  for (const edit of edits) {
    unique.set(`${edit.from}:${edit.to}`, edit)
  }
  return [...unique.values()].sort((left, right) => right.from - left.from)
}

/**
 * Normalize whitespace around Java tokens.
 *
 * CodeMirror's Java indentation service only changes leading indentation. A
 * small text pass fills the gap for common spacing errors that can be fixed
 * without reprinting the whole syntax tree. The masked source keeps
 * punctuation inside comments and literals invisible to the delimiter pass;
 * parser token ranges provide the same protection for operators.
 */
function normalizeJavaTokenWhitespace(source: string): string {
  const masked = maskJavaCommentsAndLiterals(source)
  let normalized = ''
  let index = 0

  while (index < source.length) {
    const current = source[index]
    if (current === ' ' || current === '\t') {
      let end = index + 1
      while (end < source.length && (source[end] === ' ' || source[end] === '\t')) {
        end += 1
      }

      const previous = index > 0 ? masked[index - 1] : ''
      const next = end < source.length ? masked[end] : ''
      const lineStart = Math.max(source.lastIndexOf('\n', index - 1) + 1, source.lastIndexOf('\r', index - 1) + 1)
      const onlyIndentation = source.slice(lineStart, index).trim() === ''
      const followsComment = source[end] === '/'
        && (source[end + 1] === '/' || source[end + 1] === '*')

      if (previous === ',' && next !== '\r' && next !== '\n' && next !== ')' && next !== ']') {
        normalized += ' '
      } else if (next === ',' || ((next === ')' || next === ']') && !onlyIndentation)) {
        // Java style has no space before a comma or a closing delimiter.
      } else if ((previous === '(' || previous === '[') && !onlyIndentation && !followsComment) {
        // Java style has no space just inside an opening delimiter.
      } else {
        normalized += source.slice(index, end)
      }
      index = end
      continue
    }

    normalized += current
    if (masked[index] === ',') {
      const next = source[index + 1]
      const startsComment = next === '/' && (source[index + 2] === '/' || source[index + 2] === '*')
      if (next
        && next !== ' ' && next !== '\t'
        && next !== '\r' && next !== '\n'
        && next !== ')' && next !== ']'
        && !startsComment) {
        normalized += ' '
      }
    }
    index += 1
  }
  const edits = collectJavaTokenWhitespaceEdits(normalized)
  for (const edit of edits) {
    normalized = `${normalized.slice(0, edit.from)}${edit.insert}${normalized.slice(edit.to)}`
  }
  return normalized
}

/** Trim trailing spaces, normalize token spacing, cap blank-line runs, and end with one line break. */
export function normalizeJavaWhitespace(source: string): string {
  const newline = lineBreakOf(source)
  const kept: string[] = []
  let blanks = 0
  for (const raw of normalizeJavaTokenWhitespace(source).split(/\r?\n/)) {
    const line = raw.replace(/[\t ]+$/, '')
    if (line === '') {
      blanks += 1
      if (blanks > MAX_CONSECUTIVE_BLANK_LINES) {
        continue
      }
    } else {
      blanks = 0
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') {
    kept.pop()
  }
  return kept.length === 0 ? '' : `${kept.join(newline)}${newline}`
}

/**
 * The text-level half of the reformat command. Indentation is left to
 * CodeMirror's Java language support, which already knows the syntax tree.
 */
export function formatJavaSource(source: string): string {
  return normalizeJavaWhitespace(organizeJavaImports(removeUnusedJavaTypeImports(source)))
}

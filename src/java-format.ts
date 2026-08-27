import {
  importLines,
  JAVA_TYPE_IMPORTS,
  maskJavaCommentsAndLiterals,
  type ImportLine,
} from './completions'

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

/** Trim trailing spaces, cap blank-line runs, and end with one line break. */
export function normalizeJavaWhitespace(source: string): string {
  const newline = lineBreakOf(source)
  const kept: string[] = []
  let blanks = 0
  for (const raw of source.split(/\r?\n/)) {
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

import {
  isInsideCommentOrString,
  lineAt,
  lineBreakFor,
  type SourceLine,
} from '../statement-completion'

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

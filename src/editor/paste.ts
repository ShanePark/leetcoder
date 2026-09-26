import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ClipboardBridge } from '../clipboard'
import { formatJavaDocClipboard } from './editing'

interface StringContentRange {
  from: number
  to: number
}

interface JavaUnicodeEscape {
  end: number
  value: number
}

function javaUnicodeEscapeAt(source: string, slashEnd: number, contentTo: number): JavaUnicodeEscape | null {
  if (source[slashEnd] !== 'u') return null
  let digitsStart = slashEnd + 1
  while (digitsStart < contentTo && source[digitsStart] === 'u') digitsStart += 1
  const digits = source.slice(digitsStart, digitsStart + 4)
  if (!/^[\da-fA-F]{4}$/.test(digits)) return null
  return { end: digitsStart + 4, value: Number.parseInt(digits, 16) }
}

// Java processes Unicode escapes before tokenization, so these values can
// make the parser's raw-source string boundaries unreliable.
function hasContextChangingUnicodeEscape(source: string, contentFrom: number, contentTo: number): boolean {
  for (let index = contentFrom; index < contentTo;) {
    if (source[index] !== '\\') {
      index += 1
      continue
    }

    let slashEnd = index + 1
    while (slashEnd < contentTo && source[slashEnd] === '\\') slashEnd += 1
    if ((slashEnd - index) % 2 === 1) {
      const escape = javaUnicodeEscapeAt(source, slashEnd, contentTo)
      if (escape && [0x000a, 0x000d, 0x0022, 0x005c].includes(escape.value)) return true
    }
    index = slashEnd
  }
  return false
}

function stringContentForRange(
  source: string,
  tree: ReturnType<typeof syntaxTree>,
  range: { from: number; to: number },
): StringContentRange | null {
  const node = tree.resolveInner(range.from, 1)
  if (node.name !== 'StringLiteral'
    || source[node.from] !== '"'
    || source[node.to - 1] !== '"') {
    return null
  }

  const content = { from: node.from + 1, to: node.to - 1 }
  if (hasContextChangingUnicodeEscape(source, content.from, content.to)
    || range.from < content.from || range.to > content.to
    || splitsJavaEscape(source, content.from, content.to, range.from)
    || splitsJavaEscape(source, content.from, content.to, range.to)) {
    return null
  }

  return content
}

/** Return whether a position would split a Java escape already in the source. */
function splitsJavaEscape(source: string, contentFrom: number, contentTo: number, position: number): boolean {
  let precedingBackslashes = 0
  for (let index = position - 1; index >= contentFrom && source[index] === '\\'; index -= 1) {
    precedingBackslashes += 1
  }
  if (precedingBackslashes % 2 === 1) {
    return true
  }

  for (let index = contentFrom; index < contentTo;) {
    if (source[index] !== '\\') {
      index += 1
      continue
    }

    let slashEnd = index + 1
    while (slashEnd < contentTo && source[slashEnd] === '\\') slashEnd += 1
    const slashCount = slashEnd - index
    if (slashCount % 2 === 1) {
      const escapeStart = slashEnd - 1
      const next = source[slashEnd]
      if (next === 'u') {
        const escape = javaUnicodeEscapeAt(source, slashEnd, contentTo)
        if (escape && escapeStart < position && position < escape.end) return true
        if (escape?.value === 0x005c && position === escape.end) return true
      } else if (next >= '0' && next <= '7') {
        const maxDigits = next <= '3' ? 3 : 2
        let escapeEnd = slashEnd + 1
        while (escapeEnd < contentTo && escapeEnd < slashEnd + maxDigits
          && source[escapeEnd] >= '0' && source[escapeEnd] <= '7') {
          escapeEnd += 1
        }
        if (escapeStart < position && position < escapeEnd) return true
      }
    }
    index = slashEnd
  }

  return false
}

/** Escape clipboard characters so they remain the same value inside a Java string literal. */
export function escapeJavaStringContent(text: string): string {
  const escaped: string[] = []
  for (const character of text) {
    switch (character) {
      case '"': escaped.push('\\"'); break
      case '\\': escaped.push('\\\\'); break
      case '\b': escaped.push('\\b'); break
      case '\t': escaped.push('\\t'); break
      case '\n': escaped.push('\\n'); break
      case '\f': escaped.push('\\f'); break
      case '\r': escaped.push('\\r'); break
      default: {
        const codePoint = character.codePointAt(0) ?? 0
        if (codePoint < 0x20 || codePoint === 0x7f) {
          escaped.push(`\\${codePoint.toString(8).padStart(3, '0')}`)
        } else {
          escaped.push(character)
        }
      }
    }
  }
  return escaped.join('')
}

/** Escape a paste only when every selection stays inside ordinary string content. */
export function escapeJavaStringPaste(text: string, state: EditorState): string | null {
  const parseThrough = state.selection.ranges.reduce((end, range) => Math.max(end, range.to), 0)
  const tree = ensureSyntaxTree(state, parseThrough, 50)
  if (!tree) return null

  const source = state.doc.toString()
  const ranges = state.selection.ranges
  if (ranges.length === 0 || !ranges.every((range) => stringContentForRange(source, tree, range))) {
    return null
  }
  return escapeJavaStringContent(text)
}

/** Apply Java string escaping, retaining the existing JavaDoc paste behavior elsewhere. */
export function formatJavaClipboardPaste(text: string, state: EditorState): string {
  const escaped = escapeJavaStringPaste(text, state)
  if (escaped !== null) return escaped
  if (state.selection.ranges.length !== 1) return text
  return formatJavaDocClipboard(text, state.doc.toString(), state.selection.main.head)
}

/** Handle native paste only when string-literal escaping changes the clipboard text. */
export function handleJavaStringPaste(event: ClipboardEvent, view: EditorView): boolean {
  if (view.state.readOnly) return false
  const clipboard = event.clipboardData
  if (!clipboard) return false

  const text = clipboard.getData('text/plain') || clipboard.getData('text/uri-list')
  if (!text) return false

  const escaped = escapeJavaStringPaste(text, view.state)
  if (escaped === null || escaped === text) return false

  event.preventDefault()
  view.dispatch({
    ...view.state.replaceSelection(escaped),
    userEvent: 'input.paste',
    scrollIntoView: true,
  })
  return true
}

/** Read and paste clipboard text through the same formatting used by native paste. */
export function pasteJavaClipboard(
  view: EditorView,
  clipboard: Pick<ClipboardBridge, 'readText'>,
): boolean {
  void clipboard.readText().then((text) => {
    if (!text) return
    const state = view.state
    const insert = formatJavaClipboardPaste(text, state)
    view.dispatch({
      ...state.replaceSelection(insert),
      userEvent: 'input.paste',
      scrollIntoView: true,
    })
  })
  return true
}

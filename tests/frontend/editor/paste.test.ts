import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import {
  escapeJavaStringContent,
  escapeJavaStringPaste,
  formatJavaClipboardPaste,
  handleJavaStringPaste,
  pasteJavaClipboard,
} from '../../../src/editor/paste'
import { javaState } from './helpers'

function stateAt(source: string, anchor: number, head = anchor, allowMultipleSelections = false): EditorState {
  const state = javaState(source, allowMultipleSelections)
  return state.update({ selection: EditorSelection.single(anchor, head) }).state
}

function applyClipboardPaste(state: EditorState, text: string): EditorState {
  return state.update(state.replaceSelection(formatJavaClipboardPaste(text, state))).state
}

function editorHarness(initial: EditorState): {
  view: EditorView
  state: () => EditorState
  transactions: Transaction[]
} {
  let current = initial
  const transactions: Transaction[] = []
  const view = {
    get state() {
      return current
    },
    dispatch: (spec: Transaction | TransactionSpec) => {
      const transaction = spec instanceof Transaction ? spec : current.update(spec)
      transactions.push(transaction)
      current = transaction.state
    },
  } as unknown as EditorView
  return { view, state: () => current, transactions }
}

function nativePasteEvent(options: { plainText?: string; uriList?: string } = {}): ClipboardEvent {
  const { plainText = '', uriList = '' } = options
  return {
    clipboardData: {
      getData: vi.fn((type: string) => type === 'text/plain' ? plainText : type === 'text/uri-list' ? uriList : ''),
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent
}

describe('Java string paste escaping', () => {
  it('escapes the JSON array pasted into the full assertion example', () => {
    const source = 'assertThat(evaluate("(name)is(age)yearsold", Ps.strList(""))).isEqualTo("");'
    const position = source.indexOf('Ps.strList("') + 'Ps.strList("'.length
    const state = stateAt(source, position)
    const output = applyClipboardPaste(state, '[["name","bob"],["age","two"]]')

    expect(output.doc.toString()).toBe(
      String.raw`assertThat(evaluate("(name)is(age)yearsold", Ps.strList("[[\"name\",\"bob\"],[\"age\",\"two\"]]"))).isEqualTo("");`,
    )
    expect(syntaxTree(output).toString()).toContain('StringLiteral')
  })

  it('escapes quotes and doubles backslashes, including literal backslash-u text', () => {
    const slash = '\\'
    const text = `quote "; slash ${slash}; literal ${slash}n; unicode escape text ${slash}u000a; 😀`

    expect(escapeJavaStringContent(text)).toBe(
      `quote ${slash}"; slash ${slash}${slash}; literal ${slash}${slash}n; unicode escape text ${slash}${slash}u000a; 😀`,
    )
  })

  it('preserves CR, LF, CRLF, tabs, and control characters with valid Java escapes', () => {
    const controls = '\r\n\t\b\f\0\u0001\u001f\u007f'

    expect(escapeJavaStringContent(controls)).toBe(String.raw`\r\n\t\b\f\000\001\037\177`)
    expect(escapeJavaStringContent('\r\n')).toBe(String.raw`\r\n`)
  })

  it('keeps an existing escaped quote intact while escaping a pasted quote', () => {
    const source = String.raw`String value = "before \"after";`
    const position = source.indexOf('after')
    const output = applyClipboardPaste(stateAt(source, position), '"')

    expect(output.doc.toString()).toBe(String.raw`String value = "before \"\"after";`)
  })

  it('escapes in an empty literal and at both content edges, but not on either quote', () => {
    const source = 'String value = "";'
    const openingQuote = source.indexOf('"')
    const content = openingQuote + 1
    const closingQuote = content

    expect(escapeJavaStringPaste('"', stateAt(source, content))).toBe(String.raw`\"`)
    expect(escapeJavaStringPaste('"', stateAt(source, openingQuote))).toBeNull()
    expect(escapeJavaStringPaste('"', stateAt(source, closingQuote + 1))).toBeNull()

    const nonempty = 'String value = "abc";'
    const bodyStart = nonempty.indexOf('"') + 1
    const bodyEnd = nonempty.lastIndexOf('"')
    expect(escapeJavaStringPaste('"', stateAt(nonempty, bodyStart))).toBe(String.raw`\"`)
    expect(escapeJavaStringPaste('"', stateAt(nonempty, bodyEnd))).toBe(String.raw`\"`)
  })

  it('supports a backward selection contained in string content', () => {
    const source = 'String value = "alpha beta";'
    const from = source.indexOf('alpha')
    const to = from + 'alpha beta'.length
    const output = applyClipboardPaste(stateAt(source, to, from), '"quoted"')

    expect(output.doc.toString()).toBe(String.raw`String value = "\"quoted\"";`)
  })

  it('leaves a whole-literal selection and a selection crossing the closing quote unchanged', () => {
    const source = 'String value = "abc";'
    const openingQuote = source.indexOf('"')
    const closingQuote = source.lastIndexOf('"')
    const inside = openingQuote + 1

    expect(escapeJavaStringPaste('"', stateAt(source, openingQuote, closingQuote + 1))).toBeNull()
    expect(escapeJavaStringPaste('"', stateAt(source, inside, closingQuote + 1))).toBeNull()
  })

  it('does not allow a paste to split an existing source escape', () => {
    const escapedNewline = String.raw`String value = "before \nafter";`
    const newlineSlash = escapedNewline.indexOf(String.raw`\n`)
    expect(escapeJavaStringPaste('"', stateAt(escapedNewline, newlineSlash + 1))).toBeNull()

    const escapedBackslashes = String.raw`String value = "\\";`
    const firstSlash = escapedBackslashes.indexOf('\\')
    expect(escapeJavaStringPaste('x', stateAt(escapedBackslashes, firstSlash + 1))).toBeNull()
    expect(escapeJavaStringPaste('x', stateAt(escapedBackslashes, firstSlash + 2))).toBe('x')

    const unicodeEscape = String.raw`String value = "\u0041";`
    const unicodeStart = unicodeEscape.indexOf(String.raw`\u0041`)
    expect(escapeJavaStringPaste('x', stateAt(unicodeEscape, unicodeStart + 3))).toBeNull()
    expect(escapeJavaStringPaste('x', stateAt(unicodeEscape, unicodeStart + 6))).toBe('x')

    const translatedBackslash = String.raw`String value = "\u005cn";`
    const translatedBackslashStart = translatedBackslash.indexOf(String.raw`\u005c`)
    expect(escapeJavaStringPaste('"', stateAt(translatedBackslash, translatedBackslashStart + 6))).toBeNull()

    const translatedQuoteExpression = String.raw`String value = "\u0022 + "next";`
    const afterPlus = translatedQuoteExpression.indexOf('+') + 1
    expect(escapeJavaStringPaste('"x" + ', stateAt(translatedQuoteExpression, afterPlus))).toBeNull()

    const ineligibleUnicode = String.raw`String value = "\\u0022";`
    expect(escapeJavaStringPaste('"', stateAt(ineligibleUnicode, ineligibleUnicode.lastIndexOf('"'))))
      .toBe(String.raw`\"`)

    for (const lineTerminator of [String.raw`\u000a`, String.raw`\u000d`]) {
      const apparentString = `String value = "first${lineTerminator}second";`
      expect(escapeJavaStringPaste('x', stateAt(apparentString, apparentString.indexOf('second')))).toBeNull()
    }

    const octalEscape = String.raw`String value = "\123";`
    expect(escapeJavaStringPaste('x', stateAt(octalEscape, octalEscape.indexOf('23')))).toBeNull()

    expect(escapeJavaStringPaste('"', stateAt(escapedNewline, newlineSlash + 1, newlineSlash + 2))).toBeNull()
    expect(escapeJavaStringPaste('"', stateAt(escapedNewline, newlineSlash, newlineSlash + 2)))
      .toBe(String.raw`\"`)
  })

  it('allows insertion before or after a complete existing escape without changing it', () => {
    const source = String.raw`String value = "before \nafter";`
    const escapeStart = source.indexOf(String.raw`\n`)
    const escapeEnd = escapeStart + 2

    expect(applyClipboardPaste(stateAt(source, escapeStart), '"').doc.toString())
      .toBe(String.raw`String value = "before \"\nafter";`)
    expect(applyClipboardPaste(stateAt(source, escapeEnd), '"').doc.toString())
      .toBe(String.raw`String value = "before \n\"after";`)
  })

  it('leaves comments, character literals, text blocks, and code unchanged', () => {
    const code = 'String value = "abc";'
    expect(escapeJavaStringPaste('"', stateAt(code, code.indexOf('value')))).toBeNull()

    const lineComment = 'String value = 0; // quote " here'
    expect(escapeJavaStringPaste('"', stateAt(lineComment, lineComment.indexOf('"')))).toBeNull()

    const blockComment = '/* quote " here */ String value = 0;'
    expect(escapeJavaStringPaste('"', stateAt(blockComment, blockComment.indexOf('"')))).toBeNull()

    const charLiteral = "char value = 'a';"
    expect(escapeJavaStringPaste('"', stateAt(charLiteral, charLiteral.indexOf("'") + 1))).toBeNull()

    const stringWithCommentMarkers = 'String value = "/* //";'
    expect(escapeJavaStringPaste('"', stateAt(stringWithCommentMarkers, stringWithCommentMarkers.indexOf('/*') + 1)))
      .toBe(String.raw`\"`)

    const textBlock = 'String value = """\ntext\n""";'
    const textPosition = textBlock.indexOf('text')
    expect(escapeJavaStringPaste('"\n', stateAt(textBlock, textPosition))).toBeNull()
  })

  it('escapes multi-selections only when every range is in ordinary string content', () => {
    const source = 'String first = ""; String second = "";'
    const state = javaState(source, true).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf('"') + 1),
        EditorSelection.cursor(source.lastIndexOf('""') + 1),
      ]),
    }).state
    const pasted = applyClipboardPaste(state, '"')

    expect(pasted.doc.toString()).toBe(String.raw`String first = "\""; String second = "\"";`)

    const mixed = javaState(source, true).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(source.indexOf('"') + 1),
        EditorSelection.cursor(source.indexOf('first')),
      ]),
    }).state
    expect(escapeJavaStringPaste('"', mixed)).toBeNull()
    expect(formatJavaClipboardPaste('"', mixed)).toBe('"')
  })

  it('leaves unterminated strings unchanged and parses long valid literals before deciding', () => {
    const incomplete = javaState('Ps.strList("')
    expect(escapeJavaStringPaste('"', incomplete)).toBeNull()

    const source = `String value = "${'x'.repeat(80_000)}";\n${'class Tail { int value; }\n'.repeat(1_000)}`
    const state = EditorState.create({
      doc: source,
      extensions: [java()],
      selection: { anchor: source.indexOf('x') + 2 },
    })
    expect(escapeJavaStringPaste('"', state)).toBe(String.raw`\"`)
    expect(ensureSyntaxTree(state, state.selection.main.to, 50)).not.toBeNull()
  })

  it('retains multiline JavaDoc formatting when the paste is outside a string', () => {
    const source = '/**\n * text\n */\nclass Solution {}'
    const position = source.indexOf('text') + 'text'.length
    const state = stateAt(source, position)

    expect(formatJavaClipboardPaste('one\n\ntwo\n\n', state)).toBe('one\n * \n * two')
  })
})

describe('Java string paste paths', () => {
  it('handles native paste only when an ordinary string needs escaping', () => {
    const source = 'String value = "";'
    const state = stateAt(source, source.indexOf('"') + 1)
    const editor = editorHarness(state)
    const event = nativePasteEvent({ plainText: 'a "quote"' })

    expect(handleJavaStringPaste(event, editor.view)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(editor.state().doc.toString()).toBe(String.raw`String value = "a \"quote\"";`)
    expect(editor.transactions[0].annotation(Transaction.userEvent)).toBe('input.paste')
    expect(editor.transactions[0].scrollIntoView).toBe(true)
  })

  it('uses text/uri-list when text/plain is empty', () => {
    const source = 'String value = "";'
    const state = stateAt(source, source.indexOf('"') + 1)
    const editor = editorHarness(state)
    const event = nativePasteEvent({ uriList: 'https://example.test/a?x="b"' })

    expect(handleJavaStringPaste(event, editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe(String.raw`String value = "https://example.test/a?x=\"b\"";`)
  })

  it('lets built-in paste proceed for unchanged, non-string, missing, and read-only cases', () => {
    const source = 'String value = "";'
    const inside = stateAt(source, source.indexOf('"') + 1)
    const unchanged = nativePasteEvent({ plainText: 'plain text' })
    expect(handleJavaStringPaste(unchanged, editorHarness(inside).view)).toBe(false)
    expect(unchanged.preventDefault).not.toHaveBeenCalled()

    const outside = nativePasteEvent({ plainText: '"' })
    expect(handleJavaStringPaste(outside, editorHarness(stateAt(source, source.indexOf('value'))).view)).toBe(false)
    expect(outside.preventDefault).not.toHaveBeenCalled()

    const missingClipboard = { clipboardData: null, preventDefault: vi.fn() } as unknown as ClipboardEvent
    expect(handleJavaStringPaste(missingClipboard, editorHarness(inside).view)).toBe(false)

    const readOnly = EditorState.create({
      doc: source,
      extensions: [java(), EditorState.readOnly.of(true)],
      selection: { anchor: source.indexOf('"') + 1 },
    })
    const readOnlyEvent = nativePasteEvent({ plainText: '"' })
    expect(handleJavaStringPaste(readOnlyEvent, editorHarness(readOnly).view)).toBe(false)
    expect(readOnlyEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('routes custom clipboard paste through string escaping and keeps the action undoable', async () => {
    const source = 'assertThat(evaluate("(name)is(age)yearsold", Ps.strList(""))).isEqualTo("");'
    const position = source.indexOf('Ps.strList("') + 'Ps.strList("'.length
    const withHistory = EditorState.create({
      doc: source,
      extensions: [java(), history()],
      selection: { anchor: position },
    })
    const editor = editorHarness(withHistory)
    const text = '[["name","bob"],["age","two"]]'

    expect(pasteJavaClipboard(editor.view, { readText: async () => text })).toBe(true)
    await Promise.resolve()
    expect(editor.state().doc.toString()).toBe(
      String.raw`assertThat(evaluate("(name)is(age)yearsold", Ps.strList("[[\"name\",\"bob\"],[\"age\",\"two\"]]"))).isEqualTo("");`,
    )
    expect(editor.transactions[0].annotation(Transaction.userEvent)).toBe('input.paste')
    expect(undo(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe(source)
  })
})

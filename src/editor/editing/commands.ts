import { acceptCompletion, nextSnippetField } from '@codemirror/autocomplete'
import { getIndentation, indentRange, indentString, syntaxTree } from '@codemirror/language'
import { countColumn, EditorSelection, type ChangeSpec, type SelectionRange } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { expandJavaPrintTemplate, expandJavaTestTemplate } from '../../completions'
import { formatJavaSource } from '../../java-format'

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

/**
 * Changes for each differing run of lines, aligned by a longest common
 * subsequence of lines. A single span would cover every line between the first
 * and last edit and collapse any cursor inside it to the span's start.
 */
function lineDocumentChanges(before: string, after: string) {
  const lines = (text: string) => text.split(/(?<=\n)/).filter((line) => line !== '')
  const a = lines(before)
  const b = lines(after)
  // common[i][j] is the LCS length of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1])
    }
  }
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let i = 0
  let j = 0
  let offset = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      offset += a[i].length
      i += 1
      j += 1
      continue
    }
    let removed = ''
    let inserted = ''
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break
      if (j >= b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) {
        removed += a[i++]
      } else {
        inserted += b[j++]
      }
    }
    const change = minimalDocumentChange(removed, inserted)
    changes.push({ from: offset + change.from, to: offset + change.to, insert: change.insert })
    offset += removed.length
  }
  return changes
}

/** Reformat the whole document and then re-indent through Java language support. */
export function reformatJavaDocument(view: EditorView): boolean {
  const source = view.state.doc.toString()
  const formatted = formatJavaSource(source)
  if (formatted !== source) {
    view.dispatch({ changes: lineDocumentChanges(source, formatted), userEvent: 'format' })
  }
  const indentation = indentRange(view.state, 0, view.state.doc.length)
  if (!indentation.empty) {
    view.dispatch({ changes: indentation, userEvent: 'format' })
  }
  const state = view.state
  const tree = syntaxTree(state)
  const closingBraces = []
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number)
    const match = /^([\t ]*)}/.exec(line.text)
    if (!match) continue
    const end = line.from + match[0].length
    // An unfinished statement can own the whitespace before `}` in the
    // recovered tree. Query inside the closing token to use its block instead.
    const closing = tree.resolveInner(end, -1)
    if (closing.name !== '}' || closing.parent?.name !== 'Block') continue
    const previous = closing.prevSibling?.cursor()
    if (!previous) continue
    let unfinished = false
    previous.iterate((node) => {
      if (node.type.isError) unfinished = true
      return !unfinished
    })
    if (!unfinished) continue
    const indent = getIndentation(state, end)
    if (indent === null) continue
    const insert = indentString(state, indent)
    if (insert !== match[1]) {
      closingBraces.push({ from: line.from, to: end - 1, insert })
    }
  }
  if (closingBraces.length > 0) {
    view.dispatch({ changes: closingBraces, userEvent: 'format' })
  }
  // Blank lines lose their whitespace above; keep the cursor's own blank line
  // at its block indentation so typing continues where the code belongs.
  const cursor = view.state.selection.main
  const cursorLine = view.state.doc.lineAt(cursor.head)
  if (cursor.empty && cursorLine.text.trim() === '') {
    const indent = getIndentation(view.state, cursorLine.from)
    const insert = indent === null ? null : indentString(view.state, indent)
    if (insert !== null && insert !== cursorLine.text) {
      const changes = view.state.changes({ from: cursorLine.from, to: cursorLine.to, insert })
      view.dispatch({
        changes,
        selection: view.state.selection.map(changes)
          .replaceRange(EditorSelection.cursor(cursorLine.from + insert.length)),
        userEvent: 'format',
      })
    }
  }
  return true
}

/** Snippet navigation takes precedence over expanding a fresh abbreviation. */
export function expandJavaTemplateOnTab(view: EditorView): boolean {
  return nextSnippetField(view)
    || acceptCompletion(view)
    || expandJavaTestTemplate(view)
    || expandJavaPrintTemplate(view)
}

/**
 * Backspace on a whitespace-only line: at or before the proper indentation the
 * blank line is removed and the cursor joins the previous line's end; beyond it
 * the line is trimmed back to the proper indentation. Returns false (so the
 * default Backspace runs) unless every cursor qualifies on a distinct line.
 */
export function smartBackspaceOnBlankLine(view: EditorView): boolean {
  const { state } = view
  const lines = new Set<number>()
  const edits: Array<{ changes: ChangeSpec; cursor: number }> = []
  for (const range of state.selection.ranges) {
    if (!range.empty) return false
    const line = state.doc.lineAt(range.head)
    if (line.number === 1 || lines.has(line.number) || line.text.trim() !== '') return false
    lines.add(line.number)
    const column = countColumn(line.text.slice(0, range.head - line.from), state.tabSize)
    const proper = getIndentation(state, line.from) ?? countColumn(line.text, state.tabSize)
    if (column <= proper) {
      edits.push({ changes: { from: line.from - 1, to: line.to }, cursor: line.from - 1 })
    } else {
      const indent = indentString(state, proper)
      edits.push({ changes: { from: line.from, to: line.to, insert: indent }, cursor: line.from + indent.length })
    }
  }
  let index = 0
  view.dispatch(state.changeByRange((_range: SelectionRange) => {
    const { changes, cursor } = edits[index++]
    return { changes, range: EditorSelection.cursor(cursor) }
  }), { scrollIntoView: true, userEvent: 'delete.backward' })
  return true
}

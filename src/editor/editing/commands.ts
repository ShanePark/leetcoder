import { acceptCompletion, nextSnippetField } from '@codemirror/autocomplete'
import { getIndentation, indentRange, indentString, syntaxTree } from '@codemirror/language'
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

/** Reformat the whole document and then re-indent through Java language support. */
export function reformatJavaDocument(view: EditorView): boolean {
  const source = view.state.doc.toString()
  const formatted = formatJavaSource(source)
  if (formatted !== source) {
    view.dispatch({ changes: minimalDocumentChange(source, formatted), userEvent: 'format' })
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
  return true
}

/** Snippet navigation takes precedence over expanding a fresh abbreviation. */
export function expandJavaTemplateOnTab(view: EditorView): boolean {
  return nextSnippetField(view)
    || acceptCompletion(view)
    || expandJavaTestTemplate(view)
    || expandJavaPrintTemplate(view)
}

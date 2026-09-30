import { acceptCompletion, nextSnippetField } from '@codemirror/autocomplete'
import { indentRange } from '@codemirror/language'
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
  return true
}

/** Snippet navigation takes precedence over expanding a fresh abbreviation. */
export function expandJavaTemplateOnTab(view: EditorView): boolean {
  return nextSnippetField(view)
    || acceptCompletion(view)
    || expandJavaTestTemplate(view)
    || expandJavaPrintTemplate(view)
}

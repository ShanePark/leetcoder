import { StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { planJavaMethodRename, type JavaMethodRenameRange } from './rename'
import { planJavaVariableOccurrences } from './variable-rename'

interface SymbolHighlights {
  ranges: JavaMethodRenameRange[]
  decorations: DecorationSet
}

const emptyHighlights: SymbolHighlights = { ranges: [], decorations: Decoration.none }
const symbolMark = Decoration.mark({ class: 'cm-symbolHighlight' })

function highlightsFor(state: EditorState): SymbolHighlights {
  const selection = state.selection.main
  if (state.selection.ranges.length !== 1 || !selection.empty) return emptyHighlights
  const variable = planJavaVariableOccurrences(state, selection.head)
  const result = 'reason' in variable
    ? planJavaMethodRename(state.doc.toString(), selection.head)
    : variable
  if ('reason' in result) return emptyHighlights
  // Parser recovery can represent a missing declaration name as an empty range.
  const ranges = result.ranges.filter(({ from, to }) => from < to)
  return {
    ranges,
    decorations: Decoration.set(ranges.map(({ from, to }) => symbolMark.range(from, to))),
  }
}

/** Mark the current declaration and its resolvable same-file references. */
export const javaSymbolHighlights = StateField.define<SymbolHighlights>({
  create: highlightsFor,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value
    const selection = transaction.state.selection.main
    if (!transaction.docChanged && transaction.state.selection.ranges.length === 1
      && selection.empty && value.ranges.some(({ from, to }) => from <= selection.head && selection.head <= to)) {
      return value
    }
    return highlightsFor(transaction.state)
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

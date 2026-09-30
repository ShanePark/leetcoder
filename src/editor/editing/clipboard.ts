import { deleteLine } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ClipboardBridge } from '../../clipboard'

/** The line blocks `deleteLine` would remove for the current selection. */
export function selectedLineBlocks(state: EditorState): Array<{ from: number; to: number }> {
  const blocks: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from)
    let endLine = state.doc.lineAt(range.to)
    if (range.to > range.from && endLine.from === range.to) {
      endLine = state.doc.lineAt(range.to - 1)
    }
    const from = startLine.from
    const to = Math.min(state.doc.length, endLine.to + 1)
    const previous = blocks[blocks.length - 1]
    if (previous && previous.to >= from) {
      previous.to = to
    } else {
      blocks.push({ from, to })
    }
  }
  return blocks
}

/** Copy the selected text, or the current line when there is no selection. */
export function copySelectedText(
  state: EditorState,
  clipboard: Pick<ClipboardBridge, 'writeText'>,
): boolean {
  const selected = state.selection.ranges.filter((range) => !range.empty)
  const text = selected.length > 0
    ? selected
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak)
    : selectedLineBlocks(state)
      .map((block) => state.sliceDoc(block.from, block.to))
      .join('')
  if (!text) {
    return false
  }
  void clipboard.writeText(text)
  return true
}

/** Cut the selection, or the whole line when there is no selection. */
export function cutSelectionOrLine(
  view: EditorView,
  clipboard: Pick<ClipboardBridge, 'writeText'>,
): boolean {
  const state = view.state
  const selected = state.selection.ranges.filter((range) => !range.empty)
  if (selected.length > 0) {
    const text = selected
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak)
    void clipboard.writeText(text)
    view.dispatch({ ...state.replaceSelection(''), userEvent: 'delete.cut' })
    return true
  }
  const text = selectedLineBlocks(state)
    .map((block) => state.sliceDoc(block.from, block.to))
    .join('')
  if (!text) {
    return false
  }
  void clipboard.writeText(text)
  return deleteLine(view)
}

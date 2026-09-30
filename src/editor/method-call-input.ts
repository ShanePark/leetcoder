import type { EditorView } from '@codemirror/view'
import { javaIdentifierAt } from '../completions'

const JAVA_IDENTIFIER_START = /^(?:[$_]|\p{ID_Start})$/u
const JAVA_IDENTIFIER_PART = /^(?:[$\p{ID_Continue}])$/u

function isJavaIdentifier(value: string): boolean {
  const characters = [...value]
  return characters.length > 0
    && JAVA_IDENTIFIER_START.test(characters[0])
    && characters.slice(1).every((character) => JAVA_IDENTIFIER_PART.test(character))
}

/**
 * CodeMirror wraps a non-empty selection when `(` is typed. Completion can
 * leave the just-typed Java identifier selected, where that behavior turns a
 * method call into `(methodName)`. Collapse only an exact identifier to its
 * end before the normal close-brackets input handler runs.
 */
export function prepareSelectedJavaIdentifierCall(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || selection.empty) {
    return false
  }
  const selected = view.state.sliceDoc(selection.from, selection.to)
  if (!isJavaIdentifier(selected)) {
    return false
  }
  const identifier = javaIdentifierAt(view.state.doc.toString(), selection.from)
  if (!identifier || identifier.from !== selection.from || identifier.to !== selection.to) {
    return false
  }
  view.dispatch({ selection: { anchor: selection.to } })
  return true
}

/**
 * Handle the input event itself when a browser doesn't expose `(` on the
 * keydown event (keyboard layouts and IMEs can do that). This runs before
 * closeBrackets, so the selected identifier is never handed to its wrapping
 * behavior as the range to replace.
 */
export function handleJavaIdentifierCallInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== '(') {
    return false
  }
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1) {
    return false
  }
  const source = view.state.doc.toString()

  // A completion can update CodeMirror's selection before WebView updates its
  // native selection. If that stale range still points at the completed
  // identifier, insert the call at the current cursor instead of letting the
  // browser's input change use the old position.
  if (selection.empty) {
    if (view.compositionStarted) {
      return false
    }
    const identifier = javaIdentifierAt(source, selection.head)
    const staleRange = identifier
      && identifier.to === selection.head
      && ((from === identifier.from && to === identifier.from)
        || (from === identifier.from && to === identifier.to))
    if (!staleRange) {
      return false
    }
    const next = view.state.sliceDoc(selection.head, selection.head + 1)
    if (next && !/[\s)\]}:;>]/.test(next)) {
      return false
    }
    view.dispatch({
      changes: { from: selection.head, insert: '()' },
      selection: { anchor: selection.head + 1 },
      scrollIntoView: true,
      userEvent: 'input.type',
    })
    return true
  }

  if (selection.from !== from || selection.to !== to) {
    return false
  }
  const selected = view.state.sliceDoc(selection.from, selection.to)
  if (!isJavaIdentifier(selected)) {
    return false
  }
  const identifier = javaIdentifierAt(source, selection.from)
  if (!identifier || identifier.from !== selection.from || identifier.to !== selection.to) {
    return false
  }

  // Match closeBrackets' default `before` rule. If another non-whitespace
  // character follows, leave the insertion to closeBrackets' normal wrapper
  // behavior rather than changing unrelated selection editing.
  const next = view.state.sliceDoc(selection.to, selection.to + 1)
  if (next && !/[\s)\]}:;>]/.test(next)) {
    return false
  }

  view.dispatch({
    changes: { from: selection.to, insert: '()' },
    selection: { anchor: selection.to + 1 },
    scrollIntoView: true,
    userEvent: 'input.type',
  })
  return true
}

/**
 * Handle a printable `(` key before the browser creates an input event.
 *
 * A keymap command can prevent the browser from replaying the same key after
 * dispatching the transaction, which keeps the original selection from being
 * handed to closeBrackets a second time. Returning false deliberately leaves
 * all other selections to the normal close-brackets behavior.
 */
export function handleJavaIdentifierCallKey(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || selection.empty) {
    return false
  }
  return handleJavaIdentifierCallInput(view, selection.from, selection.to, '(')
}

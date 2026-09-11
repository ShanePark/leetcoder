import { deleteLine, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { expect } from 'vitest'

export function runEditorCommand(
  state: EditorState,
  command: (view: EditorView) => boolean,
): EditorState {
  let current = state
  const view = {
    get state() {
      return current
    },
    lineWrapping: false,
    moveVertically: (range: unknown) => range,
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state
    },
  } as unknown as EditorView

  expect(command(view)).toBe(true)
  return current
}

export function mutableEditorView(initial: EditorState): { view: EditorView, state: () => EditorState } {
  let current = initial
  const view = {
    get state() {
      return current
    },
    lineWrapping: false,
    moveVertically: (range: unknown) => range,
    dispatch: (spec: TransactionSpec) => {
      current = current.update(spec).state
    },
  } as unknown as EditorView
  return { view, state: () => current }
}

export function javaState(source: string, allowMultipleSelections = false): EditorState {
  const state = EditorState.create({
    doc: source,
    extensions: [
      java(),
      ...(allowMultipleSelections ? [EditorState.allowMultipleSelections.of(true)] : []),
    ],
  })
  expect(ensureSyntaxTree(state, state.doc.length, 1000)).not.toBeNull()
  // Publish the completed mutable parse context through the state field.
  const parsedState = state.update({}).state
  expect(syntaxTree(parsedState).length).toBe(state.doc.length)
  return parsedState
}

export function applyDeleteLine(state: EditorState): EditorState {
  let transaction: TransactionSpec | null = null
  const view = {
    state,
    lineWrapping: false,
    moveVertically: (range: unknown) => range,
    dispatch: (spec: TransactionSpec) => {
      transaction = spec
    },
  } as unknown as EditorView

  expect(deleteLine(view)).toBe(true)
  if (!transaction) {
    throw new Error('deleteLine did not dispatch a transaction')
  }
  return state.update(transaction).state
}

export function applyUndo(state: EditorState): { handled: boolean; state: EditorState } {
  let nextState = state
  const handled = undo({
    state,
    dispatch: (transaction) => {
      nextState = transaction.state
    },
  })
  return { handled, state: nextState }
}

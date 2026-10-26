import {
  insertCompletionText,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

const setSingleCompletionRequest = StateEffect.define<boolean>()

/**
 * Set by the explicit complete command and dropped on the next edit or cursor
 * move, so only the query that command starts may insert a lone match.
 */
const singleCompletionRequest = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSingleCompletionRequest)) return effect.value
    }
    return value && !tr.docChanged && !tr.selection
  },
})

function applyCompletion(view: EditorView, completion: Completion, from: number, to: number): void {
  const apply = completion.apply ?? completion.label
  if (typeof apply === 'string') {
    view.dispatch({
      ...insertCompletionText(view.state, apply, from, to),
      annotations: pickedCompletion.of(completion),
    })
  } else {
    apply(view, completion, from, to)
  }
}

function insertSingleMatch(context: CompletionContext, result: CompletionResult | null): CompletionResult | null {
  const view = context.view
  if (!result || !view || !context.explicit || !context.state.field(singleCompletionRequest, false)) return result
  const to = result.to ?? context.pos
  const typed = context.state.sliceDoc(result.from, to).toLowerCase()
  const matches = result.options.filter((option) => option.label.toLowerCase().startsWith(typed))
  if (matches.length !== 1) return result
  const { state } = context
  // Completion sources run inside CodeMirror's query cycle; apply afterwards,
  // and only if the document and cursor are still where the user asked.
  queueMicrotask(() => {
    if (view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) return
    applyCompletion(view, matches[0], result.from, to)
  })
  return null
}

/**
 * Wrap a completion source so the explicit complete command inserts the
 * suggestion directly when exactly one option matches the typed prefix.
 */
export function insertSingleCompletion(source: CompletionSource): CompletionSource {
  return (context) => {
    const result = source(context)
    return result instanceof Promise
      ? result.then((resolved) => insertSingleMatch(context, resolved))
      : insertSingleMatch(context, result)
  }
}

/** Explicitly start completion, inserting a lone matching suggestion directly. */
export function startCompletionOrInsertSingle(view: EditorView): boolean {
  const effects: StateEffect<unknown>[] = [setSingleCompletionRequest.of(true)]
  if (view.state.field(singleCompletionRequest, false) === undefined) {
    effects.unshift(StateEffect.appendConfig.of(singleCompletionRequest))
  }
  view.dispatch({ effects })
  return startCompletion(view)
}

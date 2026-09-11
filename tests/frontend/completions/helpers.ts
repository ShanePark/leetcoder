import { EditorState } from '@codemirror/state'
import type { CompletionContext } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

import { expandJavaPrintTemplate, javaCompletions, javaIterTemplateExtension } from '../../../src/completions'

export function complete(source: string, explicit = false) {
  const marker = source.indexOf('|')
  const cursor = marker >= 0 ? marker : source.length
  const document = marker >= 0 ? `${source.slice(0, marker)}${source.slice(marker + 1)}` : source
  const state = EditorState.create({ doc: document })
  const context = {
    state,
    pos: cursor,
    explicit,
    matchBefore(pattern: RegExp) {
      const before = document.slice(0, cursor)
      const anchoredPattern = new RegExp(`(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ''))
      const match = anchoredPattern.exec(before)
      if (!match) return null
      return { from: cursor - match[0].length, to: cursor, text: match[0] }
    },
  } as unknown as CompletionContext
  return javaCompletions(context)
}

export function labels(source: string, explicit = false): string[] {
  return complete(source, explicit)?.options.map((option) => option.label) ?? []
}

export function applyCompletion(source: string, label: string): string {
  const marker = source.indexOf('|')
  if (marker < 0) throw new Error('Completion source must include a | cursor marker')
  const document = `${source.slice(0, marker)}${source.slice(marker + 1)}`
  let state = EditorState.create({ doc: document })
  const result = complete(source)
  const completion = result?.options.find((option) => option.label === label)
  if (!result || !completion) throw new Error(`Completion not found: ${label}`)

  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    },
  } as unknown as EditorView

  if (typeof completion.apply === 'function') {
    completion.apply(view, completion, result.from, marker)
  } else {
    const insert = completion.apply ?? completion.label
    state = state.update({ changes: { from: result.from, to: marker, insert } }).state
  }
  return state.doc.toString()
}

export function expandPrintTemplateState(source: string): { expanded: boolean, state: EditorState } {
  const marker = source.indexOf('|')
  if (marker < 0) throw new Error('Expansion source must include a | cursor marker')
  let state = EditorState.create({
    doc: `${source.slice(0, marker)}${source.slice(marker + 1)}`,
    extensions: [EditorState.allowMultipleSelections.of(true), javaIterTemplateExtension],
    selection: { anchor: marker },
  })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    },
  } as unknown as EditorView
  return { expanded: expandJavaPrintTemplate(view), state }
}

export function expandPrintTemplate(source: string): { expanded: boolean, source: string } {
  const result = expandPrintTemplateState(source)
  return { expanded: result.expanded, source: result.state.doc.toString() }
}

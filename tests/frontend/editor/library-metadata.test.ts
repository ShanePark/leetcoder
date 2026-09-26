import { autocompletion, completionStatus, startCompletion, CompletionContext } from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  javaAutoImports,
  JavaEditor,
} from '../../../src/editor'
import {
  javaCompletions,
  psLibraryAvailable,
  psLibraryExtension,
  readPsLibraryMetadata,
} from '../../../src/completions'
import type { PsLibraryMetadata } from '../../../src/completions'

const source = 'class Solution { void test() { Ps.| } }'

const psV1: PsLibraryMetadata = {
  fingerprint: 'ps-v1',
  methods: [{ name: 'oldMethod', returnType: 'java.lang.String', parameters: [] }],
}

const psV2: PsLibraryMetadata = {
  fingerprint: 'ps-v2',
  methods: [
    { name: 'newMethod', returnType: 'java.lang.String', parameters: [] },
    { name: 'newMethod', returnType: 'java.lang.String', parameters: [{ name: null, typeName: 'int' }] },
  ],
}

function harness(sourceText = source) {
  const marker = sourceText.indexOf('|')
  const cursor = marker < 0 ? sourceText.length : marker
  const doc = marker < 0 ? sourceText : `${sourceText.slice(0, marker)}${sourceText.slice(marker + 1)}`
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      java(),
      psLibraryExtension,
      javaAutoImports,
      autocompletion({ override: [javaCompletions], activateOnTyping: true }),
    ],
  })
  const view = {
    get state() { return state },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state },
  } as unknown as EditorView
  const editor = { view } as JavaEditor
  const setMetadata = (metadata: PsLibraryMetadata | null) => JavaEditor.prototype.setPsLibraryMetadata.call(editor, metadata)
  const labels = () => javaCompletions(new CompletionContext(state, cursor, false))?.options.map(({ label }) => label) ?? []
  return { view, state: () => state, setMetadata, labels }
}

describe('Ps library metadata in the editor', () => {
  it('starts completion when library metadata arrives at an inactive Ps receiver', () => {
    const editor = harness()
    expect(completionStatus(editor.state())).toBeNull()

    editor.setMetadata(psV2)

    expect(completionStatus(editor.state())).toBe('pending')
    expect(editor.labels()).toEqual(expect.arrayContaining(['newMethod()', 'newMethod(int number)']))
  })

  it('does not start completion for Ps text inside comments or literals', () => {
    const sources = [
      'class Solution { void test() { // Ps.|\n } }',
      'class Solution { String value = "Ps.|"; }',
    ]

    for (const sourceText of sources) {
      const editor = harness(sourceText)
      expect(completionStatus(editor.state())).toBeNull()

      editor.setMetadata(psV2)

      expect(completionStatus(editor.state())).toBeNull()
    }
  })

  it('refreshes pending completions when the project resolves a new library version', () => {
    const editor = harness()
    expect(startCompletion(editor.view)).toBe(true)
    expect(completionStatus(editor.state())).toBe('pending')

    editor.setMetadata(psV1)
    expect(psLibraryAvailable(editor.state())).toBe(true)
    expect(completionStatus(editor.state())).toBe('pending')
    expect(editor.labels()).toContain('oldMethod()')

    editor.setMetadata(psV2)
    expect(readPsLibraryMetadata(editor.state())?.fingerprint).toBe('ps-v2')
    expect(completionStatus(editor.state())).toBe('pending')
    expect(editor.labels()).toEqual(expect.arrayContaining(['newMethod()', 'newMethod(int number)']))
    expect(editor.labels()).not.toContain('oldMethod()')
  })

  it('keeps metadata and a pending request when the fingerprint is unchanged, then clears cleanly', () => {
    const editor = harness()
    editor.setMetadata(psV2)
    expect(startCompletion(editor.view)).toBe(true)
    expect(completionStatus(editor.state())).toBe('pending')

    const sameVersionDifferentPayload: PsLibraryMetadata = {
      fingerprint: 'ps-v2',
      methods: [{ name: 'incorrectReplacement', returnType: 'void', parameters: [] }],
    }
    editor.setMetadata(sameVersionDifferentPayload)
    expect(readPsLibraryMetadata(editor.state())).toBe(psV2)
    expect(completionStatus(editor.state())).toBe('pending')
    expect(editor.labels()).toContain('newMethod()')
    expect(editor.labels()).not.toContain('incorrectReplacement()')

    editor.setMetadata(null)
    expect(psLibraryAvailable(editor.state())).toBe(false)
    expect(editor.labels()).toEqual([])
    expect(completionStatus(editor.state())).toBe('pending')

    editor.setMetadata(null)
    expect(readPsLibraryMetadata(editor.state())).toBeNull()
    expect(editor.labels()).toEqual([])
  })

  it('does not auto-import Ps after its project metadata has been cleared', () => {
    const sourceText = 'class Solution { Object value = ; }'
    const editor = harness(sourceText)
    editor.setMetadata(psV1)
    editor.setMetadata(null)
    const at = editor.state().doc.toString().indexOf(';')

    editor.view.dispatch({
      changes: { from: at, insert: ' Ps.oldMethod()' },
      userEvent: 'input.type',
    })

    expect(editor.state().doc.toString()).toContain('Ps.oldMethod()')
    expect(editor.state().doc.toString()).not.toContain('import io.github.shanepark.Ps;')
  })
})

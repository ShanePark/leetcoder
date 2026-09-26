import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  psLibraryAvailable,
  psLibraryExtension,
  readPsLibraryMetadata,
  setPsLibraryMetadata,
} from '../../../src/completions'
import type { PsLibraryMetadata } from '../../../src/completions'

describe('project Ps library metadata state', () => {
  it('starts unavailable and becomes available after metadata is loaded', () => {
    const initial = EditorState.create({ doc: '', extensions: [psLibraryExtension] })
    expect(readPsLibraryMetadata(initial)).toBeNull()
    expect(psLibraryAvailable(initial)).toBe(false)

    const metadata: PsLibraryMetadata = {
      fingerprint: 'ps-v1',
      methods: [{
        name: 'strList',
        returnType: 'java.util.List<java.util.List<java.lang.String>>',
        parameters: [{ name: 'source', typeName: 'java.lang.String' }],
      }],
    }
    const loaded = initial.update({ effects: setPsLibraryMetadata.of(metadata) }).state
    expect(readPsLibraryMetadata(loaded)).toBe(metadata)
    expect(psLibraryAvailable(loaded)).toBe(true)
  })

  it('clears stale metadata when the project dependency disappears or cannot be loaded', () => {
    const metadata: PsLibraryMetadata = {
      fingerprint: 'ps-v1',
      methods: [{ name: 'oldMethod', returnType: 'void', parameters: [] }],
    }
    const loaded = EditorState.create({ doc: '', extensions: [psLibraryExtension] })
      .update({ effects: setPsLibraryMetadata.of(metadata) }).state
    const cleared = loaded.update({ effects: setPsLibraryMetadata.of(null) }).state
    expect(readPsLibraryMetadata(cleared)).toBeNull()
    expect(psLibraryAvailable(cleared)).toBe(false)
  })

  it('replaces metadata when the project resolves another library version', () => {
    const first: PsLibraryMetadata = {
      fingerprint: 'ps-v1',
      methods: [{ name: 'oldMethod', returnType: 'void', parameters: [] }],
    }
    const next: PsLibraryMetadata = {
      fingerprint: 'ps-v2',
      methods: [{ name: 'newMethod', returnType: 'java.lang.String', parameters: [] }],
    }
    const loaded = EditorState.create({ doc: '', extensions: [psLibraryExtension] })
      .update({ effects: setPsLibraryMetadata.of(first) }).state
    const updated = loaded.update({ effects: setPsLibraryMetadata.of(next) }).state
    expect(readPsLibraryMetadata(updated)).toBe(next)
    expect(readPsLibraryMetadata(updated)?.methods.map(({ name }) => name)).toEqual(['newMethod'])
  })

  it('does not report an empty class metadata response as available', () => {
    const empty: PsLibraryMetadata = { fingerprint: 'ps-empty', methods: [] }
    const state = EditorState.create({ doc: '', extensions: [psLibraryExtension] })
      .update({ effects: setPsLibraryMetadata.of(empty) }).state
    expect(readPsLibraryMetadata(state)).toBe(empty)
    expect(psLibraryAvailable(state)).toBe(false)
  })
})

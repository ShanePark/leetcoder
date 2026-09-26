import { StateEffect, StateField, type EditorState } from '@codemirror/state'

export interface PsMethodParameter {
  name: string | null
  typeName: string
}

export interface PsMethod {
  name: string
  returnType: string
  parameters: PsMethodParameter[]
}

export interface PsLibraryMetadata {
  fingerprint: string
  methods: PsMethod[]
}

export const setPsLibraryMetadata = StateEffect.define<PsLibraryMetadata | null>()

const psLibraryMetadataField = StateField.define<PsLibraryMetadata | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPsLibraryMetadata)) value = effect.value
    }
    return value
  },
})

export const psLibraryExtension = psLibraryMetadataField

export function readPsLibraryMetadata(state: EditorState): PsLibraryMetadata | null {
  return state.field(psLibraryMetadataField, false) ?? null
}

export function psLibraryAvailable(state: EditorState): boolean {
  return (readPsLibraryMetadata(state)?.methods.length ?? 0) > 0
}

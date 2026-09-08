import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import {
  javaIdentifierAt,
  resolveJavaDefinition,
} from '../completions'

export interface JavaDefinitionRange {
  from: number
  to: number
}

/** Resolve the definition targeted by a modifier-assisted editor click. */
export function javaDefinitionAt(source: string, position: number): JavaDefinitionRange | null {
  return resolveJavaDefinition(source, position)
}

/** Resolve the identifier range that should be highlighted on hover. */
export function javaDefinitionHoverRange(
  source: string,
  position: number,
): JavaDefinitionRange | null {
  const identifier = javaIdentifierAt(source, position)
  const definition = identifier ? resolveJavaDefinition(source, position) : null
  return identifier && definition
    ? { from: identifier.from, to: identifier.to }
    : null
}

export const setDefinitionHover = StateEffect.define<JavaDefinitionRange | null>()

export const definitionHover = StateField.define<ReturnType<typeof RangeSet.of<Decoration>>>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDefinitionHover)) {
        continue
      }
      if (!effect.value || effect.value.from >= effect.value.to) {
        return Decoration.none
      }
      const builder = new RangeSetBuilder<Decoration>()
      builder.add(
        effect.value.from,
        effect.value.to,
        Decoration.mark({ class: 'cm-definition-link' }),
      )
      return builder.finish()
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

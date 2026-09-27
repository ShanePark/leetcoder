import { bracketMatching, syntaxTree, type MatchResult } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration } from '@codemirror/view'

const literalNodeNames = new Set(['CharacterLiteral', 'StringLiteral', 'TextBlock'])
const matchingBracket = Decoration.mark({ class: 'cm-matchingBracket' })
const nonmatchingBracket = Decoration.mark({ class: 'cm-nonmatchingBracket' })

export function renderJavaBracketMatch(
  match: MatchResult,
  state: EditorState,
): readonly Range<Decoration>[] {
  const node = syntaxTree(state).resolveInner(match.start.from, 1)
  if (literalNodeNames.has(node.name)) {
    return []
  }

  const mark = match.matched ? matchingBracket : nonmatchingBracket
  const ranges = [mark.range(match.start.from, match.start.to)]
  if (match.end) {
    ranges.push(mark.range(match.end.from, match.end.to))
  }
  return ranges
}

export function javaBracketMatching() {
  return bracketMatching({ renderMatch: renderJavaBracketMatch })
}

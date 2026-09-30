import { javaLanguage } from '@codemirror/lang-java'

import type { JavaMethodExtractionResult } from './java-refactor/types'
import { collectDeclarations, collectMethods } from './java-refactor/declarations'
import { selectJavaSource } from './java-refactor/selection'
import { expressionPlan, statementPlan, uniqueMethodName } from './java-refactor/edits'

export type {
  JavaRefactorChange,
  JavaMethodNameRange,
  JavaMethodExtractionPlan,
  JavaMethodExtractionFailure,
  JavaMethodExtractionResult,
  JavaRefactorSelection,
} from './java-refactor/types'
export { findJavaRefactorSelection } from './java-refactor/selection'

/**
 * Plan a bounded Extract Method operation. It accepts an exact
 * Java expression or complete direct statements inside one method body and
 * returns source edits without mutating editor state.
 */
export function planJavaMethodExtraction(
  source: string,
  selectionFrom: number,
  selectionTo: number,
  requestedName?: string,
): JavaMethodExtractionResult {
  const tree = javaLanguage.parser.parse(source).topNode
  const methods = collectMethods(source, tree)
  if (methods.length === 0) return { reason: 'No Java method was found.' }
  const declarations = collectDeclarations(source, tree, methods)
  const selection = selectJavaSource(source, tree, methods, selectionFrom, selectionTo)
  if ('reason' in selection) return selection
  if (selection.method.node.getChild('TypeParameters')) {
    return { reason: 'Generic method type parameters are not yet supported.' }
  }
  const name = uniqueMethodName(source, selection.method.classBody, requestedName)
  return selection.expression
    ? expressionPlan(source, selection, declarations, methods, name)
    : statementPlan(source, selection, declarations, methods, name)
}

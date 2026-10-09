import type { JavaMethod, JavaSymbol } from './model'
import { maskJavaCommentsAndLiterals } from './source/masking'
import { collectJavaSymbolsFromMasked } from './source/symbols'
import { collectJavaMethodsFromMasked } from './source/methods'

export { maskJavaCommentsAndLiterals } from './source/masking'
export {
  baseType,
  collectJavaSymbols,
  isIterableType,
  iterableElementTypeForExpression,
  iterableVariableNameForExpression,
  javaIterableCandidates,
  javaIterableCandidatesFromAnalysis,
  simpleTypeName,
} from './source/symbols'
export type { JavaSymbolAnalysis } from './source/symbols'
export {
  collectJavaMethods,
  javaIdentifierAt,
  resolveJavaDefinition,
} from './source/methods'

/**
 * The source-level facts needed by one completion or definition lookup.
 *
 * Keeping the masked source alongside the derived symbols and methods lets a
 * caller that needs several views of one document pay for the comment/literal
 * scan only once. The type is intentionally kept out of the public
 * `src/completions.ts` facade; it is an internal coordination contract.
 */
export interface JavaSourceAnalysis {
  maskedSource: string
  symbols: JavaSymbol[]
  methods: JavaMethod[]
}

export function analyzeJavaSource(source: string, position = source.length): JavaSourceAnalysis {
  const maskedSource = maskJavaCommentsAndLiterals(source)
  return {
    maskedSource,
    symbols: collectJavaSymbolsFromMasked(source, position, maskedSource),
    methods: collectJavaMethodsFromMasked(source, maskedSource),
  }
}

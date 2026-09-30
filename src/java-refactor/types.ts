import type { javaLanguage } from '@codemirror/lang-java'

/** A source edit expressed in the coordinates of the input document. */
export interface JavaRefactorChange {
  from: number
  to: number
  insert: string
}

export interface JavaMethodNameRange {
  from: number
  to: number
}

export interface JavaMethodExtractionPlan {
  changes: JavaRefactorChange[]
  name: string
  /** Newly introduced call and declaration name ranges in post-change coordinates. */
  nameRanges: JavaMethodNameRange[]
}

export interface JavaMethodExtractionFailure {
  reason: string
}

export type JavaMethodExtractionResult = JavaMethodExtractionPlan | JavaMethodExtractionFailure

/** A source range inferred from an empty editor selection. */
export interface JavaRefactorSelection {
  from: number
  to: number
  kind: 'expression' | 'statement'
}

export type JavaSyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode']

export interface JavaMethodInfo {
  node: JavaSyntaxNode
  name: string
  returnType: string | null
  static: boolean
  body: JavaSyntaxNode
  classBody: JavaSyntaxNode
  throwsClause: string
}

export interface JavaDeclaration {
  name: string
  type: string
  declaredAt: number
  definitionFrom: number
  definitionTo: number
  kind: 'field' | 'parameter' | 'local'
  scopeStart: number
  scopeEnd: number
  static: boolean
  initialized: boolean
}

export interface JavaSelection {
  from: number
  to: number
  method: JavaMethodInfo
  expression: JavaSyntaxNode | null
  statements: JavaSyntaxNode[]
}

export interface JavaOutput {
  declaration: JavaDeclaration | null
  existing: JavaDeclaration | null
}

import type { javaLanguage } from '@codemirror/lang-java'

/** A source edit expressed in the coordinates of the document it was planned from. */
export interface JavaIntentionChange {
  from: number
  to: number
  insert: string
}

/** A method parameter inferred from the call that triggered the intention. */
export interface JavaMethodParameter {
  name: string
  type: string
}

/** The edit and selection produced by the create-method intention. */
export interface JavaMethodCreationPlan {
  name: string
  returnType: string
  parameters: readonly JavaMethodParameter[]
  /** The range of the unresolved invocation in the source snapshot. */
  callFrom: number
  callTo: number
  /** The exact source snapshot this plan was computed from. */
  source: string
  change: JavaIntentionChange
  /** The post-change selection, usually the generated default return value. */
  selection: { from: number; to: number }
}

export interface JavaIntention {
  id: 'create-method'
  label: string
  detail: string
  plan: JavaMethodCreationPlan
}

export interface JavaIntentionsMenuState {
  source: string
  anchor: number
  selectedIndex: number
  intentions: readonly JavaIntention[]
}

export type JavaSyntaxNode = ReturnType<typeof javaLanguage.parser.parse>['topNode']

export interface JavaMethodInfo {
  node: JavaSyntaxNode
  body: JavaSyntaxNode
  classBody: JavaSyntaxNode
  name: string
  returnType: string
  parameters: readonly JavaMethodParameter[]
  static: boolean
}

export interface JavaDeclaration {
  name: string
  type: string
  declaredAt: number
  classBody: JavaSyntaxNode
  method: JavaMethodInfo | null
  scopeStart: number
  scopeEnd: number
}

export interface JavaInvocationInfo {
  node: JavaSyntaxNode
  name: string
  nameFrom: number
  nameTo: number
  classBody: JavaSyntaxNode
  method: JavaMethodInfo | null
  arguments: JavaSyntaxNode[]
}

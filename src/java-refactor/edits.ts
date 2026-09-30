import type {
  JavaDeclaration,
  JavaMethodExtractionResult,
  JavaMethodInfo,
  JavaMethodNameRange,
  JavaRefactorChange,
  JavaSelection,
  JavaSyntaxNode,
} from './types'
import { leadingIndent, lineBreakOf, lineStart } from './syntax'
import { declarationAt } from './declarations'
import {
  JAVA_KEYWORDS,
  assignmentTargets,
  checkedCallInSelection,
  freeJavaDeclarations,
  identifierOccurrences,
  isIdentifier,
  outputForStatements,
  rejectControlFlow,
} from './analysis'
import { inferJavaExpressionType } from './expression-types'

export function uniqueMethodName(
  source: string,
  classBody: JavaSyntaxNode,
  requested: string | undefined,
): string {
  const base = requested && isIdentifier(requested) && !JAVA_KEYWORDS.has(requested)
    ? requested
    : 'extractedMethod'
  const used = new Set(identifierOccurrences(source, classBody.from, classBody.to)
    .map((occurrence) => occurrence.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(base + suffix)) suffix += 1
  return base + suffix
}

function indentExtractedBody(
  text: string,
  helperIndent: string,
  newline: string,
  originalIndent: string,
): string {
  const lines = text.split(/\r\n|\r|\n/)
  return lines.map((line, index) => {
    if (index === 0) return helperIndent + line
    let relative = line
    if (originalIndent && relative.startsWith(originalIndent)) {
      relative = relative.slice(originalIndent.length)
    }
    return helperIndent + relative
  }).join(newline)
}

function applyChanges(source: string, changes: readonly JavaRefactorChange[]): string {
  return [...changes]
    .sort((left, right) => right.from - left.from)
    .reduce((result, change) => (
      result.slice(0, change.from) + change.insert + result.slice(change.to)
    ), source)
}

function nameRangesAfterChanges(
  replacement: JavaRefactorChange,
  insertion: JavaRefactorChange,
  name: string,
): JavaMethodNameRange[] {
  const replacementDelta = replacement.insert.length - (replacement.to - replacement.from)
  const callOffset = replacement.insert.indexOf(name)
  const declarationOffset = insertion.insert.indexOf(name)
  if (callOffset < 0 || declarationOffset < 0) return []
  return [
    { from: replacement.from + callOffset, to: replacement.from + callOffset + name.length },
    {
      from: insertion.from + (replacement.from < insertion.from ? replacementDelta : 0) + declarationOffset,
      to: insertion.from + (replacement.from < insertion.from ? replacementDelta : 0)
        + declarationOffset + name.length,
    },
  ]
}

function helperInsertion(
  source: string,
  method: JavaMethodInfo,
  returnType: string,
  name: string,
  parameters: readonly JavaDeclaration[],
  bodyText: string,
): { from: number; insert: string } {
  const newline = lineBreakOf(source)
  const methodIndent = leadingIndent(source, method.node.from)
  const helperIndent = methodIndent + '    '
  const parameterText = parameters
    .map((parameter) => parameter.type + ' ' + parameter.name)
    .join(', ')
  const staticText = method.static ? 'static ' : ''
  const throwsText = method.throwsClause ? ' ' + method.throwsClause : ''
  const helper = [
    methodIndent + 'private ' + staticText + returnType + ' ' + name
      + '(' + parameterText + ')' + throwsText + ' {',
    bodyText,
    methodIndent + '}',
  ].join(newline)
  const closePosition = method.classBody.to - 1
  const closeLineStart = lineStart(source, closePosition)
  // For a compact one-line class, insert immediately before the closing
  // brace. Inserting at the line start would place the helper before class.
  const insertionPoint = source.slice(closeLineStart, closePosition).trim() === ''
    ? closeLineStart
    : closePosition
  const before = source.slice(0, insertionPoint)
  const linesBefore = before.split(/\r\n|\r|\n/)
  const hasBlankSeparator = linesBefore.length > 2
    && linesBefore.at(-1)?.trim() === ''
    && linesBefore.at(-2)?.trim() === ''
  const endsAtLineStart = before.endsWith('\n') || before.endsWith('\r')
  const prefix = hasBlankSeparator ? '' : endsAtLineStart ? newline : newline + newline
  return { from: insertionPoint, insert: prefix + helper + newline }
}

export function expressionPlan(
  source: string,
  selection: JavaSelection,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  name: string,
): JavaMethodExtractionResult {
  const expression = selection.expression
  if (!expression) return { reason: 'Select an expression.' }
  const returnType = inferJavaExpressionType(source, expression, declarations, methods)
  if (!returnType || returnType === 'void' || returnType === 'var') {
    return { reason: 'Cannot determine the selected expression type.' }
  }
  const free = freeJavaDeclarations(source, selection.from, selection.to, declarations, methods)
  if (free.reason) return { reason: free.reason }
  if (free.free.some((declaration) => declaration.type === 'var')) {
    return { reason: 'A captured var does not have a resolved method parameter type.' }
  }
  if (checkedCallInSelection(source, [expression], selection.method, methods)) {
    return { reason: 'The selected expression calls a checked-exception method from a method that declares none.' }
  }
  for (const target of assignmentTargets(source, [expression])) {
    const declaration = declarationAt(declarations, target, selection.from + 1)
    if (declaration && declaration.kind !== 'field') {
      return { reason: 'An extracted expression cannot mutate a captured local variable.' }
    }
  }
  const methodIndent = leadingIndent(source, selection.method.node.from)
  const body = methodIndent + '    return ' + source.slice(selection.from, selection.to) + ';'
  const insertion = helperInsertion(source, selection.method, returnType, name, free.free, body)
  const call = name + '(' + free.free.map((declaration) => declaration.name).join(', ') + ')'
  const replacement: JavaRefactorChange = { from: selection.from, to: selection.to, insert: call }
  const changes: JavaRefactorChange[] = [
    replacement,
    { from: insertion.from, to: insertion.from, insert: insertion.insert },
  ]
  return {
    changes,
    name,
    nameRanges: nameRangesAfterChanges(replacement, changes[1], name),
  }
}

export function statementPlan(
  source: string,
  selection: JavaSelection,
  declarations: readonly JavaDeclaration[],
  methods: readonly JavaMethodInfo[],
  name: string,
): JavaMethodExtractionResult {
  const controlFlow = rejectControlFlow(selection.statements)
  if (controlFlow) return controlFlow
  if (checkedCallInSelection(source, selection.statements, selection.method, methods)) {
    return { reason: 'The selected block calls a checked-exception method from a method that declares none.' }
  }
  const free = freeJavaDeclarations(source, selection.from, selection.to, declarations, methods)
  if (free.reason) return { reason: free.reason }
  if (free.free.some((declaration) => declaration.type === 'var')) {
    return { reason: 'A captured var does not have a resolved method parameter type.' }
  }
  const output = outputForStatements(
    source,
    selection.statements,
    selection.from,
    selection.to,
    selection.method,
    declarations,
  )
  if ('reason' in output) return output
  const outputDeclaration = output.declaration ?? output.existing
  if (outputDeclaration?.type === 'var') {
    return { reason: 'Cannot extract a variable declared with var without a resolved type.' }
  }
  if (output.existing && !output.existing.initialized) {
    return { reason: 'A selected assignment would pass an uninitialized local value.' }
  }
  const parameters = [...free.free]
  if (output.existing && !parameters.some((parameter) => parameter.name === output.existing?.name)) {
    parameters.push(output.existing)
  }
  const returnType = outputDeclaration?.type ?? 'void'
  const methodIndent = leadingIndent(source, selection.method.node.from)
  const helperIndent = methodIndent + '    '
  const body = indentExtractedBody(
    source.slice(selection.from, selection.to),
    helperIndent,
    lineBreakOf(source),
    leadingIndent(source, selection.from),
  )
  const bodyWithReturn = outputDeclaration
    ? body + lineBreakOf(source) + helperIndent + 'return ' + outputDeclaration.name + ';'
    : body
  const insertion = helperInsertion(
    source,
    selection.method,
    returnType,
    name,
    parameters,
    bodyWithReturn,
  )
  const argumentText = parameters.map((parameter) => parameter.name).join(', ')
  let replacement = name + '(' + argumentText + ');'
  if (output.declaration) {
    replacement = output.declaration.type + ' ' + output.declaration.name
      + ' = ' + name + '(' + argumentText + ');'
  } else if (output.existing) {
    replacement = output.existing.name + ' = ' + name + '(' + argumentText + ');'
  }
  const replacementChange: JavaRefactorChange = { from: selection.from, to: selection.to, insert: replacement }
  const changes: JavaRefactorChange[] = [
    replacementChange,
    { from: insertion.from, to: insertion.from, insert: insertion.insert },
  ]
  return {
    changes,
    name,
    nameRanges: nameRangesAfterChanges(replacementChange, changes[1], name),
  }
}

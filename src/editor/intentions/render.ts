import { children, leadingIndent, lineBreakFor, lineStart, PUNCTUATION_NODES } from './analysis'
import { normalizeType } from './inference'
import type {
  JavaIntentionChange,
  JavaInvocationInfo,
  JavaMethodInfo,
  JavaMethodParameter,
  JavaSyntaxNode,
} from './types'

function defaultReturnValue(returnType: string): string | null {
  const normalized = normalizeType(returnType)
  if (normalized === 'void') return null
  if (normalized === 'boolean') return 'false'
  if (normalized === 'char') return "'\\0'"
  if (normalized === 'byte' || normalized === 'short' || normalized === 'int') return '0'
  if (normalized === 'long') return '0L'
  if (normalized === 'float') return '0.0f'
  if (normalized === 'double') return '0.0'
  return 'null'
}

export function indentationUnit(source: string, classBody: JavaSyntaxNode, fallback = '    '): string {
  const classIndent = leadingIndent(source, classBody.to - 1)
  const members = children(classBody).filter((child) => !PUNCTUATION_NODES.has(child.name))
  for (const member of members) {
    const indent = leadingIndent(source, member.from)
    if (indent.length > classIndent.length) return indent.slice(classIndent.length) || fallback
  }
  return fallback
}

export function methodText(
  source: string,
  method: JavaInvocationInfo['method'],
  returnType: string,
  name: string,
  parameters: readonly JavaMethodParameter[],
  memberIndent: string,
  unit: string,
): { text: string; selectionOffset: number; selectionLength: number } {
  const lineBreak = lineBreakFor(source)
  const bodyIndent = memberIndent + unit
  const staticPrefix = method?.static ? 'static ' : ''
  const signature = `private ${staticPrefix}${returnType} ${name}(${parameters.map((parameter) => `${parameter.type} ${parameter.name}`).join(', ')})`
  const defaultValue = defaultReturnValue(returnType)
  if (defaultValue === null) {
    const text = `${memberIndent}${signature} {${lineBreak}${memberIndent}}`
    return { text, selectionOffset: text.length - 1, selectionLength: 0 }
  }
  const text = `${memberIndent}${signature} {${lineBreak}${bodyIndent}return ${defaultValue};${lineBreak}${memberIndent}}`
  const selectionOffset = text.indexOf(defaultValue, text.indexOf('return '))
  return { text, selectionOffset, selectionLength: defaultValue.length }
}

export function insertionAfterMethod(
  source: string,
  method: JavaMethodInfo,
  generated: string,
): JavaIntentionChange {
  const lineBreak = lineBreakFor(source)
  const from = method.body.to
  const following = source.slice(from)
  const existingLineBreak = /^[ \t]*(?:\r\n|\r|\n)/.exec(following)
  if (existingLineBreak) {
    return {
      from,
      to: from + existingLineBreak[0].length,
      insert: `${lineBreak}${lineBreak}${generated}${lineBreak}`,
    }
  }
  return {
    from,
    to: from,
    insert: `${lineBreak}${lineBreak}${generated}${lineBreak}`,
  }
}

export function insertionBeforeClassClose(
  source: string,
  classBody: JavaSyntaxNode,
  generated: string,
): JavaIntentionChange {
  const lineBreak = lineBreakFor(source)
  const close = classBody.to - 1
  const closeLineStart = lineStart(source, close)
  const closePrefix = source.slice(closeLineStart, close)
  const classIndent = /^[ \t]*/.exec(closePrefix)?.[0] ?? ''
  if (closePrefix.trim().length === 0) {
    return {
      from: closeLineStart,
      to: close,
      insert: `${generated}${lineBreak}${classIndent}`,
    }
  }
  return {
    from: close,
    to: close,
    insert: `${lineBreak}${generated}${lineBreak}${classIndent}`,
  }
}

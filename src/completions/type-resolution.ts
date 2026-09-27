import { JAVA_TYPE_IMPORTS, TYPE_GROUPS, type JavaSymbol } from './model'
import { baseType } from './source'
import { importLines } from './imports'

export interface JavaReceiverTypeResolution {
  kind: 'metadata' | 'legacy' | 'unresolved'
  typeNames: string[]
  isStatic: boolean
}

const JAVA_LANG_TYPES = new Set([
  'Appendable', 'ArithmeticException', 'AssertionError', 'AutoCloseable', 'Boolean', 'Byte', 'Character',
  'CharSequence', 'Class', 'ClassCastException', 'ClassLoader', 'CloneNotSupportedException', 'Comparable',
  'Double', 'Enum', 'EnumConstantNotPresentException', 'Error', 'Exception', 'Float', 'IllegalArgumentException',
  'IllegalMonitorStateException', 'IllegalStateException', 'IndexOutOfBoundsException', 'InheritableThreadLocal',
  'Integer', 'InterruptedException', 'Iterable', 'LinkageError', 'Long', 'Math', 'NegativeArraySizeException',
  'NoClassDefFoundError', 'NoSuchFieldError', 'NoSuchMethodError', 'NullPointerException', 'Number',
  'NumberFormatException', 'Object', 'OutOfMemoryError', 'Override', 'Process', 'ProcessBuilder', 'Readable',
  'Record', 'ReflectiveOperationException', 'Runnable', 'Runtime', 'RuntimeException', 'SecurityException',
  'Short', 'StackOverflowError', 'StackTraceElement', 'StrictMath', 'String', 'StringBuffer', 'StringBuilder',
  'StringIndexOutOfBoundsException', 'SuppressWarnings', 'System', 'Thread', 'ThreadDeath', 'ThreadGroup',
  'ThreadLocal', 'Throwable', 'UnsupportedOperationException', 'VerifyError', 'VirtualMachineError', 'Void',
])
const PRIMITIVE_TYPES = new Set(['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void'])

function symbolFor(symbols: JavaSymbol[], name: string, position: number): JavaSymbol | null {
  const candidates = symbols.filter((symbol) => symbol.name === name
    && symbol.scopeStart <= position && position <= symbol.scopeEnd)
  candidates.sort((left, right) => {
    const leftWidth = left.scopeEnd - left.scopeStart
    const rightWidth = right.scopeEnd - right.scopeStart
    return leftWidth - rightWidth || right.declaredAt - left.declaredAt
  })
  return candidates[0] ?? null
}

function canonicalTypes(source: string, typeName: string): string[] {
  const simpleName = typeName.slice(typeName.lastIndexOf('.') + 1)
  if (typeName.includes('.')) {
    const segments = typeName.split('.')
    return /^[A-Z_$]/.test(segments.at(-1) ?? '') && segments.slice(0, -1).every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment))
      ? [typeName]
      : []
  }

  const imports = importLines(source).filter((line) => !line.static)
  const explicit = imports
    .map((line) => line.name)
    .filter((name) => !name.endsWith('.*') && name.slice(name.lastIndexOf('.') + 1) === simpleName)
  if (explicit.length) return [...new Set(explicit)]

  const knownType = JAVA_TYPE_IMPORTS[simpleName]
  if (knownType) return [knownType]
  if (JAVA_LANG_TYPES.has(simpleName)) return [`java.lang.${simpleName}`]

  const wildcardTypes = imports
    .filter((line) => line.name.endsWith('.*'))
    .map((line) => `${line.name.slice(0, -2)}.${simpleName}`)
  if (wildcardTypes.length) return [...new Set(wildcardTypes)]

  const packageMatch = /^[\t ]*package[\t ]+([\w.]+)[\t ]*;/m.exec(source)
  const packageType = packageMatch ? `${packageMatch[1]}.${simpleName}` : undefined
  return [packageType ?? `java.lang.${simpleName}`]
}

function symbolTypeNames(source: string, symbol: JavaSymbol): string[] {
  const declared = symbol.declaredType && symbol.declaredType !== 'var'
    && !symbol.declaredType.includes('[]') && !PRIMITIVE_TYPES.has(baseType(symbol.declaredType))
    ? [baseType(symbol.declaredType)]
    : []
  const bases = symbol.bases.filter((base) => base !== 'array' && !PRIMITIVE_TYPES.has(base))
  const concrete = bases.filter((base) => !bases.some((other) => other !== base
    && (TYPE_GROUPS[other] ?? [other]).includes(base)))
  return [...new Set([...declared, ...concrete].flatMap((typeName) => canonicalTypes(source, typeName)))]
}

/** Resolve a lightweight receiver into canonical types for metadata inspection. */
export function resolveJavaReceiverTypes(
  source: string,
  receiver: string,
  position: number,
  symbols: JavaSymbol[],
  assertJ = false,
): JavaReceiverTypeResolution {
  if (assertJ || receiver === 'this') {
    return { kind: 'legacy', typeNames: [], isStatic: false }
  }

  const symbolName = receiver.startsWith('this.') ? receiver.slice('this.'.length) : receiver
  const symbol = symbolFor(symbols, symbolName, position)
  if (symbol) {
    if (symbol.bases.includes('array') || symbol.declaredType?.includes('[]')) {
      return { kind: 'legacy', typeNames: [], isStatic: false }
    }
    const typeNames = symbolTypeNames(source, symbol)
    return typeNames.length
      ? { kind: 'metadata', typeNames, isStatic: false }
      : { kind: 'unresolved', typeNames: [], isStatic: false }
  }

  if (receiver.startsWith('System.') && symbolFor(symbols, 'System', position)) {
    return { kind: 'unresolved', typeNames: [], isStatic: false }
  }
  if (receiver === 'System.out' || receiver === 'java.lang.System.out') {
    return { kind: 'metadata', typeNames: ['java.io.PrintStream'], isStatic: false }
  }
  if (receiver === 'System.err' || receiver === 'java.lang.System.err') {
    return { kind: 'metadata', typeNames: ['java.io.PrintStream'], isStatic: false }
  }
  if (receiver === 'System.in' || receiver === 'java.lang.System.in') {
    return { kind: 'metadata', typeNames: ['java.io.InputStream'], isStatic: false }
  }

  const simpleName = receiver.slice(receiver.lastIndexOf('.') + 1)
  if (simpleName === 'Ps') {
    return { kind: 'legacy', typeNames: [], isStatic: true }
  }
  const typeNames = canonicalTypes(source, receiver)
  return typeNames.length
    ? { kind: 'metadata', typeNames, isStatic: true }
    : { kind: 'unresolved', typeNames: [], isStatic: false }
}

import { snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'

/**
 * This is intentionally a small, source-text based completion provider.  It is
 * not intended to replace a Java language server.  The editor only needs the
 * handful of JDK/AssertJ APIs used repeatedly while solving LeetCode problems.
 */

export interface JavaSymbol {
  name: string
  /** All useful views of a value.  For example `List` declared with
   * `new ArrayList<>()` has both `List` and `ArrayList` here. */
  bases: string[]
  kind: 'field' | 'parameter' | 'local'
  declaredAt: number
  scopeStart: number
  scopeEnd: number
}

export interface JavaMethod {
  name: string
  parameters: string[]
  declaredAt: number
}

interface MethodSpec {
  name: string
  parameters?: string[]
  detail?: string
}

interface DotContext {
  receiver: string
  from: number
  assertJ: boolean
}

interface ReceiverResolution {
  bases: string[]
  static: boolean
  unknown: boolean
  primitive: boolean
  array: boolean
  thisReceiver: boolean
}

const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new', 'null',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var', 'void',
  'volatile', 'while',
]

const JAVA_TYPES = [
  'ArrayDeque', 'ArrayList', 'Arrays', 'BigDecimal', 'BigInteger', 'Boolean', 'Byte', 'Character',
  'Collections', 'Comparator', 'Deque', 'Double', 'Float', 'HashMap', 'HashSet', 'Integer',
  'Iterable', 'Iterator', 'LinkedHashMap', 'LinkedHashSet', 'LinkedList', 'List', 'Long', 'Map',
  'Math', 'Object', 'PriorityQueue', 'Queue', 'Set', 'Short', 'Stack', 'String', 'StringBuilder',
  'StringBuffer', 'TreeMap', 'TreeSet',
]

const JAVA_COMPLETIONS: Completion[] = [
  ...JAVA_KEYWORDS.map((label) => ({ label, type: 'keyword' as const })),
  ...JAVA_TYPES.map((label) => ({ label, type: 'type' as const })),
  methodCompletion({ name: 'assertThat', parameters: ['value'], detail: 'AssertJ' }, 'function'),
  snippetCompletion('assertThat(...).isEqualTo(...)', 'AssertJ', 'assertThat(${actual}).isEqualTo(${expected})'),
  snippetCompletion('assertThat(...).isTrue()', 'AssertJ', 'assertThat(${actual}).isTrue()'),
  snippetCompletion('assertThat(...).isFalse()', 'AssertJ', 'assertThat(${actual}).isFalse()'),
  snippetCompletion('List.of(...)', 'List', 'List.of(${items})'),
  snippetCompletion('Map.of(...)', 'Map', 'Map.of(${entries})'),
  snippetCompletion('Set.of(...)', 'Set', 'Set.of(${items})'),
  snippetCompletion('new ArrayList<>()', 'ArrayList', 'new ArrayList<>()'),
  snippetCompletion('new HashMap<>()', 'HashMap', 'new HashMap<>()'),
  snippetCompletion('for (int i = 0; i < ...; i++)', 'loop', 'for (int ${i} = 0; ${i} < ${length}; ${i}++) {\n    ${}\n}'),
  snippetCompletion('for (var item : ...)', 'loop', 'for (var ${item} : ${items}) {\n    ${}\n}'),
]

const CATALOG: Record<string, MethodSpec[]> = {
  Iterable: specs([
    ['forEach', ['action']], ['iterator'], ['spliterator'], ['stream'], ['parallelStream'],
  ]),
  Collection: specs([
    ['add', ['element']], ['addAll', ['collection']], ['clear'], ['contains', ['object']],
    ['containsAll', ['collection']], ['isEmpty'], ['remove', ['object']], ['removeAll', ['collection']],
    ['removeIf', ['filter']], ['retainAll', ['collection']], ['size'], ['toArray'], ['toArray', ['array']],
    ['stream'], ['parallelStream'], ['equals', ['object']], ['hashCode'],
  ]),
  List: specs([
    ['add', ['element']], ['add', ['index', 'element']], ['addAll', ['collection']],
    ['addAll', ['index', 'collection']], ['clear'], ['contains', ['object']], ['containsAll', ['collection']],
    ['get', ['index']], ['indexOf', ['object']], ['isEmpty'], ['iterator'], ['lastIndexOf', ['object']],
    ['listIterator'], ['listIterator', ['index']], ['remove', ['index']], ['remove', ['object']],
    ['removeAll', ['collection']], ['removeIf', ['filter']], ['replaceAll', ['operator']], ['retainAll', ['collection']],
    ['set', ['index', 'element']], ['size'], ['sort', ['comparator']], ['subList', ['fromIndex', 'toIndex']],
    ['toArray'], ['toArray', ['array']], ['spliterator'], ['stream'], ['parallelStream'], ['equals', ['object']],
    ['hashCode'],
  ]),
  Map: specs([
    ['clear'], ['compute', ['key', 'remappingFunction']], ['computeIfAbsent', ['key', 'mappingFunction']],
    ['computeIfPresent', ['key', 'remappingFunction']], ['containsKey', ['key']], ['containsValue', ['value']],
    ['entrySet'], ['equals', ['object']], ['forEach', ['action']], ['get', ['key']],
    ['getOrDefault', ['key', 'defaultValue']], ['hashCode'], ['isEmpty'], ['keySet'], ['merge', ['key', 'value', 'remappingFunction']],
    ['put', ['key', 'value']], ['putAll', ['map']], ['putIfAbsent', ['key', 'value']], ['remove', ['key']],
    ['remove', ['key', 'value']], ['replace', ['key', 'value']], ['replace', ['key', 'oldValue', 'newValue']],
    ['replaceAll', ['function']], ['size'], ['values'],
  ]),
  Set: specs([
    ['add', ['element']], ['addAll', ['collection']], ['clear'], ['contains', ['object']],
    ['containsAll', ['collection']], ['isEmpty'], ['iterator'], ['remove', ['object']], ['removeAll', ['collection']],
    ['removeIf', ['filter']], ['retainAll', ['collection']], ['size'], ['toArray'], ['toArray', ['array']],
    ['stream'], ['parallelStream'], ['spliterator'], ['equals', ['object']], ['hashCode'],
  ]),
  Queue: specs([
    ['add', ['element']], ['element'], ['offer', ['element']], ['peek'], ['poll'], ['remove'],
    ['remove', ['object']], ['size'], ['isEmpty'], ['contains', ['object']], ['iterator'], ['toArray'],
    ['clear'], ['stream'], ['parallelStream'],
  ]),
  Deque: specs([
    ['addFirst', ['element']], ['addLast', ['element']], ['offerFirst', ['element']], ['offerLast', ['element']],
    ['getFirst'], ['getLast'], ['peekFirst'], ['peekLast'], ['pollFirst'], ['pollLast'], ['removeFirst'],
    ['removeLast'], ['removeFirstOccurrence', ['object']], ['removeLastOccurrence', ['object']], ['add', ['element']],
    ['offer', ['element']], ['remove'], ['poll'], ['element'], ['peek'], ['push', ['element']], ['pop'],
    ['descendingIterator'], ['iterator'], ['size'], ['isEmpty'], ['contains', ['object']], ['clear'],
  ]),
  String: specs([
    ['length'], ['isEmpty'], ['isBlank'], ['charAt', ['index']], ['codePointAt', ['index']], ['codePointCount', ['beginIndex', 'endIndex']],
    ['compareTo', ['anotherString']], ['compareToIgnoreCase', ['str']], ['concat', ['str']], ['contains', ['sequence']],
    ['contentEquals', ['sequence']], ['endsWith', ['suffix']], ['equals', ['object']], ['equalsIgnoreCase', ['anotherString']],
    ['getBytes'], ['getBytes', ['charset']], ['getChars', ['srcBegin', 'srcEnd', 'dst', 'dstBegin']], ['hashCode'],
    ['indexOf', ['str']], ['indexOf', ['str', 'fromIndex']], ['intern'], ['lastIndexOf', ['str']],
    ['lines'], ['matches', ['regex']], ['regionMatches', ['toffset', 'other', 'ooffset', 'len']], ['repeat', ['count']],
    ['replace', ['target', 'replacement']], ['replaceAll', ['regex', 'replacement']], ['replaceFirst', ['regex', 'replacement']],
    ['split', ['regex']], ['split', ['regex', 'limit']], ['startsWith', ['prefix']], ['strip'], ['stripIndent'], ['stripLeading'],
    ['stripTrailing'], ['substring', ['beginIndex']], ['substring', ['beginIndex', 'endIndex']], ['toCharArray'], ['toLowerCase'],
    ['toString'], ['toUpperCase'], ['trim'], ['formatted', ['args']], ['transform', ['function']],
  ]),
  StringBuilder: specs([
    ['append', ['value']], ['appendCodePoint', ['codePoint']], ['capacity'], ['charAt', ['index']], ['codePoints'],
    ['codePointAt', ['index']], ['codePointBefore', ['index']], ['delete', ['start', 'end']], ['deleteCharAt', ['index']],
    ['ensureCapacity', ['minimumCapacity']], ['getChars', ['srcBegin', 'srcEnd', 'dst', 'dstBegin']], ['indexOf', ['str']],
    ['indexOf', ['str', 'fromIndex']], ['insert', ['offset', 'value']], ['lastIndexOf', ['str']], ['length'],
    ['offsetByCodePoints', ['index', 'codePointOffset']], ['replace', ['start', 'end', 'str']], ['reverse'],
    ['setCharAt', ['index', 'ch']], ['setLength', ['newLength']], ['subSequence', ['start', 'end']],
    ['substring', ['start']], ['substring', ['start', 'end']], ['toString'], ['trimToSize'],
  ]),
  Character: specs([
    ['charValue'], ['compareTo', ['another']], ['equals', ['object']], ['hashCode'], ['toString'],
  ]),
  Integer: numberInstanceMethods('int'),
  Long: numberInstanceMethods('long'),
  Double: numberInstanceMethods('double'),
  Float: numberInstanceMethods('float'),
  Short: numberInstanceMethods('short'),
  Byte: numberInstanceMethods('byte'),
  Boolean: specs([
    ['booleanValue'], ['toString'],
  ]),
}

const TYPE_GROUPS: Record<string, string[]> = {
  ArrayList: ['ArrayList', 'List', 'Collection', 'Iterable'],
  LinkedList: ['LinkedList', 'List', 'Deque', 'Queue', 'Collection', 'Iterable'],
  Stack: ['Stack', 'List', 'Collection', 'Iterable'],
  HashMap: ['HashMap', 'Map'], LinkedHashMap: ['LinkedHashMap', 'HashMap', 'Map'], TreeMap: ['TreeMap', 'Map'],
  HashSet: ['HashSet', 'Set', 'Collection', 'Iterable'], LinkedHashSet: ['LinkedHashSet', 'HashSet', 'Set', 'Collection', 'Iterable'],
  TreeSet: ['TreeSet', 'Set', 'Collection', 'Iterable'],
  ArrayDeque: ['ArrayDeque', 'Deque', 'Queue', 'Collection', 'Iterable'], PriorityQueue: ['PriorityQueue', 'Queue', 'Collection', 'Iterable'],
  List: ['List', 'Collection', 'Iterable'], Set: ['Set', 'Collection', 'Iterable'], Queue: ['Queue', 'Collection', 'Iterable'],
  Deque: ['Deque', 'Queue', 'Collection', 'Iterable'],
}

const STATIC_CATALOG: Record<string, MethodSpec[]> = {
  List: specs([
    ['of'], ['of', ['element']], ['of', ['e1', 'e2']], ['of', ['elements']], ['copyOf', ['collection']],
  ]),
  Set: specs([
    ['of'], ['of', ['element']], ['of', ['e1', 'e2']], ['of', ['elements']], ['copyOf', ['collection']],
  ]),
  Map: specs([
    ['of'], ['of', ['key', 'value']], ['of', ['k1', 'v1', 'k2', 'v2']], ['ofEntries', ['entries']], ['copyOf', ['map']],
  ]),
  String: specs([
    ['copyValueOf', ['data']], ['format', ['format', 'args']], ['join', ['delimiter', 'elements']], ['valueOf', ['value']],
  ]),
  Arrays: specs([
    ['asList', ['array']], ['binarySearch', ['array', 'key']], ['copyOf', ['original', 'newLength']],
    ['copyOfRange', ['original', 'from', 'to']], ['deepEquals', ['a1', 'a2']], ['deepHashCode', ['a']],
    ['deepToString', ['a']], ['equals', ['a', 'a2']], ['fill', ['array', 'value']], ['hashCode', ['a']],
    ['mismatch', ['a', 'a2']], ['parallelPrefix', ['array', 'op']], ['parallelSort', ['array']], ['setAll', ['array', 'generator']],
    ['sort', ['array']], ['spliterator', ['array']], ['stream', ['array']], ['toString', ['array']],
  ]),
  Collections: specs([
    ['addAll', ['collection', 'elements']], ['binarySearch', ['list', 'key']], ['copy', ['dest', 'src']],
    ['disjoint', ['c1', 'c2']], ['emptyList'], ['emptyMap'], ['emptySet'], ['fill', ['list', 'object']],
    ['frequency', ['collection', 'object']], ['indexOfSubList', ['source', 'target']], ['lastIndexOfSubList', ['source', 'target']],
    ['max', ['collection']], ['min', ['collection']], ['nCopies', ['n', 'object']], ['replaceAll', ['list', 'oldValue', 'newValue']],
    ['reverse', ['list']], ['reverseOrder'], ['rotate', ['list', 'distance']], ['shuffle', ['list']], ['singleton', ['object']],
    ['singletonList', ['object']], ['sort', ['list']], ['swap', ['list', 'i', 'j']], ['unmodifiableCollection', ['collection']],
    ['unmodifiableList', ['list']], ['unmodifiableMap', ['map']], ['unmodifiableSet', ['set']],
  ]),
  Math: specs([
    ['abs', ['value']], ['acos', ['value']], ['asin', ['value']], ['atan', ['value']], ['atan2', ['y', 'x']],
    ['cbrt', ['value']], ['ceil', ['value']], ['copySign', ['magnitude', 'sign']], ['cos', ['value']],
    ['decrementExact', ['value']], ['exp', ['value']], ['expm1', ['value']], ['floor', ['value']],
    ['floorDiv', ['x', 'y']], ['floorMod', ['x', 'y']], ['getExponent', ['value']], ['hypot', ['x', 'y']],
    ['incrementExact', ['value']], ['log', ['value']], ['log10', ['value']], ['log1p', ['value']], ['max', ['a', 'b']],
    ['min', ['a', 'b']], ['multiplyExact', ['x', 'y']], ['negateExact', ['value']], ['nextAfter', ['start', 'direction']],
    ['nextDown', ['value']], ['nextUp', ['value']], ['pow', ['a', 'b']], ['random'], ['round', ['value']],
    ['scalb', ['d', 'scaleFactor']], ['signum', ['value']], ['sin', ['value']], ['sqrt', ['value']],
    ['subtractExact', ['x', 'y']], ['tan', ['value']], ['toDegrees', ['value']], ['toIntExact', ['value']],
    ['toRadians', ['value']], ['ulp', ['value']],
  ]),
  Character: specs([
    ['charCount', ['codePoint']], ['codePointAt', ['seq', 'index']], ['codePointBefore', ['seq', 'index']],
    ['digit', ['ch', 'radix']], ['forDigit', ['digit', 'radix']], ['getNumericValue', ['ch']], ['highSurrogate', ['codePoint']],
    ['isAlphabetic', ['codePoint']], ['isBmpCodePoint', ['codePoint']], ['isDigit', ['ch']], ['isHighSurrogate', ['ch']],
    ['isLetter', ['ch']], ['isLetterOrDigit', ['ch']], ['isLowerCase', ['ch']], ['isLowSurrogate', ['ch']],
    ['isSpaceChar', ['ch']], ['isSupplementaryCodePoint', ['codePoint']], ['isSurrogate', ['ch']], ['isTitleCase', ['ch']],
    ['isUpperCase', ['ch']], ['isValidCodePoint', ['codePoint']], ['isWhitespace', ['ch']], ['lowSurrogate', ['codePoint']],
    ['toChars', ['codePoint']], ['toCodePoint', ['high', 'low']], ['toLowerCase', ['ch']], ['toTitleCase', ['ch']], ['toUpperCase', ['ch']],
  ]),
  Integer: numberStaticMethods('int'), Long: numberStaticMethods('long'), Double: numberStaticMethods('double'),
  Float: numberStaticMethods('float'), Short: numberStaticMethods('short'), Byte: numberStaticMethods('byte'),
  Boolean: specs([
    ['compare', ['x', 'y']], ['getBoolean', ['name']], ['logicalAnd', ['a', 'b']], ['logicalOr', ['a', 'b']],
    ['logicalXor', ['a', 'b']], ['parseBoolean', ['value']], ['toString', ['value']], ['valueOf', ['value']],
  ]),
}

const OBJECT_METHODS = specs([
  ['equals', ['object']], ['hashCode'], ['toString'], ['getClass'],
])

const ARRAY_METHODS = specs([['clone']])
const PRIMITIVE_BASES = new Set(['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short'])

const ASSERTJ_METHODS = specs([
  ['as', ['description']], ['describedAs', ['description']], ['contains', ['values']], ['containsExactly', ['values']],
  ['containsExactlyInAnyOrder', ['values']], ['containsEntry', ['key', 'value']], ['containsKey', ['key']], ['containsValue', ['value']],
  ['doesNotContain', ['values']], ['doesNotContainEntry', ['key', 'value']], ['doesNotContainKey', ['key']],
  ['doesNotContainValue', ['value']], ['hasSameSizeAs', ['other']], ['hasSize', ['size']], ['isBetween', ['start', 'end']],
  ['isCloseTo', ['expected', 'offset']], ['isEqualTo', ['expected']], ['isFalse'], ['isGreaterThan', ['other']],
  ['isGreaterThanOrEqualTo', ['other']], ['isIn', ['values']], ['isInstanceOf', ['type']], ['isLessThan', ['other']],
  ['isLessThanOrEqualTo', ['other']], ['isNaN'], ['isNegative'], ['isNotBetween', ['start', 'end']], ['isNotEqualTo', ['expected']],
  ['isNotIn', ['values']], ['isNotInstanceOf', ['type']], ['isNotNull'], ['isNotSameAs', ['other']], ['isNotZero'],
  ['isNull'], ['isSameAs', ['other']], ['isTrue'], ['isZero'], ['startsWith', ['prefix']], ['endsWith', ['suffix']],
  ['allMatch', ['condition']], ['anyMatch', ['condition']], ['noneMatch', ['condition']], ['extracting', ['function']],
  ['withFailMessage', ['message']],
])

function specs(values: Array<[string, string[]?]>): MethodSpec[] {
  return values.map(([name, parameters]) => ({ name, parameters }))
}

function numberInstanceMethods(kind: string): MethodSpec[] {
  return specs([
    ['toString'], ['compareTo', ['another']], ['intValue'], ['longValue'], ['doubleValue'], ['floatValue'],
    ['shortValue'], ['byteValue'], ['numberValue'],
  ])
}

function numberStaticMethods(kind: string): MethodSpec[] {
  const parseName = kind === 'long' ? 'parseLong' : kind === 'double' ? 'parseDouble' : kind === 'float' ? 'parseFloat' : 'parseInt'
  return specs([
    [parseName, ['value']], ['valueOf', ['value']], ['toString', ['value']], ['compare', ['x', 'y']],
    ['max', ['a', 'b']], ['min', ['a', 'b']], ['sum', ['a', 'b']],
    ...(kind === 'int' || kind === 'long' ? [['compareUnsigned', ['x', 'y']] as [string, string[]]] : []),
    ...(kind === 'double' || kind === 'float' ? [['isFinite', ['value']] as [string, string[]], ['isNaN', ['value']] as [string, string[]]] : []),
  ])
}

function methodCompletion(spec: MethodSpec, type: Completion['type'] = 'method'): Completion {
  const parameters = spec.parameters ?? []
  const label = `${spec.name}(${parameters.join(', ')})`
  if (parameters.length === 0) {
    return { label, type, detail: spec.detail, apply: `${spec.name}()` }
  }
  const body = `${spec.name}(${parameters.map((parameter) => `\${${parameter}}`).join(', ')})`
  return { label, type, detail: spec.detail, apply: snippet(body) }
}

function snippetCompletion(label: string, detail: string | undefined, body: string): Completion {
  return { label, type: 'snippet', detail, apply: snippet(body) }
}

function normalizeType(raw: string): string {
  return raw
    .replace(/@\w+(?:\([^)]*\))?\s*/g, '')
    .replace(/\b(?:final|volatile|transient)\s+/g, '')
    .replace(/\s+/g, '')
    .replace(/\.\.\./g, '[]')
}

function baseType(raw: string): string {
  const normalized = normalizeType(raw).replace(/\[\]/g, '')
  const generic = normalized.indexOf('<')
  return (generic >= 0 ? normalized.slice(0, generic) : normalized).replace(/^\?extends/, '')
}

function inferBases(typeText: string, initializer: string | undefined): string[] {
  const normalized = normalizeType(typeText)
  const declared = baseType(normalized)
  const bases = new Set<string>()
  if (declared && declared !== 'var') {
    bases.add(declared)
  }
  if (initializer) {
    const newMatch = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*<[^;{}()]*>)?)/.exec(initializer)
    if (newMatch) {
      bases.add(baseType(newMatch[1]))
    }
    if (/^\s*"(?:[^"\\]|\\.)*"/.test(initializer) || /^\s*'/.test(initializer)) bases.add('String')
    if (/\b(?:Arrays\s*\.\s*asList|List\s*\.\s*of)\s*\(/.test(initializer)) bases.add('List')
    if (/\b(?:Set\s*\.\s*of)\s*\(/.test(initializer)) bases.add('Set')
    if (/\bMap\s*\.\s*of(?:Entries)?\s*\(/.test(initializer)) bases.add('Map')
    if (/^\s*new\s+[A-Za-z_$][\w$]*\s*\[/.test(initializer)) bases.add('array')
  }
  if (normalized.endsWith('[]')) bases.add('array')
  const expanded = new Set<string>()
  for (const base of bases) {
    for (const group of TYPE_GROUPS[base] ?? [base]) expanded.add(group)
  }
  return [...expanded]
}

function matchingBraces(source: string): { openToClose: Map<number, number>; closeToOpen: Map<number, number> } {
  const openToClose = new Map<number, number>()
  const closeToOpen = new Map<number, number>()
  const stack: number[] = []
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (char === '{') stack.push(i)
    if (char === '}') {
      const open = stack.pop()
      if (open !== undefined) {
        openToClose.set(open, i)
        closeToOpen.set(i, open)
      }
    }
  }
  return { openToClose, closeToOpen }
}

function enclosingScope(position: number, braces: ReturnType<typeof matchingBraces>): { start: number; end: number; depth: number } {
  const containing = [...braces.openToClose.entries()]
    .filter(([open, close]) => open < position && position < close)
  if (containing.length === 0) return { start: 0, end: Number.MAX_SAFE_INTEGER, depth: 0 }
  // The map is populated as closing braces are found, so insertion order is
  // innermost-first. Select the narrowest scope explicitly and count all
  // containing blocks for reliable field-vs-local classification.
  const [open, close] = containing.reduce((best, current) => {
    const bestWidth = best[1] - best[0]
    const currentWidth = current[1] - current[0]
    return currentWidth < bestWidth ? current : best
  })
  return { start: open + 1, end: close, depth: containing.length }
}

function splitTopLevel(value: string): string[] {
  const result: string[] = []
  let start = 0
  let angle = 0
  let paren = 0
  let bracket = 0
  let quote = ''
  let escaped = false
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (char === '<') angle += 1
    else if (char === '>' && angle > 0) angle -= 1
    else if (char === '(') paren += 1
    else if (char === ')' && paren > 0) paren -= 1
    else if (char === '[') bracket += 1
    else if (char === ']' && bracket > 0) bracket -= 1
    else if (char === ',' && angle === 0 && paren === 0 && bracket === 0) {
      result.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parameterNameAndType(parameter: string): { name: string; type: string } | null {
  const clean = parameter
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/g, ' ')
    .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
    .replace(/\bfinal\s+/g, '')
    .trim()
  const match = /^(.*?)\s+([A-Za-z_$][\w$]*)$/.exec(clean)
  if (!match) return null
  if (/^(?:if|while|switch|catch|for)$/.test(match[1].trim())) return null
  return { type: match[1].trim(), name: match[2] }
}

function extractParameters(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  const methodBody = /\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/g
  let match: RegExpExecArray | null
  while ((match = methodBody.exec(source))) {
    const openBrace = methodBody.lastIndex - 1
    const closeBrace = braces.openToClose.get(openBrace) ?? source.length
    if (!(openBrace < position && position < closeBrace)) continue
    const parameters = splitTopLevel(match[1])
    for (const parameter of parameters) {
      const parsed = parameterNameAndType(parameter)
      if (!parsed) continue
      const nameStart = match.index + match[0].indexOf(parsed.name)
      result.push({
        name: parsed.name,
        bases: inferBases(parsed.type, undefined),
        kind: 'parameter',
        declaredAt: nameStart,
        scopeStart: openBrace + 1,
        scopeEnd: closeBrace,
      })
    }
  }
  return result
}

function extractDeclarations(source: string, position: number, braces: ReturnType<typeof matchingBraces>): JavaSymbol[] {
  const result: JavaSymbol[] = []
  // A declaration starts after a statement/block boundary.  Keeping the
  // boundary in the expression avoids treating method calls as declarations.
  const declaration = /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|volatile|transient|synchronized)\s+)*([A-Za-z_$][\w$]*(?:\s*<[^;{}=]*?>)?\s*(?:\[\s*\])*)\s+([^;{}]+);/gm
  // Primitive names are legal declaration types even though Java classifies
  // them as keywords.  Only these statement/control-flow words invalidate the
  // first token of a declaration match.
  const reserved = new Set(['return', 'throw', 'new', 'case', 'default', 'if', 'for', 'while', 'switch', 'do', 'else', 'try', 'catch'])
  let match: RegExpExecArray | null
  while ((match = declaration.exec(source))) {
    const typeText = match[1].trim()
    const typeBase = baseType(typeText)
    if (reserved.has(typeBase) || typeBase === 'void') continue
    const declarators = splitTopLevel(match[2])
    const boundaryOffset = match[0].indexOf(typeText)
    const declarationStart = match.index + Math.max(0, boundaryOffset)
    const scope = enclosingScope(declarationStart, braces)
    for (const declarator of declarators) {
      const variable = /^([A-Za-z_$][\w$]*)(?:\s*=\s*([\s\S]*))?$/.exec(declarator)
      if (!variable) continue
      const declaredAt = match.index + match[0].indexOf(variable[1], boundaryOffset)
      const isField = scope.depth <= 1
      // Fields are visible throughout the class, including from methods
      // written before the field declaration. Local variables still obey the
      // normal declaration-before-use rule.
      if (declaredAt > position && !isField) continue
      result.push({
        name: variable[1],
        bases: inferBases(typeText, variable[2]),
        kind: isField ? 'field' : 'local',
        declaredAt,
        scopeStart: scope.start,
        scopeEnd: scope.end,
      })
    }
  }
  // `for (int i = 0; ...` has a parenthesis boundary rather than a statement
  // boundary.  It is common enough in LeetCode solutions to handle separately.
  const forDeclaration = /\bfor\s*\(\s*(?:final\s+)?([A-Za-z_$][\w$]*(?:\s*<[^;(){}]*?>)?\s*(?:\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/g
  while ((match = forDeclaration.exec(source))) {
    const declaredAt = match.index + match[0].lastIndexOf(match[2])
    if (declaredAt > position) continue
    const scope = enclosingScope(match.index, braces)
    result.push({
      name: match[2], bases: inferBases(match[1], match[3]), kind: 'local', declaredAt,
      scopeStart: scope.start, scopeEnd: scope.end,
    })
  }
  return result
}

export function collectJavaSymbols(source: string, position = source.length): JavaSymbol[] {
  const braces = matchingBraces(source)
  return [...extractDeclarations(source, position, braces), ...extractParameters(source, position, braces)]
}

export function collectJavaMethods(source: string): JavaMethod[] {
  const result: JavaMethod[] = []
  const method = /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(?:<[^>{}]+>\s*)?(?:[A-Za-z_$][\w$]*(?:\s*<[^>{}]*>)?\s*(?:\[\s*\])?\s+)?([A-Za-z_$][\w$]*)\s*\(([^(){}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm
  let match: RegExpExecArray | null
  while ((match = method.exec(source))) {
    const name = match[1]
    if (/^(?:if|for|while|switch|catch|try|synchronized)$/.test(name)) continue
    const parameters = splitTopLevel(match[2]).map(parameterNameAndType).filter((value): value is { name: string; type: string } => value !== null).map((value) => value.name)
    result.push({ name, parameters, declaredAt: match.index })
  }
  return result
}

function findDotContext(source: string, position: number): DotContext | null {
  const before = source.slice(0, position)
  const dotWord = /(?:^|[^\w$])((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(before)
  if (dotWord) {
    const typed = dotWord[2] ?? ''
    return { receiver: dotWord[1], from: position - typed.length, assertJ: false }
  }
  const assertStart = before.lastIndexOf('assertThat')
  if (assertStart >= 0) {
    const chain = before.slice(assertStart)
    if (/^assertThat\b[\s\S]*\.\s*[A-Za-z_$]*$/.test(chain)) {
      const typed = /\.\s*([A-Za-z_$]*)$/.exec(chain)?.[1] ?? ''
      return { receiver: chain, from: position - typed.length, assertJ: true }
    }
  }
  return null
}

function symbolFor(symbols: JavaSymbol[], name: string, position: number): JavaSymbol | null {
  const candidates = symbols.filter((symbol) => symbol.name === name && symbol.scopeStart <= position && position <= symbol.scopeEnd)
  candidates.sort((left, right) => {
    const leftWidth = left.scopeEnd - left.scopeStart
    const rightWidth = right.scopeEnd - right.scopeStart
    return leftWidth - rightWidth || right.declaredAt - left.declaredAt
  })
  return candidates[0] ?? null
}

function completionOptions(items: MethodSpec[]): Completion[] {
  return items.map((item) => methodCompletion(item))
}

function methodOptions(resolution: ReceiverResolution, assertJ = false): Completion[] {
  if (assertJ) {
    return completionOptions([...ASSERTJ_METHODS, ...OBJECT_METHODS])
  }
  if (resolution.array) {
    return [
      { label: 'length', type: 'field' as const, detail: 'array length', apply: 'length' },
      ...completionOptions(ARRAY_METHODS),
    ]
  }
  if (resolution.thisReceiver || resolution.unknown || resolution.primitive) {
    return completionOptions(OBJECT_METHODS)
  }
  if (resolution.static) {
    const allStatic = resolution.bases.flatMap((base) => STATIC_CATALOG[base] ?? [])
    return completionOptions(uniqueMethodSpecs(allStatic))
  }

  const all = new Map<string, MethodSpec>()
  for (const base of resolution.bases) {
    for (const group of TYPE_GROUPS[base] ?? [base]) {
      for (const item of CATALOG[group] ?? []) {
        const key = `${item.name}(${(item.parameters ?? []).join(',')})`
        if (!all.has(key)) all.set(key, item)
      }
    }
  }
  for (const item of OBJECT_METHODS) {
    const key = `${item.name}(${(item.parameters ?? []).join(',')})`
    if (!all.has(key)) all.set(key, item)
  }
  return [...all.values()].map((item) => methodCompletion(item))
}

function uniqueMethodSpecs(items: MethodSpec[]): MethodSpec[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.name}(${(item.parameters ?? []).join(',')})`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function receiverResolution(receiver: string, position: number, symbols: JavaSymbol[]): ReceiverResolution {
  if (receiver === 'this') {
    return { bases: [], static: false, unknown: false, primitive: false, array: false, thisReceiver: true }
  }
  const symbolName = receiver.startsWith('this.') ? receiver.slice('this.'.length) : receiver
  const symbol = symbolFor(symbols, symbolName, position)
  if (symbol) {
    return {
      bases: symbol.bases,
      static: false,
      unknown: false,
      primitive: symbol.bases.some((base) => PRIMITIVE_BASES.has(base)),
      array: symbol.bases.includes('array'),
      thisReceiver: false,
    }
  }
  const staticBase = receiver.replace(/^this\./, '')
  const knownType = JAVA_TYPES.includes(staticBase)
  if (knownType) {
    return { bases: [staticBase], static: true, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (/^new\s+StringBuilder/.test(receiver)) {
    return { bases: ['StringBuilder'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (/^new\s+ArrayList/.test(receiver)) {
    return { bases: ['ArrayList'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  // Keep unresolved receivers deliberately conservative.  Offering list
  // methods here is worse than showing only Object methods because it makes
  // invalid code look valid and is particularly noisy for primitive values.
  return { bases: [], static: false, unknown: true, primitive: false, array: false, thisReceiver: false }
}

function symbolCompletions(symbols: JavaSymbol[]): Completion[] {
  const seen = new Set<string>()
  return symbols
    .sort((left, right) => right.declaredAt - left.declaredAt)
    .filter((symbol) => {
      if (seen.has(symbol.name)) return false
      seen.add(symbol.name)
      return true
    })
    .map((symbol) => ({ label: symbol.name, type: 'variable' as const, detail: symbol.bases[0] ?? 'value', apply: symbol.name }))
}

function methodCompletions(methods: JavaMethod[]): Completion[] {
  const seen = new Set<string>()
  return methods.filter((method) => {
    if (seen.has(method.name)) return false
    seen.add(method.name)
    return true
  }).map((method) => methodCompletion({ name: method.name, parameters: method.parameters }, 'function'))
}

function thisMemberCompletions(symbols: JavaSymbol[], methods: JavaMethod[]): Completion[] {
  return uniqueOptions([
    ...symbolCompletions(symbols.filter((symbol) => symbol.kind === 'field')),
    ...methodCompletions(methods),
  ])
}

function uniqueOptions(options: Completion[]): Completion[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    if (seen.has(option.label)) return false
    seen.add(option.label)
    return true
  })
}

export function javaCompletions(context: CompletionContext): CompletionResult | null {
  const source = context.state.doc.toString()
  const position = context.pos
  const dot = findDotContext(source, position)
  const symbols = collectJavaSymbols(source, position)
  const methods = collectJavaMethods(source)
  if (dot) {
    if (dot.receiver === 'this') {
      return {
        from: dot.from,
        options: thisMemberCompletions(symbols, methods),
        validFor: /^[\w$]*$/,
      }
    }
    const resolution = receiverResolution(dot.receiver, position, symbols)
    return {
      from: dot.from,
      options: methodOptions(resolution, dot.assertJ),
      validFor: /^[\w$]*$/,
    }
  }
  const word = context.matchBefore(/[\w$]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return {
    from: word.from,
    options: uniqueOptions([...symbolCompletions(symbols), ...methodCompletions(methods), ...JAVA_COMPLETIONS]),
    validFor: /^[\w$]*$/,
  }
}

export { JAVA_COMPLETIONS }

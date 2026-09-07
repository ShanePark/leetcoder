/** Source-level Java metadata shared by the completion and analysis modules. */

export interface JavaSymbol {
  name: string
  /** All useful views of a value. For example, List initialized with an ArrayList has both bases. */
  bases: string[]
  /** The source declaration type, used to avoid treating an Object as iterable. */
  declaredType?: string
  /** The declared element type when this value is an array or generic iterable. */
  elementType?: string
  kind: 'field' | 'parameter' | 'local'
  declaredAt: number
  scopeStart: number
  scopeEnd: number
}

export interface JavaMethod {
  name: string
  parameters: string[]
  declaredAt: number
  /** Exact source range of the method name, used by definition navigation. */
  nameStart: number
  nameEnd: number
}

export interface JavaIdentifier {
  name: string
  from: number
  to: number
}

export interface JavaDefinition {
  name: string
  /** Exact source range of the declaration name. */
  from: number
  to: number
  parameters: string[]
  declaredAt: number
}

export interface ImportLine {
  name: string
  static: boolean
  from: number
  to: number
}

export type JavaPrintTemplateKind = 'sout' | 'soutv' | 'serr' | 'serrv'

export interface JavaIterableCandidate {
  name: string
  elementType?: string
  variableName: string
}

/** Java keywords offered by the top-level completion provider. */
export const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new', 'null',
  'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var', 'void',
  'volatile', 'while',
]

/** Java types with completion entries and the small source resolver's type model. */
export const JAVA_TYPES = [
  'ArrayDeque', 'ArrayList', 'Arrays', 'BigDecimal', 'BigInteger', 'Boolean', 'Byte', 'Character',
  'Collections', 'Comparator', 'Deque', 'Double', 'Float', 'HashMap', 'HashSet', 'Integer',
  'InputStream', 'Iterable', 'Iterator', 'LinkedHashMap', 'LinkedHashSet', 'LinkedList', 'List', 'Long', 'Map',
  'Math', 'Object', 'PrintStream', 'PriorityQueue', 'Queue', 'Set', 'Short', 'Stack', 'String', 'StringBuilder',
  'StringBuffer', 'System', 'TreeMap', 'TreeSet',
]

export const JAVA_TYPE_IMPORTS: Readonly<Record<string, string>> = {
  ArrayDeque: 'java.util.ArrayDeque',
  ArrayList: 'java.util.ArrayList',
  Arrays: 'java.util.Arrays',
  BigDecimal: 'java.math.BigDecimal',
  BigInteger: 'java.math.BigInteger',
  Collections: 'java.util.Collections',
  Comparator: 'java.util.Comparator',
  Deque: 'java.util.Deque',
  HashMap: 'java.util.HashMap',
  HashSet: 'java.util.HashSet',
  InputStream: 'java.io.InputStream',
  Iterator: 'java.util.Iterator',
  LinkedHashMap: 'java.util.LinkedHashMap',
  LinkedHashSet: 'java.util.LinkedHashSet',
  LinkedList: 'java.util.LinkedList',
  List: 'java.util.List',
  Map: 'java.util.Map',
  PrintStream: 'java.io.PrintStream',
  PriorityQueue: 'java.util.PriorityQueue',
  Queue: 'java.util.Queue',
  Set: 'java.util.Set',
  Stack: 'java.util.Stack',
  TreeMap: 'java.util.TreeMap',
  TreeSet: 'java.util.TreeSet',
}

/** Inheritance groups used by the lightweight receiver resolver. */
export const TYPE_GROUPS: Record<string, string[]> = {
  Collection: ['Collection', 'Iterable'], Iterable: ['Iterable'],
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

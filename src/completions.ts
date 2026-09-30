import { snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'

import {
  JAVA_TYPE_IMPORTS,
  importLines,
} from './completions/imports'
import {
  JAVA_TYPES,
  TYPE_GROUPS,
  type JavaMethod,
  type JavaSymbol,
} from './completions/model'
import {
  analyzeJavaSource,
} from './completions/source'
import { resolveJavaReceiverTypes } from './completions/type-resolution'
import {
  JAVA_COMPLETIONS,
  CATALOG,
  STATIC_CATALOG,
  STATIC_FIELDS,
  OBJECT_METHODS,
  ARRAY_METHODS,
  PRIMITIVE_BASES,
  ASSERTJ_METHODS,
  methodCompletion,
  type MethodSpec,
  type StaticFieldSpec,
} from './completions/catalog'
import type { JavaTypeMembersMetadata } from './backend'
import {
  javaIterCompletions,
  isJavaIterVariableNameField,
} from './completions/templates'
import {
  psLibraryAvailable,
  readPsLibraryMetadata,
  type PsLibraryMetadata,
  type PsMethod,
} from './completions/library'

export type {
  JavaDefinition,
  JavaIdentifier,
  JavaMethod,
  JavaSymbol,
  ImportLine,
  JavaIterableCandidate,
  JavaPrintTemplateKind,
} from './completions/model'
export type { PsLibraryMetadata, PsMethod, PsMethodParameter } from './completions/library'
export {
  psLibraryAvailable,
  psLibraryExtension,
  readPsLibraryMetadata,
  setPsLibraryMetadata,
} from './completions/library'
export {
  addJavaTypeImports,
  JAVA_TYPE_IMPORTS,
  importLines,
} from './completions/imports'
export {
  collectJavaMethods,
  collectJavaSymbols,
  javaIterableCandidates,
  javaIdentifierAt,
  maskJavaCommentsAndLiterals,
  resolveJavaDefinition,
} from './completions/source'
export {
  expandJavaPrintTemplate,
  expandJavaTestTemplate,
  finishJavaTemplate,
  finishJavaIterTemplate,
  javaTestCompletion,
  javaIterTemplateExtension,
  isJavaIterVariableNameField,
} from './completions/templates'

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
  unavailable?: boolean
}

function psMethodCompletion(method: PsMethod, type: Completion['type'] = 'method'): Completion {
  const usedNames = new Set<string>()
  const parameters = method.parameters.map((parameter, index) => {
    const declaredName = parameter.name?.trim()
    const baseName = declaredName && /^[A-Za-z_$][\w$]*$/.test(declaredName)
      ? declaredName
      : psParameterName(parameter.typeName, index)
    let name = baseName
    let suffix = 2
    while (usedNames.has(name)) name = `${baseName}${suffix++}`
    usedNames.add(name)
    return { name, typeName: parameter.typeName }
  })
  const label = `${method.name}(${parameters.map(({ name, typeName }) => `${typeName} ${name}`).join(', ')})`
  const body = `${method.name}(${parameters.map(({ name }) => `\${${name}}`).join(', ')})`
  return {
    label,
    type,
    detail: method.returnType,
    apply: parameters.length ? snippet(body) : `${method.name}()`,
  }
}

function psParameterName(typeName: string, index: number): string {
  const baseType = typeName.trim().replace(/<.*$/, '').replace(/\.\.\.$/, '[]')
  const simpleType = baseType.slice(baseType.lastIndexOf('.') + 1)
  if (/\[\]$/.test(baseType)) return 'array'
  if (/^(?:boolean|Boolean)$/.test(simpleType)) return 'condition'
  if (/^(?:char|Character)$/.test(simpleType)) return 'character'
  if (/^(?:byte|short|int|long|float|double|Byte|Short|Integer|Long|Float|Double|Number|BigInteger|BigDecimal)$/.test(simpleType)) return 'number'
  if (/^(?:String|CharSequence)$/.test(simpleType)) return 'value'
  if (/^(?:Iterable|Collection|List|Set|Queue|Deque|Iterator|Stream)$/.test(simpleType)) return 'items'
  if (/^(?:Map|SortedMap|NavigableMap)$/.test(simpleType)) return 'map'
  if (/(?:Function|Predicate|Consumer|Operator|Supplier|Comparator)$/.test(simpleType)) return 'function'
  if (/^[A-Z]$/.test(simpleType)) return ({ E: 'element', K: 'key', R: 'result' } as Record<string, string>)[simpleType] ?? 'value'
  return `arg${index + 1}`
}

function findDotContext(source: string, position: number): DotContext | null {
  const before = source.slice(0, position)
  // Keep the complete receiver so chains such as `System.out.` can be
  // resolved.  The resolver remains conservative for arbitrary dotted
  // expressions, but recognizing the chain here preserves the typed prefix
  // range (`System.out.pr|` -> `pr`).
  const dotWord = /(?:^|[^\w$])((?:(?:this\.)?[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(before)
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

function staticFieldOptions(fields: StaticFieldSpec[]): Completion[] {
  return fields.map((field) => ({
    label: field.name,
    type: 'field' as const,
    detail: field.type,
    apply: field.name,
  }))
}

function methodOptions(resolution: ReceiverResolution, assertJ = false, psLibrary: PsLibraryMetadata | null = null): Completion[] {
  if (resolution.unavailable) return []
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
    const allFields = resolution.bases.flatMap((base) => STATIC_FIELDS[base] ?? [])
    return uniqueOptions([
      ...staticFieldOptions(allFields),
      ...resolution.bases.flatMap((base) => base === 'Ps'
        ? (psLibrary?.methods ?? []).map((method) => psMethodCompletion(method))
        : completionOptions(uniqueMethodSpecs(STATIC_CATALOG[base] ?? []))),
    ])
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

function importedPsStaticCompletions(source: string, psLibrary: PsLibraryMetadata | null): Completion[] {
  const methods = psLibrary?.methods ?? []
  if (methods.length === 0) return []
  const importPrefix = `${JAVA_TYPE_IMPORTS.Ps}.`
  const importedNames = new Set<string>()
  for (const line of importLines(source)) {
    if (!line.static || !line.name.startsWith(importPrefix)) continue
    const member = line.name.slice(importPrefix.length)
    if (member === '*') {
      for (const method of methods) importedNames.add(method.name)
    } else if (methods.some((method) => method.name === member)) {
      importedNames.add(member)
    }
  }
  return methods
    .filter((method) => importedNames.has(method.name))
    .map((method) => psMethodCompletion(method, 'function'))
}

function receiverResolution(receiver: string, position: number, symbols: JavaSymbol[], psAvailable: boolean): ReceiverResolution {
  if (receiver === 'this') {
    return { bases: [], static: false, unknown: false, primitive: false, array: false, thisReceiver: true }
  }
  if (receiver === 'System.out' || receiver === 'System.err') {
    return { bases: ['PrintStream'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
  }
  if (receiver === 'System.in') {
    return { bases: ['InputStream'], static: false, unknown: false, primitive: false, array: false, thisReceiver: false }
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
  const unavailable = staticBase === 'Ps' && !psAvailable
  const knownType = JAVA_TYPES.includes(staticBase) && !unavailable
  if (knownType) {
    return { bases: [staticBase], static: true, unknown: false, primitive: false, array: false, thisReceiver: false, unavailable: false }
  }
  if (unavailable) {
    return { bases: [], static: false, unknown: false, primitive: false, array: false, thisReceiver: false, unavailable: true }
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

function javaMemberCompletions(metadata: JavaTypeMembersMetadata, typeNames: string[], isStatic: boolean): Completion[] {
  const requested = new Set(typeNames)
  const types = metadata.types.filter((type) => type.available && requested.has(type.typeName))
  const methods = types.flatMap((type) => type.methods.filter((method) => method.isStatic === isStatic))
  const methodLabels = new Map<string, number>()
  for (const method of methods) {
    const names = method.parameters.map((parameter, index) => parameter.name?.trim()
      && /^[A-Za-z_$][\w$]*$/.test(parameter.name)
      ? parameter.name
      : psParameterName(parameter.typeName, index))
    const label = `${method.name}(${names.join(', ')})`
    methodLabels.set(label, (methodLabels.get(label) ?? 0) + 1)
  }
  const completions: Completion[] = methods.map((method) => {
    const usedNames = new Set<string>()
    const parameters = method.parameters.map((parameter, index) => {
      const declaredName = parameter.name?.trim()
      const baseName = declaredName && /^[A-Za-z_$][\w$]*$/.test(declaredName)
        ? declaredName
        : psParameterName(parameter.typeName, index)
      let name = baseName
      let suffix = 2
      while (usedNames.has(name)) name = `${baseName}${suffix++}`
      usedNames.add(name)
      return { name, typeName: parameter.typeName }
    })
    const argumentNames = parameters.map(({ name }) => name)
    const simpleLabel = `${method.name}(${argumentNames.join(', ')})`
    const label = (methodLabels.get(simpleLabel) ?? 0) > 1
      ? `${method.name}(${parameters.map(({ name, typeName }) => `${typeName} ${name}`).join(', ')})`
      : simpleLabel
    const body = `${method.name}(${argumentNames.map((name) => `\${${name}}`).join(', ')})`
    return {
      label,
      type: 'method',
      detail: method.returnType || undefined,
      apply: parameters.length ? snippet(body) : `${method.name}()`,
    }
  })
  completions.push(...types.flatMap((type) => type.fields
    .filter((field) => field.isStatic === isStatic)
    .map((field) => ({ label: field.name, type: 'field' as const, detail: field.typeName, apply: field.name }))))
  return uniqueOptions(completions)
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

function javaCompletionValidFor(
  text: string,
  _from: number,
  _to: number,
  state: CompletionContext['state'],
): boolean {
  return /^[\w$]*$/.test(text) && !isJavaIterVariableNameField(state)
}

export function javaCompletions(context: CompletionContext): CompletionResult | null {
  const source = context.state.doc.toString()
  const position = context.pos
  if (isJavaIterVariableNameField(context.state, position)) return null
  const dot = findDotContext(source, position)
  const analysis = analyzeJavaSource(source, position)
  const { symbols, methods } = analysis
  const psLibrary = readPsLibraryMetadata(context.state)
  const hasPsLibrary = psLibraryAvailable(context.state)
  if (dot) {
    if (dot.receiver === 'this') {
      return {
        from: dot.from,
        options: thisMemberCompletions(symbols, methods),
        validFor: javaCompletionValidFor,
      }
    }
    const resolution = receiverResolution(dot.receiver, position, symbols, hasPsLibrary)
    return {
      from: dot.from,
      options: methodOptions(resolution, dot.assertJ, psLibrary),
      validFor: javaCompletionValidFor,
    }
  }
  const word = context.matchBefore(/[\w$]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return {
    from: word.from,
    options: uniqueOptions([
      ...symbolCompletions(symbols),
      ...methodCompletions(methods),
      ...javaIterCompletions(source, position, analysis),
      ...importedPsStaticCompletions(analysis.maskedSource, psLibrary),
      ...JAVA_COMPLETIONS.filter((completion) => completion.label !== 'Ps' || hasPsLibrary),
    ]),
    validFor: javaCompletionValidFor,
  }
}

/** Create a completion source that reads Java members from project/JDK metadata. */
export function createJavaMemberCompletionSource(
  inspect: (typeNames: string[]) => Promise<JavaTypeMembersMetadata>,
): CompletionSource {
  return async (context) => {
    const source = context.state.doc.toString()
    const position = context.pos
    if (isJavaIterVariableNameField(context.state, position)) return null
    const dot = findDotContext(source, position)
    if (!dot) return javaCompletions(context)

    const analysis = analyzeJavaSource(source, position)
    const resolution = resolveJavaReceiverTypes(source, dot.receiver, position, analysis.symbols, dot.assertJ)
    if (resolution.kind === 'legacy') return javaCompletions(context)

    const result: CompletionResult = {
      from: dot.from,
      options: [],
      validFor: javaCompletionValidFor,
    }
    if (resolution.kind === 'unresolved') return result

    try {
      const metadata = await inspect(resolution.typeNames)
      return {
        ...result,
        options: javaMemberCompletions(metadata, resolution.typeNames, resolution.isStatic),
      }
    } catch {
      return result
    }
  }
}

export { JAVA_COMPLETIONS }

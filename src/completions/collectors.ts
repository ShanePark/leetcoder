import { snippet, type Completion } from '@codemirror/autocomplete'
import type { JavaMethodMember, JavaTypeMembersMetadata } from '../backend'
import { addJavaTypeImports, importLines, JAVA_TYPE_IMPORTS } from './imports'
import { collectJavaSymbols, maskJavaCommentsAndLiterals } from './source'

export function collectParameterName(method: JavaMethodMember, index: number): string | undefined {
  if (method.name !== 'collect') return undefined
  const type = method.parameters[index]?.typeName.replace(/<.*>/s, '')
  if (type === 'java.util.stream.Collector') return 'collector'
  if (method.parameters.length === 3 && method.parameters[0].typeName.startsWith('java.util.function.Supplier')
    && /^java\.util\.function\.(?:BiConsumer|ObjIntConsumer|ObjLongConsumer|ObjDoubleConsumer)(?:<|$)/.test(method.parameters[1].typeName)
    && /^java\.util\.function\.BiConsumer(?:<|$)/.test(method.parameters[2].typeName)) {
    return ['supplier', 'accumulator', 'combiner'][index]
  }
  return undefined
}

export function isCollectorPrefix(prefix: string): boolean {
  return Boolean(prefix) && 'collect'.startsWith(prefix)
}

function typeReference(source: string, name: string, position: number): string {
  const fullyQualifiedName = JAVA_TYPE_IMPORTS[name]
  const conflictingImport = importLines(source).some((line) => !line.static && !line.name.endsWith('.*')
    && line.name.split('.').at(-1) === name && line.name !== fullyQualifiedName)
  const localType = new RegExp(`\\b(?:class|interface|enum|record)\\s+${name}\\b`).test(maskJavaCommentsAndLiterals(source))
  const localValue = collectJavaSymbols(source, position).some((symbol) => symbol.name === name
    && symbol.scopeStart <= position && position <= symbol.scopeEnd)
  return conflictingImport || localType || localValue ? fullyQualifiedName : name
}

function applyCollector(factory: string, collection: string | undefined): Completion['apply'] {
  return (view, completion, from, to) => {
    const source = view.state.doc.toString()
    const collector = typeReference(source, 'Collectors', from)
    const target = collection ? typeReference(source, collection, from) : undefined
    const typeNames = [collector === 'Collectors' ? 'Collectors' : '', target === collection ? collection ?? '' : ''].filter(Boolean)
    const imported = addJavaTypeImports(source, typeNames)
    if (imported !== source) {
      let start = 0
      while (start < source.length && source[start] === imported[start]) start += 1
      let sourceEnd = source.length
      let importedEnd = imported.length
      while (sourceEnd > start && importedEnd > start && source[sourceEnd - 1] === imported[importedEnd - 1]) {
        sourceEnd -= 1
        importedEnd -= 1
      }
      const transaction = view.state.update({
        changes: { from: start, to: sourceEnd, insert: imported.slice(start, importedEnd) },
        userEvent: 'input.complete',
      })
      from = transaction.changes.mapPos(from)
      to = transaction.changes.mapPos(to)
      view.dispatch(transaction)
    }
    const argument = target ? `\${1:${target}::new}` : ''
    snippet(`collect(${collector}.${factory}(${argument}))\${}`)(view, completion, from, to)
  }
}

/** Offer collector recipes only for the inspected object Stream collector overload. */
export async function javaCollectorCompletions(
  source: string,
  receiver: string,
  from: number,
  position: number,
  metadata: JavaTypeMembersMetadata,
  typeNames: string[],
  isStatic: boolean,
  inspect: (typeNames: string[]) => Promise<JavaTypeMembersMetadata>,
): Promise<Completion[]> {
  const prefix = source.slice(from, position)
  if (isStatic || !isCollectorPrefix(prefix)) return []
  const stream = metadata.types.find((type) => type.available && type.typeName === 'java.util.stream.Stream'
    && typeNames.includes(type.typeName))
  if (!stream?.methods.some((method) => method.name === 'collect' && !method.isStatic
    && method.parameters.length === 1 && method.parameters[0].typeName.replace(/<.*>/s, '') === 'java.util.stream.Collector')) return []

  const inspected = await inspect(['java.util.stream.Collectors']).catch(() => null)
  if (!inspected) return []
  const collectors = inspected.types.find((type) => type.available && type.typeName === 'java.util.stream.Collectors')
  if (!collectors) return []
  const before = maskJavaCommentsAndLiterals(source.slice(0, source.lastIndexOf(receiver, from)))
  const expected = /\b(?:java\.util\.)?(List|Set)\s*(?:<[^;={}]*>)?\s+[A-Za-z_$][\w$]*\s*=\s*$/.exec(before)?.[1]
  const collection = expected === 'Set' ? 'HashSet' : 'ArrayList'
  return [
    ['toList', 'List'], ['toUnmodifiableList', 'List'], ['toCollection', expected ?? 'List'],
    ['toSet', 'Set'], ['toUnmodifiableSet', 'Set'],
  ].filter(([factory]) => collectors.methods.some((method) => method.isStatic && method.name === factory
    && method.parameters.length === (factory === 'toCollection' ? 1 : 0)))
    .map(([factory, result], index) => ({
      label: `collect(Collectors.${factory}(${factory === 'toCollection' ? `${collection}::new` : ''}))`,
      type: 'method',
      detail: result,
      boost: (result === (expected ?? 'List') ? 20 : 10) - index - (factory === 'toCollection' ? 5 : 0),
      apply: applyCollector(factory, factory === 'toCollection' ? collection : undefined),
    }))
}

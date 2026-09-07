import {
  pickedCompletion,
  type Completion,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

import { JAVA_TYPE_IMPORTS, type ImportLine } from './model'
import { maskJavaCommentsAndLiterals } from './source'

export { JAVA_TYPE_IMPORTS }
export type { ImportLine }

export function importLines(source: string): ImportLine[] {
  const lines: ImportLine[] = []
  const pattern = /^[\t ]*import[\t ]+(static[\t ]+)?([\w.*]+)[\t ]*;[^\S\r\n]*(?:\r?\n|$)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    lines.push({
      name: match[2],
      static: Boolean(match[1]),
      from: match.index,
      to: match.index + match[0].length,
    })
  }
  return lines
}

function localTypeDeclared(source: string, typeName: string): boolean {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(?:class|interface|enum|record)\\s+${escaped}\\b`).test(maskJavaCommentsAndLiterals(source))
}

function importInsertion(source: string, fullyQualifiedName: string): { from: number, insert: string } | null {
  const packageName = fullyQualifiedName.slice(0, fullyQualifiedName.lastIndexOf('.'))
  const typeName = fullyQualifiedName.slice(fullyQualifiedName.lastIndexOf('.') + 1)
  const imports = importLines(source)
  if (imports.some((line) => !line.static && (line.name === fullyQualifiedName || line.name === `${packageName}.*`))) {
    return null
  }
  if (imports.some((line) => !line.static && !line.name.endsWith('.*') && line.name.split('.').at(-1) === typeName)) {
    return null
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const ordinaryImports = imports.filter((line) => !line.static)
  const followingImport = ordinaryImports.find((line) => line.name.localeCompare(fullyQualifiedName) > 0)
  if (followingImport) {
    return { from: followingImport.from, insert: `import ${fullyQualifiedName};${newline}` }
  }
  if (ordinaryImports.length > 0) {
    const lastImport = ordinaryImports.at(-1)!
    const prefix = lastImport.to === source.length || !source.slice(lastImport.from, lastImport.to).endsWith('\n') ? newline : ''
    return { from: lastImport.to, insert: `${prefix}import ${fullyQualifiedName};${newline}` }
  }

  const firstStaticImport = imports.find((line) => line.static)
  if (firstStaticImport) {
    return { from: firstStaticImport.from, insert: `import ${fullyQualifiedName};${newline}${newline}` }
  }

  const packageMatch = /^[\t ]*package[\t ]+[\w.]+[\t ]*;[^\S\r\n]*(?:\r?\n|$)/m.exec(source)
  if (packageMatch) {
    const afterPackage = packageMatch.index + packageMatch[0].length
    let firstCode = afterPackage
    while (firstCode < source.length && /\s/.test(source[firstCode])) firstCode += 1
    const separator = source.slice(afterPackage, firstCode).includes('\n') ? '' : newline
    return { from: firstCode, insert: `${separator}import ${fullyQualifiedName};${newline}${newline}` }
  }
  return { from: 0, insert: `import ${fullyQualifiedName};${newline}${newline}` }
}

export function addJavaTypeImports(source: string, typeNames: Iterable<string>): string {
  const imports = [...new Set(typeNames)]
    .map((typeName) => ({ typeName, fullyQualifiedName: JAVA_TYPE_IMPORTS[typeName] }))
    .filter((candidate): candidate is { typeName: string; fullyQualifiedName: string } => Boolean(candidate.fullyQualifiedName))
    .sort((left, right) => left.fullyQualifiedName.localeCompare(right.fullyQualifiedName))

  let updated = source
  for (const { typeName, fullyQualifiedName } of imports) {
    if (localTypeDeclared(updated, typeName)) continue
    const insertion = importInsertion(updated, fullyQualifiedName)
    if (!insertion) continue
    updated = `${updated.slice(0, insertion.from)}${insertion.insert}${updated.slice(insertion.from)}`
  }
  return updated
}

export function applyJavaType(fullyQualifiedName: string): Completion['apply'] {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const source = view.state.doc.toString()
    const typeName = fullyQualifiedName.slice(fullyQualifiedName.lastIndexOf('.') + 1)
    const maskedSelection = maskJavaCommentsAndLiterals(source).slice(from, to)
    const selectionIsCode = maskedSelection === source.slice(from, to)
    const insertion = selectionIsCode && !localTypeDeclared(source, typeName)
      ? importInsertion(source, fullyQualifiedName)
      : null
    const changes = insertion
      ? [{ from: insertion.from, insert: insertion.insert }, { from, to, insert: completion.label }]
      : [{ from, to, insert: completion.label }]
    const importOffset = insertion && insertion.from <= from ? insertion.insert.length : 0
    view.dispatch({
      changes,
      selection: { anchor: from + completion.label.length + importOffset },
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
      userEvent: 'input.complete',
    })
  }
}

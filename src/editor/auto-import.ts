import { completionStatus } from '@codemirror/autocomplete'
import { codeFolding, foldService, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { addJavaTypeImports, JAVA_TYPE_IMPORTS, javaIdentifierAt } from '../completions'
import { psLibraryAvailable } from '../completions/library'
import { importBlockRange, removeUnusedJavaTypeImports } from '../java-format'
import { minimalDocumentChange } from './editing'

function previousNonWhitespace(source: string, position: number): string {
  let cursor = position - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  return cursor >= 0 ? source[cursor] : ''
}

function nextNonWhitespace(source: string, position: number): string {
  let cursor = position
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor < source.length ? source[cursor] : ''
}

function referencedJavaImportTypes(state: EditorState): Set<string> {
  const source = state.doc.toString()
  const definitions = new Set<string>()
  const tree = syntaxTree(state)
  tree.iterate({
    enter(node) {
      if (node.name === 'Definition') definitions.add(source.slice(node.from, node.to))
    },
  })

  const typeNames = new Set<string>()
  tree.iterate({
    enter(node) {
      const name = source.slice(node.from, node.to)
      if (!JAVA_TYPE_IMPORTS[name]) return
      if (name === 'Ps' && !psLibraryAvailable(state)) return

      if (node.name === 'TypeName') {
        // The final component of a fully qualified type is also a TypeName.
        // Only an unqualified first component should request an import.
        if (previousNonWhitespace(source, node.from) !== '.') typeNames.add(name)
        return
      }

      // Static factories and utilities such as List.of() and Arrays.sort()
      // are parsed as Identifier receivers rather than TypeName nodes.
      if (node.name === 'Identifier'
        && !definitions.has(name)
        && previousNonWhitespace(source, node.from) !== '.'
        && nextNonWhitespace(source, node.to) === '.') {
        typeNames.add(name)
      }
    },
  })
  return typeNames
}

export const javaAutoImports = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !transaction.isUserEvent('input')) return transaction

  const source = transaction.newDoc.toString()
  const updated = addJavaTypeImports(source, referencedJavaImportTypes(transaction.state))
  if (updated === source) return transaction

  return [
    transaction,
    { changes: minimalDocumentChange(source, updated), sequential: true },
  ]
})

/**
 * Imports this editor added stop being useful once their last reference is
 * gone. Pruning waits for a short pause instead of running on every keystroke
 * so an import does not vanish and come back while its type name is retyped,
 * and it leaves the type currently under the cursor alone for the same reason.
 */
const IMPORT_PRUNE_DELAY_MS = 700

export const javaImportPruning = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!update.docChanged) {
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.prune()
    }, IMPORT_PRUNE_DELAY_MS)
  }

  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
  }

  private prune(): void {
    const state = this.view.state
    if (completionStatus(state) === 'active') {
      return
    }
    const source = state.doc.toString()
    const typing = javaIdentifierAt(source, state.selection.main.head)?.name ?? null
    const updated = removeUnusedJavaTypeImports(source, typing)
    if (updated === source) {
      return
    }
    this.view.dispatch({
      changes: minimalDocumentChange(source, updated),
      userEvent: 'delete.import',
    })
  }
})

/**
 * Fold the leading `import` block as one unit. Only its first line reports a
 * range, which is the shape CodeMirror's fold gutter and `foldable` expect.
 */
export const javaImportFolding = foldService.of((state, lineStart) => {
  const block = importBlockRange(state.doc.toString())
  if (!block || block.count < 2 || block.from !== lineStart || block.to <= block.from) {
    return null
  }
  return { from: block.from, to: block.to }
})

export const javaFolding = codeFolding({
  preparePlaceholder: (state, range) => (
    state.doc.sliceString(range.from, range.from + 6) === 'import' ? 'import \u2026' : '\u2026'
  ),
  placeholderDOM: (_view, onclick, prepared) => {
    const element = document.createElement('span')
    element.className = 'cm-foldPlaceholder'
    element.textContent = typeof prepared === 'string' ? prepared : '\u2026'
    element.title = 'Expand'
    element.setAttribute('aria-label', 'Expand folded lines')
    element.addEventListener('click', onclick)
    return element
  },
})

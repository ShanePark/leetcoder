import {
  SearchQuery,
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view'

/** Counting stops here so a huge match set stays cheap to render. */
const MAX_COUNTED_MATCHES = 999

interface FindMatch {
  from: number
  to: number
}

/** The find bar searches plain text, ignoring case. */
function findQuery(text: string): SearchQuery {
  return new SearchQuery({ search: text, literal: true })
}

/** Selected text to search for, or null when the selection is empty or spans lines. */
export function selectionFindText(state: EditorState): string | null {
  const { from, to, empty } = state.selection.main
  if (empty || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
    return null
  }
  return state.sliceDoc(from, to)
}

function firstMatch(state: EditorState, query: SearchQuery, from = 0, to?: number): FindMatch | null {
  const next = query.getCursor(state, from, to).next()
  return next.done ? null : next.value
}

function lastMatch(state: EditorState, query: SearchQuery, to?: number): FindMatch | null {
  let last: FindMatch | null = null
  const cursor = query.getCursor(state, 0, to)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    last = next.value
  }
  return last
}

/** The first match at or after `position`, wrapping to the start of the document. */
function matchFrom(state: EditorState, query: SearchQuery, position: number): FindMatch | null {
  return firstMatch(state, query, position) ?? firstMatch(state, query)
}

function selectMatch(view: EditorView, match: FindMatch): void {
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: 'nearest' }),
    userEvent: 'select.search',
  })
}

/** Select the next match after the selection, wrapping to the first. */
export function findNextMatch(view: EditorView): boolean {
  const query = getSearchQuery(view.state)
  if (!query.valid) return false
  const match = matchFrom(view.state, query, view.state.selection.main.to)
  if (match) selectMatch(view, match)
  return match !== null
}

/** Select the match before the selection, wrapping to the last. */
export function findPreviousMatch(view: EditorView): boolean {
  const query = getSearchQuery(view.state)
  if (!query.valid) return false
  const match = lastMatch(view.state, query, view.state.selection.main.from) ?? lastMatch(view.state, query)
  if (match) selectMatch(view, match)
  return match !== null
}

/** `2/5` when the selection is a match, otherwise the number of matches. */
export function findCountLabel(state: EditorState): string {
  const query = getSearchQuery(state)
  if (!query.valid) return ''
  const matches: FindMatch[] = []
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done && matches.length <= MAX_COUNTED_MATCHES; next = cursor.next()) {
    matches.push(next.value)
  }
  if (matches.length === 0) return '0 results'
  const total = matches.length > MAX_COUNTED_MATCHES ? `${MAX_COUNTED_MATCHES}+` : String(matches.length)
  const { from, to } = state.selection.main
  const index = matches.findIndex((match) => match.from === from && match.to === to)
  if (index >= 0 && index < MAX_COUNTED_MATCHES) return `${index + 1}/${total}`
  return matches.length === 1 ? '1 result' : `${total} results`
}

/** Replace the query as the user types and select the nearest match, as IntelliJ does. */
function updateFindQuery(view: EditorView, text: string): void {
  const query = findQuery(text)
  const match = query.valid ? matchFrom(view.state, query, view.state.selection.main.from) : null
  view.dispatch({
    effects: [
      setSearchQuery.of(query),
      ...(match ? [EditorView.scrollIntoView(match.from, { y: 'nearest' })] : []),
    ],
    ...(match ? { selection: { anchor: match.from, head: match.to }, userEvent: 'select.search' } : {}),
  })
}

function closeFind(view: EditorView): void {
  closeSearchPanel(view)
  view.focus()
}

/** The open panel's input, so the find shortcut can refocus it. */
const findInputs = new WeakMap<EditorView, HTMLInputElement>()

function createFindPanel(view: EditorView): Panel {
  const doc = view.dom.ownerDocument
  const dom = doc.createElement('div')
  dom.className = 'cm-find-panel'

  const input = doc.createElement('input')
  input.className = 'cm-find-input'
  input.type = 'text'
  input.placeholder = 'Find'
  input.value = getSearchQuery(view.state).search
  input.setAttribute('aria-label', 'Find in file')
  input.setAttribute('spellcheck', 'false')
  input.setAttribute('autocomplete', 'off')

  const count = doc.createElement('span')
  count.className = 'cm-find-count'
  count.setAttribute('aria-live', 'polite')
  const renderCount = (state: EditorState) => {
    count.textContent = findCountLabel(state)
  }
  renderCount(view.state)

  const button = (label: string, glyph: string, run: () => void) => {
    const element = doc.createElement('button')
    element.className = 'cm-find-button'
    element.type = 'button'
    element.title = label
    element.setAttribute('aria-label', label)
    element.textContent = glyph
    // Keep focus in the input so Enter keeps stepping through matches.
    element.addEventListener('mousedown', (event) => event.preventDefault())
    element.addEventListener('click', run)
    return element
  }

  input.addEventListener('input', () => updateFindQuery(view, input.value))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPreviousMatch(view)
      else findNextMatch(view)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeFind(view)
    } else if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault()
    }
  })

  dom.append(
    input,
    count,
    button('Previous match', '↑', () => findPreviousMatch(view)),
    button('Next match', '↓', () => findNextMatch(view)),
    button('Close', '×', () => closeFind(view)),
  )
  findInputs.set(view, input)

  return {
    dom,
    top: true,
    update(update: ViewUpdate) {
      const query = getSearchQuery(update.state)
      const queryChanged = query !== getSearchQuery(update.startState)
      if (queryChanged && input.value !== query.search) {
        input.value = query.search
      }
      if (queryChanged || update.docChanged || update.selectionSet) {
        renderCount(update.state)
      }
    },
    destroy() {
      findInputs.delete(view)
    },
  }
}

/**
 * Open the find bar, or refocus it when already open. A single-line selection
 * becomes the query; otherwise the last query is kept.
 */
export function openFind(view: EditorView): boolean {
  const openInput = findInputs.get(view)
  const inputFocused = openInput !== undefined && view.root.activeElement === openInput
  const text = (inputFocused ? null : selectionFindText(view.state)) ?? getSearchQuery(view.state).search
  const query = findQuery(text)
  if (!searchPanelOpen(view.state)) {
    openSearchPanel(view)
  }
  // Opening prefills from any short selection, including multi-line ones, so
  // settle the query this bar wants afterwards.
  if (!getSearchQuery(view.state).eq(query)) {
    view.dispatch({ effects: setSearchQuery.of(query) })
  }
  const input = findInputs.get(view)
  input?.focus()
  input?.select()
  return true
}

/** Search state, match highlighting, and the find bar panel. */
export const findInFile = search({ top: true, literal: true, createPanel: createFindPanel })

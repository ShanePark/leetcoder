import { getSearchQuery, searchPanelOpen } from '@codemirror/search'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { showPanel, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { findInFile, openFind, selectionFindText } from '../../../src/editor/find'

type Listener = (event: FakeEvent) => void

interface FakeEvent {
  key?: string
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  defaultPrevented?: boolean
  preventDefault: () => void
}

/** Just enough DOM for the find panel: elements, listeners, focus and selection. */
class FakeElement {
  className = ''
  type = ''
  title = ''
  placeholder = ''
  value = ''
  textContent = ''
  selection: [number, number] | null = null
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  fire(type: string, init: Omit<FakeEvent, 'preventDefault'> = {}): FakeEvent {
    const event: FakeEvent = {
      ...init,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true },
    }
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  select(): void {
    this.selection = [0, this.value.length]
  }

  find(className: string): FakeElement {
    const found = this.children.find((child) => child.className === className)
    if (!found) throw new Error(`Missing .${className}`)
    return found
  }

  button(label: string): FakeElement {
    const found = this.children.find((child) => child.tagName === 'button' && child.title === label)
    if (!found) throw new Error(`Missing ${label} button`)
    return found
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null
  readonly editorContent = new FakeElement('div', this)

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }
}

/**
 * A state-only view that mounts, updates, and destroys the search panel the
 * way CodeMirror's panel plugin does, without browser layout.
 */
function findView(doc: string, anchor = 0, head = anchor) {
  const document = new FakeDocument()
  let panel: Panel | null = null
  const view = {
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: [findInFile] }),
    root: document,
    dom: { ownerDocument: document },
    plugin: () => null,
    focus: () => { document.activeElement = document.editorContent },
    dispatch: (spec: TransactionSpec) => {
      const startState = view.state
      const transaction = startState.update(spec)
      view.state = transaction.state
      const open = searchPanelOpen(view.state)
      if (open && !panel) {
        const create = view.state.facet(showPanel).find((constructor) => constructor !== null)
        panel = create!(view as unknown as EditorView)
      } else if (!open && panel) {
        panel.destroy?.()
        panel = null
      } else {
        panel?.update?.({
          state: view.state,
          startState,
          docChanged: transaction.docChanged,
          selectionSet: transaction.selection !== undefined,
        } as ViewUpdate)
      }
    },
  }
  const editorView = view as unknown as EditorView
  const dom = () => {
    if (!panel) throw new Error('The find panel is closed')
    return panel.dom as unknown as FakeElement
  }
  return {
    view: editorView,
    document,
    state: () => view.state,
    isOpen: () => panel !== null,
    input: () => dom().find('cm-find-input'),
    count: () => dom().find('cm-find-count').textContent,
    button: (label: string) => dom().button(label),
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    selection: () => [view.state.selection.main.from, view.state.selection.main.to],
  }
}

function type(harness: ReturnType<typeof findView>, text: string): void {
  harness.input().value = text
  harness.input().fire('input')
}

const source = 'int count = 0;\nCount += 1;\nreturn count;\n'

describe('find bar', () => {
  it('opens from the command with a focused, selected input', () => {
    const harness = findView(source)
    expect(openFind(harness.view)).toBe(true)
    expect(searchPanelOpen(harness.state())).toBe(true)
    expect(harness.document.activeElement).toBe(harness.input())
    expect(harness.input().selection).toEqual([0, 0])
    expect(harness.count()).toBe('')
  })

  it('prefills a single-line selection but keeps the last query for a multi-line one', () => {
    const start = source.indexOf('count')
    const harness = findView(source, start, start + 'count'.length)
    openFind(harness.view)
    expect(harness.input().value).toBe('count')
    expect(harness.input().selection).toEqual([0, 5])
    expect(getSearchQuery(harness.state()).search).toBe('count')
    expect(harness.count()).toBe('1/3')

    harness.input().fire('keydown', { key: 'Escape' })
    harness.view.dispatch({ selection: { anchor: 0, head: source.indexOf('return') } })
    openFind(harness.view)
    expect(harness.input().value).toBe('count')
    expect(selectionFindText(harness.state())).toBeNull()
  })

  it('updates the query live, case-insensitively, and selects the first match at or after the cursor', () => {
    const harness = findView(source, source.indexOf('+='))
    openFind(harness.view)
    type(harness, 'COUNT')
    expect(getSearchQuery(harness.state()).search).toBe('COUNT')
    expect(harness.selection()).toEqual([source.lastIndexOf('count'), source.lastIndexOf('count') + 5])
    expect(harness.count()).toBe('3/3')

    type(harness, 'COUNT;')
    expect(harness.selected()).toBe('count;')
    expect(harness.count()).toBe('1/1')

    type(harness, '')
    expect(harness.count()).toBe('')
  })

  it('wraps through matches with Enter, Shift+Enter, and the buttons', () => {
    const harness = findView(source)
    openFind(harness.view)
    type(harness, 'count')
    expect(harness.count()).toBe('1/3')

    const enter = harness.input().fire('keydown', { key: 'Enter' })
    expect(enter.defaultPrevented).toBe(true)
    expect(harness.count()).toBe('2/3')
    expect(harness.selected()).toBe('Count')
    harness.input().fire('keydown', { key: 'Enter' })
    expect(harness.count()).toBe('3/3')
    harness.input().fire('keydown', { key: 'Enter' })
    expect(harness.count()).toBe('1/3')

    harness.input().fire('keydown', { key: 'Enter', shiftKey: true })
    expect(harness.count()).toBe('3/3')
    harness.button('Previous match').fire('click')
    expect(harness.count()).toBe('2/3')
    harness.button('Next match').fire('click')
    expect(harness.count()).toBe('3/3')
    expect(harness.document.activeElement).toBe(harness.input())
  })

  it('closes on Escape, returns focus to the editor, and keeps the match selected', () => {
    const harness = findView(source)
    openFind(harness.view)
    type(harness, 'return')
    const escape = harness.input().fire('keydown', { key: 'Escape' })
    expect(escape.defaultPrevented).toBe(true)
    expect(harness.isOpen()).toBe(false)
    expect(searchPanelOpen(harness.state())).toBe(false)
    expect(harness.document.activeElement).toBe(harness.document.editorContent)
    expect(harness.selected()).toBe('return')

    openFind(harness.view)
    expect(harness.input().value).toBe('return')
    harness.button('Close').fire('click')
    expect(harness.isOpen()).toBe(false)
    expect(harness.document.activeElement).toBe(harness.document.editorContent)
  })

  it('refocuses and reselects the open input, prefilling from a new editor selection', () => {
    const harness = findView(source)
    openFind(harness.view)
    type(harness, 'count')
    harness.input().selection = null
    openFind(harness.view)
    expect(harness.input().selection).toEqual([0, 5])
    expect(harness.input().value).toBe('count')

    harness.view.focus()
    const start = source.indexOf('return')
    harness.view.dispatch({ selection: { anchor: start, head: start + 'return'.length } })
    openFind(harness.view)
    expect(harness.isOpen()).toBe(true)
    expect(harness.input().value).toBe('return')
    expect(harness.document.activeElement).toBe(harness.input())
    expect(harness.input().selection).toEqual([0, 6])
    expect(harness.count()).toBe('1/1')
  })

  it('reports no matches and leaves the selection alone', () => {
    const harness = findView(source, 3)
    openFind(harness.view)
    type(harness, 'missing')
    expect(harness.count()).toBe('0 results')
    expect(harness.selection()).toEqual([3, 3])
    harness.input().fire('keydown', { key: 'Enter' })
    expect(harness.selection()).toEqual([3, 3])
  })

  it('counts matches when the selection is not on one and caps large counts', () => {
    const harness = findView(source)
    openFind(harness.view)
    type(harness, 'count')
    harness.view.dispatch({ selection: { anchor: 0 } })
    expect(harness.count()).toBe('3 results')

    const queried = findView('a'.repeat(1200))
    openFind(queried.view)
    type(queried, 'a')
    expect(queried.count()).toBe('1/999+')
    queried.view.dispatch({ selection: { anchor: 0 } })
    expect(queried.count()).toBe('999+ results')
  })

  it('gives the buttons labels without shortcut text', () => {
    const harness = findView(source)
    openFind(harness.view)
    expect(['Previous match', 'Next match', 'Close'].map((label) => harness.button(label).attributes.get('aria-label')))
      .toEqual(['Previous match', 'Next match', 'Close'])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FileTabsView,
  handleFileTabsWheel,
  renderFileHeading,
} from '../../../src/app/tabs-view'
import type { OpenFileTab } from '../../../src/app/types'

type FakeNode = FakeElement | FakeTextNode

class FakeTextNode {
  constructor(public textContent: string) {}
}

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]): void {
    const names = this.names()
    tokens.forEach((token) => names.add(token))
    this.write(names)
  }

  remove(...tokens: string[]): void {
    const names = this.names()
    tokens.forEach((token) => names.delete(token))
    this.write(names)
  }

  toggle(token: string, force?: boolean): boolean {
    const names = this.names()
    const present = force ?? !names.has(token)
    if (present) {
      names.add(token)
    } else {
      names.delete(token)
    }
    this.write(names)
    return present
  }

  contains(token: string): boolean {
    return this.names().has(token)
  }

  private names(): Set<string> {
    return new Set(this.owner.rawClassName.split(/\s+/).filter(Boolean))
  }

  private write(names: Set<string>): void {
    this.owner.rawClassName = [...names].join(' ')
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  readonly classList = new FakeClassList(this)
  rawClassName = ''
  parentElement: FakeElement | null = null
  disabled = false
  hidden = false
  tabIndex = 0
  title = ''
  type = ''
  scrollWidth = 0
  clientWidth = 0
  scrollLeft = 0
  focused = false
  readonly scrollCalls: ScrollIntoViewOptions[] = []
  private rawTextContent = ''

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.rawClassName
  }

  set className(value: string) {
    this.rawClassName = value
  }

  get textContent(): string {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join('')
      : this.rawTextContent
  }

  set textContent(value: string) {
    this.rawTextContent = value
    this.children.splice(0).forEach((child) => {
      child.parentElement = null
    })
  }

  set innerHTML(value: string) {
    if (value !== '') {
      throw new Error('The fake DOM only supports clearing innerHTML')
    }
    this.textContent = ''
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement = this
        this.children.push(node)
      } else {
        const text = new FakeElement('#text')
        text.rawTextContent = node.textContent
        text.parentElement = this
        this.children.push(text)
      }
    }
    this.rawTextContent = ''
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(type, listeners.filter((entry) => entry !== listener))
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  focus(): void {
    this.focused = true
  }

  scrollIntoView(options?: ScrollIntoViewOptions): void {
    this.scrollCalls.push(options ?? {})
  }

  remove(): void {
    if (!this.parentElement) {
      return
    }
    const parent = this.parentElement
    const index = parent.children.indexOf(this)
    if (index >= 0) {
      parent.children.splice(index, 1)
    }
    this.parentElement = null
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = []
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (child.matches(selector)) {
          matches.push(child)
        }
        visit(child)
      }
    }
    visit(this)
    return matches as T[]
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) {
      return this.classList.contains(selector.slice(1))
    }
    const role = selector.match(/^\[role="([^"]+)"\]$/)
    return role ? this.getAttribute('role') === role[1] : false
  }
}

const originalDocument = globalThis.document

function installFakeDocument(): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tagName: string) => new FakeElement(tagName),
      createTextNode: (value: string) => new FakeTextNode(value),
    },
  })
}

function restoreDocument(): void {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    })
  } else {
    delete (globalThis as { document?: Document }).document
  }
}

afterEach(() => {
  restoreDocument()
})

function tab(id: number, name: string): OpenFileTab {
  return {
    id,
    name,
    path: `src/main/java/easy/${name}`,
    packageSegment: 'easy',
  }
}

function tabsModel(overrides: Partial<{
  openTabs: readonly OpenFileTab[]
  activeTabId: number | null
  dirty: boolean
  hasPendingChanges: boolean
  busy: boolean
}> = {}) {
  return {
    openTabs: [tab(1, 'Q1TwoSum.java'), tab(2, 'Q2Add.java')],
    activeTabId: 1,
    dirty: false,
    hasPendingChanges: false,
    busy: false,
    ...overrides,
  }
}

describe('FileTabsView', () => {
  it('renders accessible tabs, reports tab actions, and marks the active tab dirty', () => {
    installFakeDocument()
    const list = new FakeElement('nav')
    const onOpenTab = vi.fn()
    const onCloseTab = vi.fn()
    const view = new FileTabsView(list as unknown as HTMLElement, { onOpenTab, onCloseTab })

    view.render(tabsModel({ dirty: true }))

    const items = list.querySelectorAll('.file-tab')
    const buttons = list.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(items).toHaveLength(2)
    expect(items[0].classList.contains('is-active')).toBe(true)
    expect(items[0].classList.contains('is-dirty')).toBe(true)
    expect(items[0].querySelector('.file-tab-dirty')).not.toBeNull()
    expect(buttons[0].getAttribute('aria-selected')).toBe('true')
    expect(buttons[0].tabIndex).toBe(0)
    expect(buttons[1].tabIndex).toBe(-1)
    expect(buttons[0].getAttribute('aria-label')).toBe('Q1TwoSum.java')
    expect(list.querySelector<HTMLButtonElement>('.file-tab-close')?.disabled).toBe(false)

    buttons[1].dispatch('click', {})
    expect(onOpenTab).toHaveBeenCalledWith(2)

    const stopPropagation = vi.fn()
    list.querySelector<HTMLButtonElement>('.file-tab-close')?.dispatch('click', { stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onCloseTab).toHaveBeenCalledWith(1)

    const preventDefault = vi.fn()
    buttons[0].dispatch('keydown', { key: 'ArrowRight', preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(buttons[1].focused).toBe(true)
  })

  it('updates active and dirty state in place and reveals the newly active tab', async () => {
    installFakeDocument()
    const list = new FakeElement('nav')
    const view = new FileTabsView(list as unknown as HTMLElement, {
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
    })
    view.render(tabsModel())
    await Promise.resolve()
    const itemsBefore = list.querySelectorAll('.file-tab')
    const secondBefore = itemsBefore[1]

    view.update(tabsModel({ activeTabId: 2, hasPendingChanges: true }))
    await Promise.resolve()

    const itemsAfter = list.querySelectorAll('.file-tab')
    expect(itemsAfter[1]).toBe(secondBefore)
    expect(itemsAfter[0].classList.contains('is-active')).toBe(false)
    expect(itemsAfter[1].classList.contains('is-active')).toBe(true)
    expect(itemsAfter[0].querySelector('.file-tab-dirty')).toBeNull()
    expect(itemsAfter[1].querySelector('.file-tab-dirty')).not.toBeNull()
    expect(itemsAfter[1].querySelector<HTMLButtonElement>('[role="tab"]')?.scrollCalls).toHaveLength(1)
  })

  it('moves the tab strip only for a shifted wheel when it overflows', () => {
    installFakeDocument()
    const list = new FakeElement('nav')
    list.scrollWidth = 240
    list.clientWidth = 100
    list.scrollLeft = 12
    const event = { deltaY: 30, shiftKey: true, preventDefault: vi.fn() }

    handleFileTabsWheel(list, event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(list.scrollLeft).toBe(42)

    const noShift = { deltaY: 30, shiftKey: false, preventDefault: vi.fn() }
    handleFileTabsWheel(list, noShift)
    expect(noShift.preventDefault).not.toHaveBeenCalled()
    expect(list.scrollLeft).toBe(42)
  })

  it('detaches wheel handling and cancels pending reveals on dispose', () => {
    installFakeDocument()
    const list = new FakeElement('nav')
    list.scrollWidth = 240
    list.clientWidth = 100
    const view = new FileTabsView(list as unknown as HTMLElement, {
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
    })
    view.render(tabsModel())
    view.dispose()

    const event = { deltaY: 30, shiftKey: true, preventDefault: vi.fn() }
    list.dispatch('wheel', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})

describe('renderFileHeading', () => {
  it('renders the selected filename, save state, and source snapshot', () => {
    installFakeDocument()
    const selectedFile = new FakeElement('span')
    const saveStatus = new FakeElement('span')
    const editorHost = new FakeElement('div')
    const elements = { selectedFile, saveStatus, editorHost }
    const files = [{
      path: 'src/main/java/easy/Q1TwoSum.java',
      name: 'Q1TwoSum.java',
      packageSegment: 'easy' as const,
    }]

    renderFileHeading(elements, {
      files,
      selectedPath: files[0].path,
      savedSource: 'class Q1TwoSum {}',
      saveError: null,
      saveWriteInFlight: false,
      dirty: true,
      hasPendingChanges: false,
      savedFlash: false,
      saveShortcutLabel: 'Alt+S',
    })

    expect(selectedFile.textContent).toBe('Q1TwoSum.java')
    expect(saveStatus.classList.contains('is-unsaved')).toBe(true)
    expect(saveStatus.querySelector('.save-dot')).not.toBeNull()
    expect(saveStatus.textContent).toContain('Unsaved')
    expect(saveStatus.title).toContain('Alt+S')
    expect(editorHost.dataset.savedSource).toBe('class Q1TwoSum {}')
  })

  it('keeps error and saving statuses ahead of the generic dirty state', () => {
    installFakeDocument()
    const elements = {
      selectedFile: new FakeElement('span'),
      saveStatus: new FakeElement('span'),
      editorHost: new FakeElement('div'),
    }
    const base = {
      files: [],
      selectedPath: 'Q1.java',
      savedSource: '',
      dirty: true,
      hasPendingChanges: true,
      savedFlash: false,
      saveShortcutLabel: 'Alt+S',
    }

    renderFileHeading(elements, { ...base, saveError: 'Permission denied', saveWriteInFlight: false })
    expect(elements.saveStatus.classList.contains('is-error')).toBe(true)
    expect(elements.saveStatus.textContent).toBe('Save failed')
    expect(elements.saveStatus.title).toBe('Permission denied')

    renderFileHeading(elements, { ...base, saveError: null, saveWriteInFlight: true })
    expect(elements.saveStatus.classList.contains('is-saving')).toBe(true)
    expect(elements.saveStatus.textContent).toBe('Saving…')
  })

  it('clears the heading when no file is selected while retaining the source snapshot', () => {
    installFakeDocument()
    const elements = {
      selectedFile: new FakeElement('span'),
      saveStatus: new FakeElement('span'),
      editorHost: new FakeElement('div'),
    }
    renderFileHeading(elements, {
      files: [],
      selectedPath: null,
      savedSource: 'empty',
      saveError: null,
      saveWriteInFlight: false,
      dirty: false,
      hasPendingChanges: false,
      savedFlash: true,
      saveShortcutLabel: 'Alt+S',
    })

    expect(elements.selectedFile.textContent).toBe('')
    expect(elements.saveStatus.textContent).toBe('')
    expect(elements.editorHost.dataset.savedSource).toBe('empty')
  })
})

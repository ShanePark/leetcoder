import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BOTTOM_PANEL_HEIGHT_KEY,
  DAILY_DESCRIPTION_HEIGHT_KEY,
  GIT_FILE_LIST_WIDTH_KEY,
  SIDEBAR_WIDTH_KEY,
  MIN_BOTTOM_PANEL_HEIGHT,
  MIN_DAILY_DESCRIPTION_HEIGHT,
  MIN_GIT_FILE_LIST_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from '../../../src/app/layout'
import { PaneLayoutController } from '../../../src/app/pane-layout'

type Listener = (event: Event) => void

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event)
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeElement extends FakeEventTarget {
  readonly style = {
    values: new Map<string, string>(),
    setProperty: (name: string, value: string): void => {
      this.style.values.set(name, value)
    },
  }
  readonly attributes = new Map<string, string>()
  readonly classList = {
    values: new Set<string>(),
    add: (name: string): void => {
      this.classList.values.add(name)
    },
    remove: (name: string): void => {
      this.classList.values.delete(name)
    },
    contains: (name: string): boolean => this.classList.values.has(name),
  }
  hidden = false
  clientWidth = 0
  clientHeight = 0
  pointerCaptureId: number | null = null

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  setPointerCapture(pointerId: number): void {
    this.pointerCaptureId = pointerId
  }
}

class FakeRoot extends FakeElement {
  private readonly elements = new Map<string, FakeElement>()

  register(selector: string, element = new FakeElement()): FakeElement {
    this.elements.set(selector, element)
    return element
  }

  querySelector<T extends Element>(selector: string): T | null {
    return (this.elements.get(selector) ?? null) as T | null
  }
}

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class FakeWindow extends FakeEventTarget {
  innerWidth = 1200
  innerHeight = 900
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function pointerEvent(values: Partial<{ button: number; clientX: number; clientY: number; pointerId: number }> = {}): PointerEvent {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    preventDefault: vi.fn(),
    ...values,
  } as unknown as PointerEvent
}

function keyboardEvent(key: string, shiftKey = false): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function createRoot(): {
  root: FakeRoot
  bottomPanel: FakeElement
  bottomHandle: FakeElement
  gitWorkspace: FakeElement
  gitSplitter: FakeElement
  workspace: FakeElement
  sidebarSplitter: FakeElement
  editorColumn: FakeElement
  description: FakeElement
  descriptionHandle: FakeElement
} {
  const root = new FakeRoot()
  const bottomPanel = root.register('#bottom-panel')
  const bottomHandle = root.register('#bottom-panel-resize-handle')
  const gitWorkspace = root.register('.git-workspace')
  const gitSplitter = root.register('#git-splitter')
  const workspace = root.register('.workspace')
  const sidebarSplitter = root.register('#sidebar-splitter')
  const editorColumn = root.register('.editor-column')
  const description = root.register('#daily-description')
  const descriptionHandle = root.register('#daily-description-resize-handle')
  gitWorkspace.clientWidth = 900
  workspace.clientWidth = 1000
  editorColumn.clientHeight = 800
  descriptionHandle.hidden = false
  return {
    root,
    bottomPanel,
    bottomHandle,
    gitWorkspace,
    gitSplitter,
    workspace,
    sidebarSplitter,
    editorColumn,
    description,
    descriptionHandle,
  }
}

let fakeWindow: FakeWindow

beforeEach(() => {
  fakeWindow = new FakeWindow()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  })
})

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('PaneLayoutController', () => {
  it('loads dimensions and applies CSS variables and separator ARIA values', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    storage.setItem(BOTTOM_PANEL_HEIGHT_KEY, '320')
    storage.setItem(GIT_FILE_LIST_WIDTH_KEY, '340')
    storage.setItem(SIDEBAR_WIDTH_KEY, '280')
    storage.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, '240')

    const controller = new PaneLayoutController(elements.root as unknown as HTMLElement, { storage: storage as unknown as Storage })
    controller.apply()

    expect(elements.bottomPanel.style.values.get('--bottom-panel-height')).toBe('320px')
    expect(elements.bottomHandle.attributes.get('aria-valuenow')).toBe('320')
    expect(elements.gitWorkspace.style.values.get('--git-file-list-width')).toBe('340px')
    expect(elements.gitSplitter.attributes.get('aria-valuenow')).toBe('340')
    expect(elements.workspace.style.values.get('--sidebar-width')).toBe('280px')
    expect(elements.sidebarSplitter.attributes.get('aria-valuenow')).toBe('280')
    expect(elements.description.style.values.get('--daily-description-height')).toBe('240px')
    expect(elements.descriptionHandle.attributes.get('aria-valuenow')).toBe('240')
  })

  it('reclamps dimensions to resized workspaces and persists changed values', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    storage.setItem(BOTTOM_PANEL_HEIGHT_KEY, '600')
    storage.setItem(GIT_FILE_LIST_WIDTH_KEY, '600')
    storage.setItem(SIDEBAR_WIDTH_KEY, '500')
    storage.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, '500')
    fakeWindow.innerHeight = 300
    elements.gitWorkspace.clientWidth = 500
    elements.workspace.clientWidth = 700
    elements.editorColumn.clientHeight = 450

    const controller = new PaneLayoutController(elements.root as unknown as HTMLElement, { storage: storage as unknown as Storage })
    controller.refresh()

    expect(storage.getItem(BOTTOM_PANEL_HEIGHT_KEY)).toBe('600')
    expect(elements.bottomHandle.attributes.get('aria-valuenow')).toBe('240')
    expect(storage.getItem(GIT_FILE_LIST_WIDTH_KEY)).toBe('217')
    expect(storage.getItem(SIDEBAR_WIDTH_KEY)).toBe('333')
    expect(storage.getItem(DAILY_DESCRIPTION_HEIGHT_KEY)).toBe('184')
    expect(elements.gitSplitter.attributes.get('aria-valuemax')).toBe('217')
    expect(elements.sidebarSplitter.attributes.get('aria-valuemax')).toBe('333')
    expect(elements.descriptionHandle.attributes.get('aria-valuemax')).toBe('184')
  })

  it('handles pointer and keyboard resizing, then removes every listener on destroy', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    const controller = new PaneLayoutController(elements.root as unknown as HTMLElement, { storage: storage as unknown as Storage })

    elements.bottomHandle.dispatch('pointerdown', pointerEvent({ clientY: 500 }))
    fakeWindow.dispatch('pointermove', pointerEvent({ clientY: 400 }))
    expect(elements.bottomPanel.style.values.get('--bottom-panel-height')).toBe('380px')
    expect(elements.root.classList.contains('is-resizing-panel')).toBe(true)
    fakeWindow.dispatch('pointerup')
    expect(storage.getItem(BOTTOM_PANEL_HEIGHT_KEY)).toBe('380')
    expect(elements.root.classList.contains('is-resizing-panel')).toBe(false)

    elements.gitSplitter.dispatch('keydown', keyboardEvent('Home'))
    expect(storage.getItem(GIT_FILE_LIST_WIDTH_KEY)).toBe(String(MIN_GIT_FILE_LIST_WIDTH))
    expect(elements.gitSplitter.attributes.get('aria-valuenow')).toBe(String(MIN_GIT_FILE_LIST_WIDTH))

    elements.sidebarSplitter.dispatch('pointerdown', pointerEvent({ clientX: 100 }))
    fakeWindow.dispatch('pointermove', pointerEvent({ clientX: 300 }))
    fakeWindow.dispatch('blur')
    expect(elements.root.classList.contains('is-resizing-sidebar')).toBe(false)
    expect(storage.getItem(SIDEBAR_WIDTH_KEY)).toBe('448')

    elements.descriptionHandle.hidden = true
    elements.descriptionHandle.dispatch('pointerdown', pointerEvent({ clientY: 100 }))
    expect(elements.root.classList.contains('is-resizing-description')).toBe(false)
    elements.descriptionHandle.hidden = false
    elements.descriptionHandle.dispatch('keydown', keyboardEvent('Home'))
    expect(storage.getItem(DAILY_DESCRIPTION_HEIGHT_KEY)).toBe(String(MIN_DAILY_DESCRIPTION_HEIGHT))
    expect(elements.descriptionHandle.attributes.get('aria-valuenow')).toBe(String(MIN_DAILY_DESCRIPTION_HEIGHT))

    expect(fakeWindow.listenerCount('resize')).toBe(1)
    controller.destroy()
    expect(fakeWindow.listenerCount('resize')).toBe(0)
    expect(fakeWindow.listenerCount('pointermove')).toBe(0)
    expect(elements.bottomHandle.listenerCount('pointerdown')).toBe(0)
    elements.bottomHandle.dispatch('pointerdown', pointerEvent({ clientY: 500 }))
    fakeWindow.dispatch('pointermove', pointerEvent({ clientY: 200 }))
    expect(elements.bottomPanel.style.values.get('--bottom-panel-height')).toBe('380px')
  })

  it('uses minimum values when a workspace cannot fit the preferred pane', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    storage.setItem(BOTTOM_PANEL_HEIGHT_KEY, '1')
    storage.setItem(GIT_FILE_LIST_WIDTH_KEY, '1')
    storage.setItem(SIDEBAR_WIDTH_KEY, '1')
    storage.setItem(DAILY_DESCRIPTION_HEIGHT_KEY, '1')
    elements.gitWorkspace.clientWidth = 200
    elements.workspace.clientWidth = 400
    elements.editorColumn.clientHeight = 200

    const controller = new PaneLayoutController(elements.root as unknown as HTMLElement, { storage: storage as unknown as Storage })
    controller.refresh()

    expect(elements.bottomHandle.attributes.get('aria-valuenow')).toBe(String(MIN_BOTTOM_PANEL_HEIGHT))
    expect(elements.gitSplitter.attributes.get('aria-valuenow')).toBe(String(MIN_GIT_FILE_LIST_WIDTH))
    expect(elements.sidebarSplitter.attributes.get('aria-valuenow')).toBe(String(MIN_SIDEBAR_WIDTH))
    expect(elements.descriptionHandle.attributes.get('aria-valuenow')).toBe(String(MIN_DAILY_DESCRIPTION_HEIGHT))
  })
})

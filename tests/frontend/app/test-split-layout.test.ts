import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TEST_LIST_WIDTH,
  MIN_TEST_LIST_WIDTH,
  TEST_LIST_WIDTH_KEY,
} from '../../../src/app/layout'
import { PaneLayoutController } from '../../../src/app/pane-layout'
import { TestSplitLayout } from '../../../src/app/test-split-layout'

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
    toggle: (name: string, force: boolean): void => {
      if (force) this.classList.values.add(name)
      else this.classList.values.delete(name)
    },
  }
  id = ''
  clientWidth = 0
  pointerCaptureId: number | null = null

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  setPointerCapture(pointerId: number): void {
    this.pointerCaptureId = pointerId
  }

  closest(selector: string): FakeElement | null {
    return selector === `#${this.id}` ? this : null
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

function pointerEvent(target: unknown, values: Partial<{ button: number; clientX: number; pointerId: number }> = {}): PointerEvent {
  return {
    target,
    button: 0,
    clientX: 0,
    pointerId: 1,
    preventDefault: vi.fn(),
    ...values,
  } as unknown as PointerEvent
}

function keyboardEvent(target: unknown, key: string): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return { target, key, preventDefault: vi.fn() } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function createRoot(workspaceWidth = 900): {
  root: FakeRoot
  panel: FakeElement
  body: FakeElement
  workspace: FakeElement
  splitter: FakeElement
  row: FakeElement
} {
  const root = new FakeRoot()
  const panel = root.register('#tests-panel')
  const body = root.register('#test-body')
  const workspace = root.register('.test-results-workspace')
  const splitter = root.register('#test-splitter')
  splitter.id = 'test-splitter'
  workspace.clientWidth = workspaceWidth
  return { root, panel, body, workspace, splitter, row: new FakeElement() }
}

let fakeWindow: FakeWindow
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

beforeEach(() => {
  fakeWindow = new FakeWindow()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
})

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

function create(elements: ReturnType<typeof createRoot>, storage = new MemoryStorage()): TestSplitLayout {
  return new TestSplitLayout(
    elements.root as unknown as HTMLElement,
    storage as unknown as Storage,
    fakeWindow as unknown as Window,
  )
}

describe('TestSplitLayout', () => {
  it('applies the persisted width to the panel and the separator ARIA values', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    storage.setItem(TEST_LIST_WIDTH_KEY, '340')

    create(elements, storage).apply()

    expect(elements.panel.style.values.get('--test-list-width')).toBe('340px')
    expect(elements.splitter.attributes.get('aria-valuenow')).toBe('340')
    // 900 minus the 260px output minimum and the 10px splitter.
    expect(elements.splitter.attributes.get('aria-valuemax')).toBe('630')
  })

  it('drags from the delegated separator, clamps both sides, and persists on release', () => {
    const elements = createRoot(700)
    const storage = new MemoryStorage()
    create(elements, storage)

    elements.body.dispatch('pointerdown', pointerEvent(elements.splitter, { clientX: 300, pointerId: 7 }))
    expect(elements.root.classList.contains('is-resizing-tests')).toBe(true)
    expect(elements.splitter.pointerCaptureId).toBe(7)

    fakeWindow.dispatch('pointermove', pointerEvent(null, { clientX: 360 }))
    expect(elements.panel.style.values.get('--test-list-width')).toBe(`${DEFAULT_TEST_LIST_WIDTH + 60}px`)
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBeNull()

    fakeWindow.dispatch('pointermove', pointerEvent(null, { clientX: 2000 }))
    expect(elements.panel.style.values.get('--test-list-width')).toBe('430px')

    fakeWindow.dispatch('pointermove', pointerEvent(null, { clientX: -2000 }))
    expect(elements.panel.style.values.get('--test-list-width')).toBe(`${MIN_TEST_LIST_WIDTH}px`)

    fakeWindow.dispatch('pointerup')
    expect(elements.root.classList.contains('is-resizing-tests')).toBe(false)
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe(String(MIN_TEST_LIST_WIDTH))

    fakeWindow.dispatch('pointermove', pointerEvent(null, { clientX: 400 }))
    expect(elements.panel.style.values.get('--test-list-width')).toBe(`${MIN_TEST_LIST_WIDTH}px`)
  })

  it('ignores presses and keys that do not start on the separator', () => {
    const elements = createRoot()
    const storage = new MemoryStorage()
    create(elements, storage)

    elements.body.dispatch('pointerdown', pointerEvent(elements.row, { clientX: 300 }))
    elements.body.dispatch('pointerdown', pointerEvent(elements.splitter, { clientX: 300, button: 2 }))
    expect(elements.root.classList.contains('is-resizing-tests')).toBe(false)

    const key = keyboardEvent(elements.row, 'Home')
    elements.body.dispatch('keydown', key)
    expect(key.preventDefault).not.toHaveBeenCalled()
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBeNull()
  })

  it('resizes from the keyboard within the clamped range', () => {
    const elements = createRoot(700)
    const storage = new MemoryStorage()
    create(elements, storage)

    elements.body.dispatch('keydown', keyboardEvent(elements.splitter, 'ArrowRight'))
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe(String(DEFAULT_TEST_LIST_WIDTH + 16))
    elements.body.dispatch('keydown', keyboardEvent(elements.splitter, 'End'))
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe('430')
    elements.body.dispatch('keydown', keyboardEvent(elements.splitter, 'Home'))
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe(String(MIN_TEST_LIST_WIDTH))
    expect(elements.splitter.attributes.get('aria-valuenow')).toBe(String(MIN_TEST_LIST_WIDTH))
  })

  it('keeps the minimum when the panel is too narrow for the preferred split', () => {
    const elements = createRoot(300)
    const storage = new MemoryStorage()
    storage.setItem(TEST_LIST_WIDTH_KEY, '500')

    create(elements, storage).refresh()

    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe(String(MIN_TEST_LIST_WIDTH))
    expect(elements.splitter.attributes.get('aria-valuemax')).toBe(String(MIN_TEST_LIST_WIDTH))
  })
})

describe('PaneLayoutController test split', () => {
  it('applies the split with the other panes, ends a drag on blur, and removes listeners on destroy', () => {
    const elements = createRoot(700)
    const storage = new MemoryStorage()
    storage.setItem(TEST_LIST_WIDTH_KEY, '320')
    const controller = new PaneLayoutController(elements.root as unknown as HTMLElement, {
      storage: storage as unknown as Storage,
    })

    controller.apply()
    expect(controller.testListWidthValue).toBe(320)
    expect(elements.panel.style.values.get('--test-list-width')).toBe('320px')

    elements.body.dispatch('pointerdown', pointerEvent(elements.splitter, { clientX: 100 }))
    fakeWindow.dispatch('pointermove', pointerEvent(null, { clientX: 140 }))
    fakeWindow.dispatch('blur')
    expect(elements.root.classList.contains('is-resizing-tests')).toBe(false)
    expect(storage.getItem(TEST_LIST_WIDTH_KEY)).toBe('360')

    controller.destroy()
    expect(elements.body.listenerCount('pointerdown')).toBe(0)
    expect(elements.body.listenerCount('keydown')).toBe(0)
    expect(fakeWindow.listenerCount('pointermove')).toBe(0)
  })
})

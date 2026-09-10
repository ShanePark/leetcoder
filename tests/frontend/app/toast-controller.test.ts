import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_VISIBLE_TOASTS,
  TOAST_DISMISS_MS,
  ToastController,
} from '../../../src/app/toast-controller'

type FakeNode = FakeElement

class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<() => void>>()
  parentElement: FakeElement | null = null
  className = ''
  title = ''
  type = ''
  private rawTextContent = ''

  constructor(readonly tagName: string) {}

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

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentElement = this
      this.children.push(node)
    }
    this.rawTextContent = ''
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node)
    return node
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener()
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
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

  private matches(selector: string): boolean {
    if (selector.startsWith('.')) {
      return this.className.split(/\s+/).includes(selector.slice(1))
    }
    if (selector === 'button') {
      return this.tagName === 'button'
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
      createElementNS: (_namespace: string, tagName: string) => new FakeElement(tagName),
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
  vi.useRealTimers()
  restoreDocument()
})

describe('ToastController', () => {
  it('renders full info text and an accessible first-line error', () => {
    installFakeDocument()
    const stack = new FakeElement('section')
    const controller = new ToastController(stack as unknown as HTMLElement)

    controller.show('Saved the file.', 'success')
    controller.show('Could not save\nPermission denied', 'error')

    const toasts = stack.querySelectorAll('.toast')
    expect(toasts).toHaveLength(2)
    expect(toasts[0].textContent).toContain('Saved the file.')
    expect(toasts[1].textContent).toContain('Could not save')
    expect(toasts[1].textContent).not.toContain('Permission denied')
    expect(toasts[1].title).toBe('Could not save\nPermission denied')
    expect(toasts[1].getAttribute('role')).toBe('alert')

    const close = toasts[1].querySelector<HTMLButtonElement>('.toast-close')
    expect(close?.type).toBe('button')
    expect(close?.getAttribute('aria-label')).toBe('Dismiss')
    expect(close?.listenerCount('click')).toBe(1)
    controller.dispose()
  })

  it('replaces errors, keeps at most three toasts, and clears evicted timers', () => {
    installFakeDocument()
    vi.useFakeTimers()
    const stack = new FakeElement('section')
    const controller = new ToastController(stack as unknown as HTMLElement)

    controller.show('First', 'info')
    controller.show('Failure 1', 'error')
    const firstError = stack.querySelector('.toast-error')
    controller.show('Failure 2', 'error')

    expect(stack.querySelector('.toast-error')?.textContent).toContain('Failure 2')
    expect(firstError?.parentElement).toBeNull()
    expect(firstError?.querySelector('button')?.listenerCount('click')).toBe(0)

    controller.show('Second', 'success')
    controller.show('Third', 'info')

    expect(stack.children).toHaveLength(MAX_VISIBLE_TOASTS)
    expect(stack.textContent).not.toContain('First')
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(TOAST_DISMISS_MS)
    expect(stack.children).toHaveLength(1)
    expect(stack.textContent).toContain('Failure 2')
    controller.dispose()
  })

  it('dismisses an error through its close button and removes the listener', () => {
    installFakeDocument()
    const stack = new FakeElement('section')
    const controller = new ToastController(stack as unknown as HTMLElement)

    controller.show('Needs attention', 'error')
    const toast = stack.querySelector('.toast-error')
    const close = toast?.querySelector<HTMLButtonElement>('.toast-close')
    close?.dispatch('click')

    expect(stack.children).toHaveLength(0)
    expect(close?.listenerCount('click')).toBe(0)
    controller.dispose()
  })

  it('cancels timers and removes owned toasts on dispose', () => {
    installFakeDocument()
    vi.useFakeTimers()
    const stack = new FakeElement('section')
    const controller = new ToastController(stack as unknown as HTMLElement)

    controller.show('Working', 'info')
    controller.show('Failure', 'error')
    const close = stack.querySelector<HTMLButtonElement>('.toast-close')
    expect(vi.getTimerCount()).toBe(1)

    controller.dispose()

    expect(stack.children).toHaveLength(0)
    expect(close?.listenerCount('click')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    controller.show('Ignored', 'success')
    expect(stack.children).toHaveLength(0)
  })
})

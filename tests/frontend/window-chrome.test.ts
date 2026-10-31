import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentWindow } from '@tauri-apps/api/window'

import {
  installWindowChrome,
  renderWindowControls,
  syncNativeWindowTheme,
  windowChromePlatform,
} from '../../src/window-chrome'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}))

vi.mock('../../src/icons', () => ({
  iconFor: (name: string) => ({ icon: name }),
}))

type Listener = () => void

class FakeElement {
  readonly listeners = new Map<string, Listener[]>()
  readonly attributes = new Map<string, string>()
  readonly elements = new Map<string, FakeElement>()
  readonly prepended: FakeElement[] = []
  children: unknown[] = []
  className = ''
  innerHTML = ''
  title = ''

  constructor(readonly ownerDocument: FakeDocument) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) {
      listener()
    }
  }

  append(...children: unknown[]): void {
    this.children.push(...children)
  }

  replaceChildren(...children: unknown[]): void {
    this.children = children
  }

  prepend(element: FakeElement): void {
    this.prepended.push(element)
  }

  querySelector(selector: string): FakeElement | null {
    const preset = this.elements.get(selector)
    if (preset && !selector.startsWith('#window-')) {
      return preset
    }
    const id = /^#(window-[a-z]+)$/.exec(selector)?.[1]
    if (!id || !this.innerHTML.includes(`id="${id}"`)) {
      return null
    }
    const element = this.elements.get(selector) ?? new FakeElement(this.ownerDocument)
    this.elements.set(selector, element)
    return element
  }
}

class FakeDocument {
  readonly documentElement = { dataset: {} as Record<string, string> }
  readonly created: FakeElement[] = []

  createElement(): FakeElement {
    const element = new FakeElement(this)
    this.created.push(element)
    return element
  }
}

const SHELL_SELECTORS = ['.app-header', '.app-header-start', '.app-shell', '.workspace']

function fakeAppRoot(ownerDocument: FakeDocument): FakeElement {
  const appRoot = new FakeElement(ownerDocument)
  for (const selector of SHELL_SELECTORS) {
    appRoot.elements.set(selector, new FakeElement(ownerDocument))
  }
  return appRoot
}

function fakeWindow(maximized = false) {
  const state = { maximized, resized: null as Listener | null }
  return {
    state,
    close: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => state.maximized),
    onResized: vi.fn(async (handler: Listener) => {
      state.resized = handler
      return () => undefined
    }),
    setTheme: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  }
}

interface ThemeEnvironment {
  background: string
  mutate: () => void
  changeColorScheme: () => void
}

function stubThemeEnvironment(): ThemeEnvironment {
  const environment: ThemeEnvironment = {
    background: '#09090a',
    mutate: () => undefined,
    changeColorScheme: () => undefined,
  }
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--bg' ? ` ${environment.background}` : ''),
  }))
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) {
      environment.mutate = callback
    }

    observe(): void {}
  })
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: (_type: string, listener: () => void) => {
      environment.changeColorScheme = listener
    },
  }))
  return environment
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.mocked(getCurrentWindow).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('window chrome platform', () => {
  it('separates macOS, Linux, and other desktop platforms', () => {
    expect(windowChromePlatform('MacIntel')).toBe('macos')
    expect(windowChromePlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(windowChromePlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('other')
  })
})

describe('installWindowChrome', () => {
  it('leads the app header with window buttons and drags from it only in the Linux desktop runtime', async () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' })
    const nativeWindow = fakeWindow()
    vi.mocked(getCurrentWindow).mockReturnValue(nativeWindow as never)
    const ownerDocument = new FakeDocument()
    const appRoot = fakeAppRoot(ownerDocument)

    await installWindowChrome(appRoot as unknown as HTMLElement, async () => undefined)

    const header = appRoot.elements.get('.app-header')
    const start = appRoot.elements.get('.app-header-start')
    expect(start?.prepended).toHaveLength(1)
    expect(start?.prepended[0]?.className).toBe('window-controls')
    expect(header?.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(appRoot.elements.get('.app-shell')?.getAttribute('data-tauri-drag-region')).toBe('')
    expect(appRoot.elements.get('.workspace')?.getAttribute('data-tauri-drag-region')).toBe('')
    expect(nativeWindow.setTheme).not.toHaveBeenCalled()
    expect(nativeWindow.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('keeps native macOS controls and syncs the window theme instead', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' })
    stubThemeEnvironment()
    const nativeWindow = fakeWindow()
    vi.mocked(getCurrentWindow).mockReturnValue(nativeWindow as never)
    const ownerDocument = new FakeDocument()
    ownerDocument.documentElement.dataset.theme = 'dark'
    const appRoot = fakeAppRoot(ownerDocument)

    await installWindowChrome(appRoot as unknown as HTMLElement, async () => undefined)

    expect(appRoot.elements.get('.app-header-start')?.prepended).toHaveLength(0)
    expect(nativeWindow.setTheme).toHaveBeenCalledWith('dark')
    expect(nativeWindow.setBackgroundColor).toHaveBeenCalledWith('#09090a')
  })

  it('leaves the browser preview untouched when the window bridge is missing', async () => {
    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' })
    vi.mocked(getCurrentWindow).mockImplementation(() => {
      throw new TypeError('window.__TAURI_INTERNALS__ is undefined')
    })
    const ownerDocument = new FakeDocument()
    const appRoot = fakeAppRoot(ownerDocument)

    await installWindowChrome(appRoot as unknown as HTMLElement, async () => undefined)

    expect(appRoot.elements.get('.app-header-start')?.prepended).toHaveLength(0)
    expect(ownerDocument.created).toHaveLength(0)
  })
})

describe('renderWindowControls', () => {
  it('orders close, minimize, and maximize', () => {
    const host = new FakeElement(new FakeDocument())

    renderWindowControls(host as unknown as HTMLElement, fakeWindow(), async () => undefined)

    const order = ['window-close', 'window-minimize', 'window-maximize']
      .map((id) => host.innerHTML.indexOf(`id="${id}"`))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)
  })

  it('closes through the guarded close request and never destroys directly', async () => {
    const host = new FakeElement(new FakeDocument())
    const nativeWindow = fakeWindow()
    const requestClose = vi.fn(async () => undefined)

    renderWindowControls(host as unknown as HTMLElement, nativeWindow, requestClose)
    host.querySelector('#window-close')?.click()
    host.querySelector('#window-minimize')?.click()
    host.querySelector('#window-maximize')?.click()
    await settle()

    expect(requestClose).toHaveBeenCalledOnce()
    expect(nativeWindow.close).not.toHaveBeenCalled()
    expect(nativeWindow.destroy).not.toHaveBeenCalled()
    expect(nativeWindow.minimize).toHaveBeenCalledOnce()
    expect(nativeWindow.toggleMaximize).toHaveBeenCalledOnce()
  })

  it('shows a restore button and drops the window outline while maximized', async () => {
    const ownerDocument = new FakeDocument()
    const host = new FakeElement(ownerDocument)
    const nativeWindow = fakeWindow()

    renderWindowControls(host as unknown as HTMLElement, nativeWindow, async () => undefined)
    expect(ownerDocument.documentElement.dataset.windowFrame).toBe('bordered')
    await settle()
    const maximize = host.querySelector('#window-maximize')
    expect(maximize?.children).toEqual([{ icon: 'windowMaximize' }])
    expect(maximize?.getAttribute('aria-label')).toBe('Maximize')

    nativeWindow.state.maximized = true
    nativeWindow.state.resized?.()
    await settle()

    expect(maximize?.children).toEqual([{ icon: 'windowRestore' }])
    expect(maximize?.getAttribute('aria-label')).toBe('Restore')
    expect(maximize?.title).toBe('Restore')
    expect(ownerDocument.documentElement.dataset.windowFrame).toBe('maximized')
  })
})

describe('syncNativeWindowTheme', () => {
  it('follows theme switches and OS appearance changes without repeating calls', () => {
    const environment = stubThemeEnvironment()
    const ownerDocument = new FakeDocument()
    ownerDocument.documentElement.dataset.theme = 'dark'
    const nativeWindow = fakeWindow()

    syncNativeWindowTheme(nativeWindow, ownerDocument as unknown as Document)
    expect(nativeWindow.setTheme).toHaveBeenLastCalledWith('dark')
    expect(nativeWindow.setBackgroundColor).toHaveBeenLastCalledWith('#09090a')

    ownerDocument.documentElement.dataset.theme = 'light'
    environment.background = '#e8e8eb'
    environment.mutate()
    expect(nativeWindow.setTheme).toHaveBeenLastCalledWith('light')
    expect(nativeWindow.setBackgroundColor).toHaveBeenLastCalledWith('#e8e8eb')

    ownerDocument.documentElement.dataset.theme = 'system'
    environment.mutate()
    expect(nativeWindow.setTheme).toHaveBeenLastCalledWith(null)
    expect(nativeWindow.setBackgroundColor).toHaveBeenCalledTimes(2)

    environment.background = '#09090a'
    environment.changeColorScheme()
    expect(nativeWindow.setTheme).toHaveBeenCalledTimes(3)
    expect(nativeWindow.setBackgroundColor).toHaveBeenLastCalledWith('#09090a')
    expect(nativeWindow.setBackgroundColor).toHaveBeenCalledTimes(3)
  })
})

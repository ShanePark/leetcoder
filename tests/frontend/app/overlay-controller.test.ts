import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  renderAboutDialog,
  renderAppMenu,
  renderSettingsDialog,
} from '../../../src/app/dialogs-view'
import { OverlayController } from '../../../src/app/overlay-controller'

vi.mock('../../../src/app/dialogs-view', () => ({
  renderAboutDialog: vi.fn(),
  renderAppMenu: vi.fn(),
  renderSettingsDialog: vi.fn(),
}))

type Listener = (event: Event) => void

class FakeDocument {
  activeElement: FakeElement | null = null
  readonly documentElement = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: '' },
  }
}

class FakeElement {
  readonly listeners = new Map<string, Set<Listener>>()
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  ownerDocument: FakeDocument
  parentElement: FakeElement | null = null
  hidden = false
  disabled = false
  checked = false
  value = ''
  name = ''
  id = ''
  isConnected = true
  focused = false
  textContent = ''

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, values: Partial<Event> = {}): void {
    const event = {
      ...values,
      currentTarget: this,
      target: values.target ?? this,
    } as Event
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  focus(): void {
    this.focused = true
    this.ownerDocument.activeElement = this
  }

  contains(target: EventTarget | null): boolean {
    if (target === this) {
      return true
    }
    return this.children.some((child) => child.contains(target))
  }

  closest(): FakeElement | null {
    return null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    if (selector === '[role="menuitem"]') {
      return this.children as T[]
    }
    return []
  }
}

class FakeRoot extends FakeElement {
  private readonly elements = new Map<string, FakeElement>()

  register(selector: string, element = new FakeElement(this.ownerDocument)): FakeElement {
    this.elements.set(selector, element)
    return element
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
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

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node')

function createRoot(): {
  root: FakeRoot
  activeTarget: FakeElement
  menuButton: FakeElement
  menu: FakeElement
  menuItems: FakeElement[]
  settingsForm: FakeElement
  themeInput: FakeElement
  settingsAppearanceNav: FakeElement
  settingsKeymapNav: FakeElement
  linuxTab: FakeElement
  macosTab: FakeElement
  selectedThemeInput: FakeElement
  closeSettings: FakeElement
  about: FakeElement
  closeAbout: FakeElement
} {
  const ownerDocument = new FakeDocument()
  const root = new FakeRoot(ownerDocument)
  const activeTarget = root.register('#active-target')
  const menuButton = root.register('#app-menu-button')
  const menu = root.register('#app-menu')
  const menuItems = [root.register('#menu-item-1'), root.register('#menu-item-2')]
  menu.children.push(...menuItems)
  root.register('#app-menu [role="menuitem"]:not([hidden]):not(:disabled)', menuItems[0])
  root.register('#update-menu-action')
  root.register('#settings-menu-action')
  root.register('#about-menu-action')
  root.register('#exit-menu-action')
  const settingsForm = root.register('#settings-form')
  const themeInput = root.register('#theme-input')
  const selectedThemeInput = root.register('#settings-form input:checked', themeInput)
  themeInput.name = 'theme-mode'
  themeInput.value = 'dark'
  themeInput.checked = true
  const settingsAppearanceNav = root.register('#settings-appearance-nav')
  const settingsKeymapNav = root.register('#settings-keymap-nav')
  const linuxTab = root.register('#shortcuts-linux-tab')
  linuxTab.id = 'shortcuts-linux-tab'
  const macosTab = root.register('#shortcuts-macos-tab')
  macosTab.id = 'shortcuts-macos-tab'
  const closeSettings = root.register('#close-settings')
  root.register('#settings-dialog')
  const about = root.register('#about-dialog')
  const closeAbout = root.register('#close-about')
  return {
    root,
    activeTarget,
    menuButton,
    menu,
    menuItems,
    settingsForm,
    themeInput,
    settingsAppearanceNav,
    settingsKeymapNav,
    linuxTab,
    macosTab,
    selectedThemeInput,
    closeSettings,
    about,
    closeAbout,
  }
}

function installDocument(document: FakeDocument): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  })
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: FakeElement,
  })
}

afterEach(() => {
  vi.clearAllMocks()
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument)
  } else {
    Reflect.deleteProperty(globalThis, 'document')
  }
  if (originalNode) {
    Object.defineProperty(globalThis, 'Node', originalNode)
  } else {
    Reflect.deleteProperty(globalThis, 'Node')
  }
})

describe('OverlayController', () => {
  it('opens the app menu, focuses the first item, and restores the prior focus', async () => {
    const elements = createRoot()
    installDocument(elements.root.ownerDocument)
    const controller = new OverlayController({ root: elements.root as unknown as HTMLElement, macPlatform: false })
    elements.activeTarget.focus()

    elements.menuButton.dispatch('click')
    await Promise.resolve()

    expect(controller.isAppMenuOpen).toBe(true)
    expect(elements.menuItems[0].focused).toBe(true)
    controller.closeAppMenu()

    expect(controller.isAppMenuOpen).toBe(false)
    expect(elements.root.ownerDocument.activeElement).toBe(elements.activeTarget)
  })

  it('moves through visible menu items with keyboard navigation', async () => {
    const elements = createRoot()
    installDocument(elements.root.ownerDocument)
    const controller = new OverlayController({ root: elements.root as unknown as HTMLElement, macPlatform: false })
    elements.activeTarget.focus()
    controller.openAppMenu()
    await Promise.resolve()

    const event = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent
    elements.menu.dispatch('keydown', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.menuItems[1])

    const home = { key: 'Home', preventDefault: vi.fn() } as unknown as KeyboardEvent
    elements.menu.dispatch('keydown', home)
    expect(elements.root.ownerDocument.activeElement).toBe(elements.menuItems[0])
  })

  it('restores focus for settings and about dialogs and handles Escape precedence', async () => {
    const elements = createRoot()
    installDocument(elements.root.ownerDocument)
    const controller = new OverlayController({ root: elements.root as unknown as HTMLElement, macPlatform: false })
    elements.activeTarget.focus()

    controller.openSettingsDialog('keymap')
    await Promise.resolve()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.linuxTab)
    const settingsEscape = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(controller.handleEscape(settingsEscape)).toBe(true)
    expect(settingsEscape.preventDefault).toHaveBeenCalledOnce()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.activeTarget)

    controller.openAboutDialog()
    await Promise.resolve()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.closeAbout)
    controller.closeAboutDialog()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.activeTarget)
  })

  it('closes the menu from an outside pointer and removes every listener on dispose', async () => {
    const elements = createRoot()
    installDocument(elements.root.ownerDocument)
    const controller = new OverlayController({ root: elements.root as unknown as HTMLElement, macPlatform: false })
    elements.activeTarget.focus()
    controller.openAppMenu()
    await Promise.resolve()

    const outside = { target: elements.activeTarget } as unknown as PointerEvent
    controller.handleOutsidePointerDown(outside)
    expect(controller.isAppMenuOpen).toBe(false)

    controller.openAboutDialog()
    controller.dispose()
    await Promise.resolve()
    expect(elements.root.ownerDocument.activeElement).toBe(elements.activeTarget)
    for (const element of [
      elements.menuButton,
      elements.menu,
      elements.settingsForm,
      elements.closeSettings,
      elements.about,
      elements.closeAbout,
    ]) {
      expect([...element.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)).toBe(0)
    }
    expect(controller.isAboutDialogOpen).toBe(true)
  })

  it('persists theme changes and updates the menu state through the controller', () => {
    const elements = createRoot()
    installDocument(elements.root.ownerDocument)
    const storage = new MemoryStorage()
    const controller = new OverlayController({
      root: elements.root as unknown as HTMLElement,
      storage: storage as unknown as Storage,
      macPlatform: true,
    })

    controller.setThemeMode('light')
    controller.setUpdateAvailable(true)
    controller.setUpdateBusy(true)

    expect(storage.getItem('leetcoder.theme-mode')).toBe('light')
    expect(elements.root.ownerDocument.documentElement.dataset.theme).toBe('light')
    expect(vi.mocked(renderAppMenu)).toHaveBeenLastCalledWith(elements.root, expect.objectContaining({
      updateAvailable: true,
      updateBusy: true,
      settingsShortcutLabel: '⌘,',
    }))
    expect(vi.mocked(renderSettingsDialog)).toHaveBeenCalled()
    expect(vi.mocked(renderAboutDialog)).not.toHaveBeenCalled()
  })
})

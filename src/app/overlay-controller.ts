import {
  renderAboutDialog,
  renderAppMenu,
  renderSettingsDialog,
} from './dialogs-view'
import {
  applyTheme,
  defaultShortcutPlatform,
  normalizeThemeMode,
  readThemeMode,
  THEME_MODE_KEY,
} from './layout'
import { shortcutLabel } from '../shortcuts'
import type { SettingsSection, ShortcutPlatform, ThemeMode } from './types'

export interface OverlayUpdateState {
  available: boolean
  busy: boolean
}

export interface OverlayControllerOptions {
  root: HTMLElement
  storage?: Storage
  /** The platform used for the first shortcut-reference tab and menu label. */
  macPlatform: boolean
  update?: Partial<OverlayUpdateState>
  onRequestUpdate?: () => void | Promise<void>
  onRequestClose?: () => void | Promise<void>
}

type FocusableElement = HTMLElement & {
  focus: () => void
}

/** Own the application-menu and informational/settings overlays. */
export class OverlayController {
  private readonly root: HTMLElement
  private readonly storage: Storage | undefined
  private readonly macPlatform: boolean
  private readonly onRequestUpdate: (() => void | Promise<void>) | undefined
  private readonly onRequestClose: (() => void | Promise<void>) | undefined
  private readonly listeners: Array<() => void> = []
  private disposed = false
  private appMenuOpen = false
  private appMenuFocusTarget: FocusableElement | null = null
  private settingsDialogOpen = false
  private settingsDialogFocusTarget: FocusableElement | null = null
  private settingsSection: SettingsSection = 'appearance'
  private aboutDialogOpen = false
  private aboutDialogFocusTarget: FocusableElement | null = null
  private shortcutsPlatform: ShortcutPlatform
  private themeMode: ThemeMode
  private updateAvailable: boolean
  private updateBusy: boolean

  constructor(options: OverlayControllerOptions) {
    this.root = options.root
    this.storage = options.storage
    this.macPlatform = options.macPlatform
    this.onRequestUpdate = options.onRequestUpdate
    this.onRequestClose = options.onRequestClose
    this.shortcutsPlatform = defaultShortcutPlatform(options.macPlatform)
    this.themeMode = readThemeMode(this.storage)
    this.updateAvailable = options.update?.available ?? false
    this.updateBusy = options.update?.busy ?? false
    applyTheme(this.themeMode)
    this.bindEvents()
  }

  get isAppMenuOpen(): boolean {
    return this.appMenuOpen
  }

  get isSettingsDialogOpen(): boolean {
    return this.settingsDialogOpen
  }

  get isAboutDialogOpen(): boolean {
    return this.aboutDialogOpen
  }

  get isUpdateAvailable(): boolean {
    return this.updateAvailable
  }

  get isUpdateBusy(): boolean {
    return this.updateBusy
  }

  /** Update the menu's update-action state without exposing its render details. */
  setUpdateAvailable(available: boolean): void {
    if (this.disposed || this.updateAvailable === available) {
      return
    }
    this.updateAvailable = available
    this.renderAppMenu()
  }

  /** Update the menu's busy state while an application update is running. */
  setUpdateBusy(busy: boolean): void {
    if (this.disposed || this.updateBusy === busy) {
      return
    }
    this.updateBusy = busy
    this.renderAppMenu()
  }

  render(): void {
    if (this.disposed) {
      return
    }
    this.renderAppMenu()
    this.renderSettingsDialog()
    this.renderAboutDialog()
  }

  toggleAppMenu(): void {
    if (this.appMenuOpen) {
      this.closeAppMenu()
    } else {
      this.openAppMenu()
    }
  }

  openAppMenu(): void {
    if (this.disposed || this.appMenuOpen) {
      return
    }
    this.appMenuFocusTarget = this.activeElement()
    this.appMenuOpen = true
    this.renderAppMenu()
    queueMicrotask(() => {
      if (this.disposed || !this.appMenuOpen) {
        return
      }
      this.root
        .querySelector<FocusableElement>('#app-menu [role="menuitem"]:not([hidden]):not(:disabled)')
        ?.focus()
    })
  }

  closeAppMenu(restoreFocus = true): void {
    if (this.disposed || !this.appMenuOpen) {
      return
    }
    this.appMenuOpen = false
    const target = this.appMenuFocusTarget
    this.appMenuFocusTarget = null
    this.renderAppMenu()
    if (restoreFocus) {
      this.restoreFocus(target)
    }
  }

  openSettingsDialog(section: SettingsSection = 'appearance'): void {
    if (this.disposed) {
      return
    }
    if (!this.settingsDialogOpen) {
      this.settingsDialogFocusTarget = this.activeElement()
      this.settingsDialogOpen = true
    }
    this.settingsSection = section
    this.renderSettingsDialog()
    queueMicrotask(() => {
      if (this.disposed || !this.settingsDialogOpen) {
        return
      }
      if (this.settingsSection === 'keymap') {
        this.element<FocusableElement>(this.shortcutsPlatform === 'macos'
          ? '#shortcuts-macos-tab'
          : '#shortcuts-linux-tab').focus()
      } else {
        this.root.querySelector<FocusableElement>('#settings-form input:checked')?.focus()
      }
    })
  }

  closeSettingsDialog(): void {
    if (this.disposed || !this.settingsDialogOpen) {
      return
    }
    this.settingsDialogOpen = false
    const target = this.settingsDialogFocusTarget
    this.settingsDialogFocusTarget = null
    this.renderSettingsDialog()
    this.restoreFocus(target, '#app-menu-button')
  }

  setSettingsSection(section: SettingsSection, focus = false): void {
    if (this.disposed || (this.settingsSection === section && !focus)) {
      return
    }
    this.settingsSection = section
    this.renderSettingsDialog()
    if (focus) {
      this.element<FocusableElement>(section === 'keymap'
        ? '#settings-keymap-nav'
        : '#settings-appearance-nav').focus()
    }
  }

  openAboutDialog(): void {
    if (this.disposed || this.aboutDialogOpen) {
      return
    }
    this.aboutDialogFocusTarget = this.activeElement()
    this.aboutDialogOpen = true
    this.renderAboutDialog()
    queueMicrotask(() => {
      if (this.disposed || !this.aboutDialogOpen) {
        return
      }
      this.element<FocusableElement>('#close-about').focus()
    })
  }

  closeAboutDialog(): void {
    if (this.disposed || !this.aboutDialogOpen) {
      return
    }
    this.aboutDialogOpen = false
    const target = this.aboutDialogFocusTarget
    this.aboutDialogFocusTarget = null
    this.renderAboutDialog()
    this.restoreFocus(target, '#app-menu-button')
  }

  setThemeMode(mode: string): void {
    if (this.disposed) {
      return
    }
    this.themeMode = normalizeThemeMode(mode)
    applyTheme(this.themeMode)
    this.storage?.setItem(THEME_MODE_KEY, this.themeMode)
    this.renderSettingsDialog()
  }

  setShortcutsPlatform(platform: ShortcutPlatform, focus = false): void {
    if (this.disposed || (this.shortcutsPlatform === platform && !focus)) {
      return
    }
    this.shortcutsPlatform = platform
    this.renderSettingsDialog()
    if (focus) {
      this.element<FocusableElement>(platform === 'macos'
        ? '#shortcuts-macos-tab'
        : '#shortcuts-linux-tab').focus()
    }
  }

  /** Close an open application menu when a pointer lands outside it. */
  handleOutsidePointerDown(event: PointerEvent): void {
    if (this.disposed || !this.appMenuOpen) {
      return
    }
    const target = event.target instanceof Node ? event.target : null
    const menu = this.root.querySelector<HTMLElement>('#app-menu')
    const button = this.root.querySelector<HTMLElement>('#app-menu-button')
    if (target && ((menu && menu.contains(target)) || (button && button.contains(target)))) {
      return
    }
    this.closeAppMenu()
  }

  /** Handle Escape for overlays before the app handles file/Git menus. */
  handleEscape(event: KeyboardEvent): boolean {
    if (this.disposed || event.key !== 'Escape') {
      return false
    }
    if (this.settingsDialogOpen) {
      event.preventDefault()
      this.closeSettingsDialog()
      return true
    }
    if (this.aboutDialogOpen) {
      event.preventDefault()
      this.closeAboutDialog()
      return true
    }
    if (this.appMenuOpen) {
      event.preventDefault()
      this.closeAppMenu()
      return true
    }
    return false
  }

  /** Remove overlay-local listeners and invalidate queued focus callbacks. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const remove of this.listeners.splice(0)) {
      remove()
    }
    this.appMenuFocusTarget = null
    this.settingsDialogFocusTarget = null
    this.aboutDialogFocusTarget = null
  }

  private bindEvents(): void {
    this.listen(this.element('#app-menu-button'), 'click', () => {
      this.toggleAppMenu()
    })
    this.listen(this.element('#app-menu'), 'keydown', (event) => {
      this.handleAppMenuKeydown(event as KeyboardEvent)
    })
    this.listen(this.element('#update-menu-action'), 'click', () => {
      this.closeAppMenu(false)
      void this.onRequestUpdate?.()
    })
    this.listen(this.element('#settings-menu-action'), 'click', () => {
      this.closeAppMenu(false)
      this.openSettingsDialog('appearance')
    })
    this.listen(this.element('#about-menu-action'), 'click', () => {
      this.closeAppMenu(false)
      this.openAboutDialog()
    })
    this.listen(this.element('#exit-menu-action'), 'click', () => {
      this.closeAppMenu(false)
      void this.onRequestClose?.()
    })
    this.listen(this.element('#close-settings'), 'click', () => {
      this.closeSettingsDialog()
    })
    this.listen(this.element('#settings-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeSettingsDialog()
      }
    })
    this.listen(this.element('#settings-form'), 'change', (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.name !== 'theme-mode' || !target.checked) {
        return
      }
      this.setThemeMode(target.value)
    })
    const shortcutPlatformTabs = [
      this.element<HTMLButtonElement>('#shortcuts-linux-tab'),
      this.element<HTMLButtonElement>('#shortcuts-macos-tab'),
    ]
    for (const tab of shortcutPlatformTabs) {
      this.listen(tab, 'click', () => {
        this.setShortcutsPlatform(tab.id === 'shortcuts-macos-tab' ? 'macos' : 'linux')
      })
      this.listen(tab, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboardEvent.key)) {
          return
        }
        keyboardEvent.preventDefault()
        const platform: ShortcutPlatform = keyboardEvent.key === 'Home' || keyboardEvent.key === 'ArrowLeft'
          ? 'linux'
          : 'macos'
        this.setShortcutsPlatform(platform, true)
      })
    }
    for (const [section, id] of [
      ['appearance', '#settings-appearance-nav'],
      ['keymap', '#settings-keymap-nav'],
    ] as const) {
      this.listen(this.element<HTMLButtonElement>(id), 'click', () => {
        this.setSettingsSection(section)
      })
    }
    const settingsNavItems = [
      this.element<HTMLButtonElement>('#settings-appearance-nav'),
      this.element<HTMLButtonElement>('#settings-keymap-nav'),
    ]
    for (const tab of settingsNavItems) {
      this.listen(tab, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keyboardEvent.key)) {
          return
        }
        keyboardEvent.preventDefault()
        const section: SettingsSection = keyboardEvent.key === 'Home'
          || keyboardEvent.key === 'ArrowUp'
          || keyboardEvent.key === 'ArrowLeft'
          ? 'appearance'
          : 'keymap'
        this.setSettingsSection(section, true)
      })
    }
    this.listen(this.element('#close-about'), 'click', () => {
      this.closeAboutDialog()
    })
    this.listen(this.element('#about-dialog'), 'pointerdown', (event) => {
      if (event.target === event.currentTarget) {
        this.closeAboutDialog()
      }
    })
  }

  private handleAppMenuKeydown(event: KeyboardEvent): void {
    if (this.disposed || !this.appMenuOpen) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.closeAppMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }
    const items = Array.from(this.element<HTMLElement>('#app-menu')
      .querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .filter((item) => !item.hidden && !item.disabled)
    if (items.length === 0) {
      return
    }
    const active = this.activeElement()
    const currentIndex = items.findIndex((item) => item === active)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : Math.max(0, Math.min(
          items.length - 1,
          currentIndex + (event.key === 'ArrowDown' ? 1 : -1),
        ))
    event.preventDefault()
    items[nextIndex]?.focus()
  }

  private renderAppMenu(): void {
    renderAppMenu(this.root, {
      open: this.appMenuOpen,
      updateAvailable: this.updateAvailable,
      updateBusy: this.updateBusy,
      settingsShortcutLabel: shortcutLabel('open-settings', this.macPlatform),
    })
  }

  private renderSettingsDialog(): void {
    renderSettingsDialog(this.root, {
      open: this.settingsDialogOpen,
      section: this.settingsSection,
      platform: this.shortcutsPlatform,
      themeMode: this.themeMode,
    })
  }

  private renderAboutDialog(): void {
    renderAboutDialog(this.root, this.aboutDialogOpen)
  }

  private activeElement(): FocusableElement | null {
    const ownerDocument = this.root.ownerDocument
    const active = ownerDocument?.activeElement
      ?? (typeof document !== 'undefined' ? document.activeElement : null)
    return this.asFocusable(active)
  }

  private restoreFocus(target: FocusableElement | null, fallbackSelector?: string): void {
    if (this.isUsableFocusTarget(target)) {
      target.focus()
      return
    }
    if (fallbackSelector) {
      this.element<FocusableElement>(fallbackSelector).focus()
    }
  }

  private isUsableFocusTarget(target: FocusableElement | null): target is FocusableElement {
    if (!target || target.isConnected === false) {
      return false
    }
    return !target.closest?.('[hidden]')
  }

  private asFocusable(value: Element | null): FocusableElement | null {
    if (!value || typeof (value as FocusableElement).focus !== 'function') {
      return null
    }
    return value as FocusableElement
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`Missing editor element: ${selector}`)
    }
    return element
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    const bound = listener as EventListener
    target.addEventListener(type, bound)
    this.listeners.push(() => target.removeEventListener(type, bound))
  }
}

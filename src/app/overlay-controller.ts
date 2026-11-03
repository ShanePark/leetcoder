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
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
  type ShortcutPlatform,
  type ThemeMode,
} from './types'
import type { UpdatePhase } from '../update-controller'

/** The LLM settings tab, which owns its own DOM and backend requests. */
export interface LlmSettingsPanel {
  /** The tab became visible. Not called for overlay re-renders. */
  activate: () => void
  /** The settings dialog closed. */
  dialogClosed: () => void
  /** Close a confirmation owned by the tab; true when one was open. */
  handleEscape: () => boolean
  dispose: () => void
}

export interface OverlayControllerOptions {
  root: HTMLElement
  storage?: Storage
  /** The platform used for the first shortcut-reference tab and menu label. */
  macPlatform: boolean
  updatePhase?: UpdatePhase
  llmSettings?: LlmSettingsPanel
  onRequestUpdate?: () => void | Promise<void>
  onRequestClose?: () => void | Promise<void>
}

type FocusableElement = HTMLElement & {
  focus: () => void
}

function settingsNavTargetIndex(key: string, index: number): number | null {
  const last = SETTINGS_SECTIONS.length - 1
  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return last
    case 'ArrowUp':
    case 'ArrowLeft':
      return Math.max(0, index - 1)
    case 'ArrowDown':
    case 'ArrowRight':
      return Math.min(last, index + 1)
    default:
      return null
  }
}

/** Own the application-menu and informational/settings overlays. */
export class OverlayController {
  private readonly root: HTMLElement
  private readonly storage: Storage | undefined
  private readonly macPlatform: boolean
  private readonly llmSettings: LlmSettingsPanel | undefined
  private llmSettingsVisible = false
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
  private updatePhase: UpdatePhase

  constructor(options: OverlayControllerOptions) {
    this.root = options.root
    this.storage = options.storage
    this.macPlatform = options.macPlatform
    this.llmSettings = options.llmSettings
    this.onRequestUpdate = options.onRequestUpdate
    this.onRequestClose = options.onRequestClose
    this.shortcutsPlatform = defaultShortcutPlatform(options.macPlatform)
    this.themeMode = readThemeMode(this.storage)
    this.updatePhase = options.updatePhase ?? 'hidden'
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

  /** Mirror the update phase in the menu without exposing its render details. */
  setUpdatePhase(phase: UpdatePhase): void {
    if (this.disposed || this.updatePhase === phase) {
      return
    }
    this.updatePhase = phase
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
    this.syncLlmSettingsVisibility()
    queueMicrotask(() => {
      if (this.disposed || !this.settingsDialogOpen) {
        return
      }
      this.root.querySelector<FocusableElement>(this.settingsInitialFocusSelector())?.focus()
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
    this.syncLlmSettingsVisibility()
    this.llmSettings?.dialogClosed()
    this.restoreFocus(target, '#app-menu-button')
  }

  setSettingsSection(section: SettingsSection, focus = false): void {
    if (this.disposed || (this.settingsSection === section && !focus)) {
      return
    }
    this.settingsSection = section
    this.renderSettingsDialog()
    this.syncLlmSettingsVisibility()
    if (focus) {
      this.element<FocusableElement>(`#settings-${section}-nav`).focus()
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
      if (!this.llmSettings?.handleEscape()) {
        this.closeSettingsDialog()
      }
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
    this.llmSettings?.dispose()
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
    // Enter in the key field or on a theme option would otherwise reload the webview.
    this.listen(this.element('#settings-form'), 'submit', (event) => {
      event.preventDefault()
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
    for (const [index, section] of SETTINGS_SECTIONS.entries()) {
      const tab = this.element<HTMLButtonElement>(`#settings-${section}-nav`)
      this.listen(tab, 'click', () => {
        this.setSettingsSection(section)
      })
      this.listen(tab, 'keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent
        const target = settingsNavTargetIndex(keyboardEvent.key, index)
        if (target === null) {
          return
        }
        keyboardEvent.preventDefault()
        this.setSettingsSection(SETTINGS_SECTIONS[target], true)
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
      updatePhase: this.updatePhase,
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

  private settingsInitialFocusSelector(): string {
    switch (this.settingsSection) {
      case 'appearance':
        return '#settings-form input:checked'
      case 'keymap':
        return this.shortcutsPlatform === 'macos' ? '#shortcuts-macos-tab' : '#shortcuts-linux-tab'
      case 'llm':
        return this.root.querySelector<HTMLElement>('#llm-key-entry')?.hidden ? '#llm-replace-key' : '#llm-api-key'
    }
  }

  /** Activate the LLM tab only on the transition to visible, never on a re-render. */
  private syncLlmSettingsVisibility(): void {
    const visible = this.settingsDialogOpen && this.settingsSection === 'llm'
    const becameVisible = visible && !this.llmSettingsVisible
    this.llmSettingsVisible = visible
    if (becameVisible) {
      this.llmSettings?.activate()
    }
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

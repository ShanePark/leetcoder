import type { Window as TauriWindow } from '@tauri-apps/api/window'

import { isMacPlatform } from './app/layout'
import { iconFor } from './icons'

export type WindowChromePlatform = 'macos' | 'linux' | 'other'

type NativeThemeWindow = Pick<TauriWindow, 'setBackgroundColor' | 'setTheme'>
type TitleBarWindow = Pick<TauriWindow, 'minimize' | 'toggleMaximize' | 'isMaximized' | 'onResized'>

export function windowChromePlatform(platform: string, userAgent = ''): WindowChromePlatform {
  if (isMacPlatform(platform, userAgent)) {
    return 'macos'
  }
  return /Linux/i.test(`${platform} ${userAgent}`) ? 'linux' : 'other'
}

/**
 * Make the native title bar read as part of the app: macOS shows the window
 * background through its transparent title bar, and Linux windows are
 * undecorated, so the app draws its own bar above the shell. The window
 * bridge is loaded lazily so the browser preview keeps its plain page.
 */
export async function installWindowChrome(
  appRoot: HTMLElement,
  requestClose: () => Promise<void>,
): Promise<void> {
  const platform = typeof navigator === 'undefined'
    ? 'other'
    : windowChromePlatform(navigator.platform, navigator.userAgent)
  if (platform === 'other') {
    return
  }
  let nativeWindow: TauriWindow
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    nativeWindow = getCurrentWindow()
  } catch {
    // The browser preview has no Tauri window bridge.
    return
  }
  if (platform === 'macos') {
    syncNativeWindowTheme(nativeWindow, appRoot.ownerDocument)
  } else {
    installAppDrawnTitleBar(appRoot, nativeWindow, requestClose)
  }
}

/**
 * Undecorated Linux windows have no title bar row, so the app header stands
 * in for one: the window buttons lead it, and the header and the bare gaps
 * around the panels drag the window. Its buttons and inputs stay clickable.
 */
function installAppDrawnTitleBar(
  appRoot: HTMLElement,
  nativeWindow: TitleBarWindow,
  requestClose: () => Promise<void>,
): void {
  const header = appRoot.querySelector<HTMLElement>('.app-header')
  const start = appRoot.querySelector<HTMLElement>('.app-header-start')
  if (!header || !start) {
    return
  }
  const controls = appRoot.ownerDocument.createElement('div')
  start.prepend(controls)
  renderWindowControls(controls, nativeWindow, requestClose)
  header.setAttribute('data-tauri-drag-region', 'deep')
  for (const selector of ['.app-shell', '.workspace']) {
    appRoot.querySelector(selector)?.setAttribute('data-tauri-drag-region', '')
  }
}

/**
 * Mirror the applied theme into the native window: `--bg` fills the
 * transparent title bar, and the native theme keeps the title and window
 * buttons legible. System mode hands the appearance back to the OS, whose
 * changes then arrive through the color-scheme media query.
 */
export function syncNativeWindowTheme(nativeWindow: NativeThemeWindow, ownerDocument: Document): void {
  const documentElement = ownerDocument.documentElement
  let appliedTheme: 'light' | 'dark' | null | undefined
  let appliedBackground = ''
  const sync = (): void => {
    const mode = documentElement.dataset.theme
    const theme = mode === 'light' || mode === 'dark' ? mode : null
    if (theme !== appliedTheme) {
      appliedTheme = theme
      nativeWindow.setTheme(theme).catch(reportChromeError)
    }
    const background = getComputedStyle(documentElement).getPropertyValue('--bg').trim()
    if (background && background !== appliedBackground) {
      appliedBackground = background
      nativeWindow.setBackgroundColor(background).catch(reportChromeError)
    }
  }
  sync()
  new MutationObserver(sync).observe(documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', sync)
}

/**
 * Draw the undecorated window's close, minimize, and maximize buttons. The
 * window manager draws no frame either, so the root is marked for an
 * app-drawn outline while the window is not maximized. Close uses the
 * app's guarded close request so unsaved work is written before the window
 * is destroyed.
 */
export function renderWindowControls(
  host: HTMLElement,
  nativeWindow: TitleBarWindow,
  requestClose: () => Promise<void>,
): void {
  const frame = host.ownerDocument.documentElement.dataset
  frame.windowFrame = 'bordered'
  host.className = 'window-controls'
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', 'Window controls')
  host.innerHTML = `
    <button id="window-close" class="icon-button window-control window-control-close" type="button" aria-label="Close" title="Close"></button>
    <button id="window-minimize" class="icon-button window-control" type="button" aria-label="Minimize" title="Minimize"></button>
    <button id="window-maximize" class="icon-button window-control" type="button" aria-label="Maximize" title="Maximize"></button>
  `
  const close = controlButton(host, '#window-close')
  const minimize = controlButton(host, '#window-minimize')
  const maximize = controlButton(host, '#window-maximize')
  close.append(iconFor('close', 'button-icon'))
  minimize.append(iconFor('windowMinimize', 'button-icon'))
  maximize.append(iconFor('windowMaximize', 'button-icon'))

  close.addEventListener('click', () => {
    requestClose().catch(reportChromeError)
  })
  minimize.addEventListener('click', () => {
    nativeWindow.minimize().catch(reportChromeError)
  })
  maximize.addEventListener('click', () => {
    nativeWindow.toggleMaximize().catch(reportChromeError)
  })

  const syncMaximized = async (): Promise<void> => {
    const maximized = await nativeWindow.isMaximized()
    const label = maximized ? 'Restore' : 'Maximize'
    frame.windowFrame = maximized ? 'maximized' : 'bordered'
    maximize.replaceChildren(iconFor(maximized ? 'windowRestore' : 'windowMaximize', 'button-icon'))
    maximize.setAttribute('aria-label', label)
    maximize.title = label
  }
  syncMaximized().catch(reportChromeError)
  nativeWindow.onResized(() => {
    syncMaximized().catch(reportChromeError)
  }).catch(reportChromeError)
}

function controlButton(host: HTMLElement, selector: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(selector)
  if (!button) {
    throw new Error(`Missing window control: ${selector}`)
  }
  return button
}

function reportChromeError(error: unknown): void {
  console.error('Could not update the window title bar.', error)
}

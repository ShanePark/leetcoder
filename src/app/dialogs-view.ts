import { SHORTCUT_SECTIONS, formatShortcut, platformBindings } from '../shortcuts'
import type {
  FileContextMenuState,
  GitChangedFile,
  GitContextMenuState,
  ProblemFileEntry,
  SettingsSection,
  ShortcutPlatform,
  ThemeMode,
} from './types'
import { clampContextMenuPosition, macShortcutDialogLabel } from './layout'
import { discardGitChangesWarningMessage } from './file-helpers'
import { sameFilePath } from './path-helpers'

const FILE_CONTEXT_MENU_WIDTH = 156
const FILE_CONTEXT_MENU_HEIGHT = 108
const GIT_CONTEXT_MENU_WIDTH = 190
const GIT_CONTEXT_MENU_HEIGHT = 76

export interface AppMenuRenderOptions {
  open: boolean
  updateAvailable: boolean
  updateBusy: boolean
  settingsShortcutLabel: string
}

export interface SettingsDialogRenderOptions {
  open: boolean
  section: SettingsSection
  platform: ShortcutPlatform
  themeMode: ThemeMode
}

export interface DiscardGitDialogRenderOptions {
  file: GitChangedFile | null
  busy: boolean
  gitBusy: boolean
}

export interface DeleteFileDialogRenderOptions {
  file: ProblemFileEntry | null
  busy: boolean
}

export interface FileContextMenuRenderOptions {
  context: FileContextMenuState | null
  busy: boolean
}

export interface GitContextMenuRenderOptions {
  context: GitContextMenuState | null
  files: GitChangedFile[]
  busy: boolean
  gitBusy: boolean
  loading: boolean
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const match = root.querySelector<T>(selector)
  if (!match) {
    throw new Error(`Missing editor element: ${selector}`)
  }
  return match
}

/** Render the app menu state without reaching into the application controller. */
export function renderAppMenu(root: HTMLElement, options: AppMenuRenderOptions): void {
  const menu = root.querySelector<HTMLElement>('#app-menu')
  const button = root.querySelector<HTMLButtonElement>('#app-menu-button')
  const update = root.querySelector<HTMLButtonElement>('#update-menu-action')
  const settings = root.querySelector<HTMLButtonElement>('#settings-menu-action')
  const settingsShortcut = root.querySelector<HTMLElement>('#settings-menu-shortcut')
  if (!menu || !button || !update) {
    return
  }
  menu.hidden = !options.open
  button.setAttribute('aria-expanded', String(options.open))
  update.hidden = !options.updateAvailable
  update.disabled = options.updateBusy
  update.setAttribute('aria-busy', String(options.updateBusy))
  if (settings && settingsShortcut) {
    settingsShortcut.textContent = options.settingsShortcutLabel
    settings.title = `Open Settings (${options.settingsShortcutLabel})`
    settings.setAttribute('aria-label', `Settings (${options.settingsShortcutLabel})`)
  }
}

/** Render the about dialog visibility. */
export function renderAboutDialog(root: HTMLElement, open: boolean): void {
  const dialog = root.querySelector<HTMLElement>('#about-dialog')
  if (dialog) {
    dialog.hidden = !open
  }
}

/** Render appearance settings and the platform-specific shortcut reference. */
export function renderSettingsDialog(root: HTMLElement, options: SettingsDialogRenderOptions): void {
  const dialog = root.querySelector<HTMLElement>('#settings-dialog')
  if (!dialog) {
    return
  }
  dialog.hidden = !options.open
  const appearanceNav = requiredElement<HTMLButtonElement>(root, '#settings-appearance-nav')
  const keymapNav = requiredElement<HTMLButtonElement>(root, '#settings-keymap-nav')
  const appearancePanel = requiredElement<HTMLElement>(root, '#settings-appearance-panel')
  const keymapPanel = requiredElement<HTMLElement>(root, '#settings-keymap-panel')
  const appearanceSelected = options.section === 'appearance'
  for (const [tab, selected] of [[appearanceNav, appearanceSelected], [keymapNav, !appearanceSelected]] as const) {
    tab.classList.toggle('is-active', selected)
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  appearancePanel.hidden = !appearanceSelected
  keymapPanel.hidden = appearanceSelected
  const linuxTab = requiredElement<HTMLButtonElement>(root, '#shortcuts-linux-tab')
  const macosTab = requiredElement<HTMLButtonElement>(root, '#shortcuts-macos-tab')
  const mac = options.platform === 'macos'
  for (const [tab, selected] of [[linuxTab, !mac], [macosTab, mac]] as const) {
    tab.classList.toggle('is-active', selected)
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  const body = requiredElement<HTMLElement>(root, '#shortcuts-body')
  body.setAttribute('aria-labelledby', mac ? 'shortcuts-macos-tab' : 'shortcuts-linux-tab')
  body.innerHTML = ''
  keymapPanel.classList.toggle('is-macos', mac)
  root.querySelectorAll<HTMLInputElement>('#settings-form input[name="theme-mode"]').forEach((input) => {
    input.checked = input.value === options.themeMode
  })
  for (const section of SHORTCUT_SECTIONS) {
    const group = document.createElement('section')
    group.className = 'shortcuts-group'
    const heading = document.createElement('h3')
    heading.className = 'shortcuts-group-title'
    heading.textContent = section.title
    group.append(heading)
    const list = document.createElement('dl')
    list.className = 'shortcuts-list'
    for (const entry of section.entries) {
      const keys = document.createElement('dt')
      keys.className = 'shortcuts-keys'
      for (const [index, binding] of platformBindings(entry, mac).entries()) {
        if (index > 0) {
          keys.append(document.createTextNode(' / '))
        }
        const key = document.createElement('kbd')
        const label = formatShortcut(binding, mac)
        const displayLabel = mac ? macShortcutDialogLabel(binding, label) : label
        key.textContent = displayLabel
        key.setAttribute('aria-label', displayLabel)
        key.title = displayLabel
        keys.append(key)
      }
      const description = document.createElement('dd')
      description.className = 'shortcuts-description'
      description.textContent = entry.description
      list.append(keys, description)
    }
    group.append(list)
    body.append(group)
  }
}

/** Render the destructive Git confirmation dialog. */
export function renderDiscardGitDialog(root: HTMLElement, options: DiscardGitDialogRenderOptions): void {
  const dialog = requiredElement<HTMLElement>(root, '#discard-git-dialog')
  const file = options.file
  dialog.hidden = !file
  if (!file) {
    requiredElement<HTMLElement>(root, '#discard-git-path').textContent = ''
    requiredElement<HTMLElement>(root, '#discard-git-message').textContent = ''
    return
  }
  requiredElement<HTMLElement>(root, '#discard-git-path').textContent = file.path
  requiredElement<HTMLElement>(root, '#discard-git-message').textContent = discardGitChangesWarningMessage()
  requiredElement<HTMLButtonElement>(root, '#confirm-discard-git').disabled = options.busy || options.gitBusy
}

/** Render the file-delete confirmation dialog. */
export function renderDeleteFileDialog(root: HTMLElement, options: DeleteFileDialogRenderOptions): void {
  const dialog = requiredElement<HTMLElement>(root, '#delete-file-dialog')
  const file = options.file
  dialog.hidden = !file
  requiredElement<HTMLElement>(root, '#delete-file-name').textContent = file?.name ?? ''
  requiredElement<HTMLButtonElement>(root, '#confirm-delete-file').disabled = options.busy
}

/** Render the file context menu at a safe viewport position. */
export function renderFileContextMenu(root: HTMLElement, options: FileContextMenuRenderOptions): void {
  const menu = requiredElement<HTMLElement>(root, '#file-context-menu')
  const context = options.context
  if (!context) {
    menu.hidden = true
    return
  }
  const position = clampContextMenuPosition(
    context.x,
    context.y,
    FILE_CONTEXT_MENU_WIDTH,
    FILE_CONTEXT_MENU_HEIGHT,
  )
  menu.style.left = `${position.x}px`
  menu.style.top = `${position.y}px`
  menu.hidden = false
  // Keep action labels compact; the confirmation dialog names the target.
  requiredElement<HTMLElement>(root, '#duplicate-file-label').textContent = 'Duplicate'
  requiredElement<HTMLElement>(root, '#rename-file-label').textContent = 'Rename'
  requiredElement<HTMLElement>(root, '#delete-file-label').textContent = 'Delete'
  requiredElement<HTMLButtonElement>(root, '#duplicate-file-action').disabled = options.busy
  requiredElement<HTMLButtonElement>(root, '#rename-file-action').disabled = options.busy
  requiredElement<HTMLButtonElement>(root, '#delete-file-action').disabled = options.busy
}

/** Render the Git context menu only while its target remains in the status list. */
export function renderGitContextMenu(root: HTMLElement, options: GitContextMenuRenderOptions): void {
  const menu = requiredElement<HTMLElement>(root, '#git-context-menu')
  const context = options.context
  const fileStillChanged = context
    && options.files.some((file) => sameFilePath(file.path, context.file.path))
  if (!context || !fileStillChanged) {
    menu.hidden = true
    return
  }
  const position = clampContextMenuPosition(
    context.x,
    context.y,
    GIT_CONTEXT_MENU_WIDTH,
    GIT_CONTEXT_MENU_HEIGHT,
  )
  menu.style.left = `${position.x}px`
  menu.style.top = `${position.y}px`
  menu.hidden = false
  const disabled = options.busy || options.gitBusy || options.loading
  requiredElement<HTMLButtonElement>(root, '#git-discard-action').disabled = disabled
  requiredElement<HTMLButtonElement>(root, '#git-show-file-action').disabled = disabled
}

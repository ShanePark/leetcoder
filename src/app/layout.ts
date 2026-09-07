import type { SettingsSection, ShortcutPlatform, ThemeMode } from './types'

export const DEFAULT_BOTTOM_PANEL_HEIGHT = 280
export const MIN_BOTTOM_PANEL_HEIGHT = 180
export const MAX_BOTTOM_PANEL_HEIGHT = 640
export const DEFAULT_GIT_FILE_LIST_WIDTH = 300
export const MIN_GIT_FILE_LIST_WIDTH = 180
export const MIN_GIT_DIFF_WIDTH = 260
export const GIT_SPLITTER_WIDTH = 7
export const GIT_WORKSPACE_GAP = 16
export const DEFAULT_SIDEBAR_WIDTH = 248
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 520
export const MIN_EDITOR_WIDTH = 360
export const SIDEBAR_SPLITTER_WIDTH = 7
export const DEFAULT_DAILY_DESCRIPTION_HEIGHT = 220
export const MIN_DAILY_DESCRIPTION_HEIGHT = 120
export const MAX_DAILY_DESCRIPTION_HEIGHT = 560
export const MIN_CODE_CARD_HEIGHT = 180
export const DAILY_DESCRIPTION_LAYOUT_OVERHEAD = 86
export const DAILY_DESCRIPTION_SPLITTER_HEIGHT = 7
export const VIEWPORT_MARGIN = 8

export const BOTTOM_PANEL_HEIGHT_KEY = 'leetcoder.bottom-panel-height'
export const GIT_FILE_LIST_WIDTH_KEY = 'leetcoder.git-file-list-width'
export const SIDEBAR_WIDTH_KEY = 'leetcoder.sidebar-width'
export const DAILY_DESCRIPTION_HEIGHT_KEY = 'leetcoder.daily-description-height'
export const THEME_MODE_KEY = 'leetcoder.theme-mode'

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark' ? value : 'dark'
}

export function readThemeMode(storage: Storage | undefined): ThemeMode {
  return normalizeThemeMode(storage?.getItem(THEME_MODE_KEY))
}

/** Apply an appearance immediately while leaving the selected mode persisted separately. */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode === 'system' ? 'dark light' : mode
}

/** Detect Apple platforms from explicit navigator values without reading globals. */
export function isMacPlatform(platform: string, userAgent = ''): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`)
}

/** The first shortcut tab follows the operating system running the app. */
export function defaultShortcutPlatform(macPlatform: boolean): ShortcutPlatform {
  return macPlatform ? 'macos' : 'linux'
}

/**
 * Use readable modifier names in the macOS shortcut dialog while keeping the
 * formatter output available for the hover tooltip. The binding remains the
 * source of truth; these are display aliases only.
 */
export function macShortcutDialogLabel(binding: string, formatted: string): string {
  const parts = binding.split('-')
  const key = parts.at(-1)
  const modifiers = parts.slice(0, -1)
  const modifierNames: Readonly<Record<string, string>> = {
    Shift: 'Shift',
    Mod: 'Cmd',
    Cmd: 'Cmd',
    Alt: 'Opt',
    Ctrl: 'Ctrl',
  }
  const keyNames: Readonly<Record<string, string>> = {
    ArrowUp: 'Arrow Up',
    ArrowDown: 'Arrow Down',
    ArrowLeft: 'Arrow Left',
    ArrowRight: 'Arrow Right',
    Backspace: 'Backspace',
    Enter: 'Enter',
    Escape: 'Esc',
    Space: 'Space',
  }
  if (!key) {
    return formatted
  }
  const keyLabel = keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  const modifierLabels = modifiers.map((modifier) => modifierNames[modifier] ?? modifier)
  return [...modifierLabels, keyLabel].join(' + ')
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }
  return `${(durationMs / 1000).toFixed(2)}s`
}

/** Live status-row copy: early phases read as compiling, later as running. */
export function liveRunPhaseLabel(phase: string): string {
  const normalized = phase.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (
    normalized === 'starting'
    || normalized === 'compiling'
    || normalized === 'compile'
    || normalized === 'compilation'
  ) {
    return 'Compiling…'
  }
  return 'Running tests…'
}

/** Non-zero result counts for the finished status row, actionable first. */
export function testRunFacts(summary: {
  failed: number
  errors: number
  passed: number
  skipped: number
}): string[] {
  const parts: string[] = []
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`)
  }
  if (summary.errors > 0) {
    parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`)
  }
  if (summary.passed > 0) {
    parts.push(`${summary.passed} passed`)
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} skipped`)
  }
  return parts
}

export function clampBottomPanelHeight(value: number, viewportHeight = windowHeight()): number {
  const usableViewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800
  const maximum = Math.max(MIN_BOTTOM_PANEL_HEIGHT, Math.min(MAX_BOTTOM_PANEL_HEIGHT, Math.round(usableViewport * .8)))
  const candidate = Number.isNaN(value) ? DEFAULT_BOTTOM_PANEL_HEIGHT : value
  return Math.round(Math.min(maximum, Math.max(MIN_BOTTOM_PANEL_HEIGHT, candidate)))
}

export function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1000,
  viewportHeight = windowHeight(),
  margin = VIEWPORT_MARGIN,
): { x: number; y: number } {
  const safeX = Number.isFinite(x) ? x : margin
  const safeY = Number.isFinite(y) ? y : margin
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 0
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1000
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800
  return {
    x: Math.max(margin, Math.min(safeX, safeViewportWidth - safeWidth - margin)),
    y: Math.max(margin, Math.min(safeY, safeViewportHeight - safeHeight - margin)),
  }
}

export function clampGitFileListWidth(value: number, availableWidth = 900): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  const maximum = maxGitFileListWidth(usableWidth)
  const candidate = Number.isNaN(value) ? DEFAULT_GIT_FILE_LIST_WIDTH : value
  return Math.round(Math.min(maximum, Math.max(MIN_GIT_FILE_LIST_WIDTH, candidate)))
}

/** Keep the resizable problem-file pane usable alongside the editor. */
export function clampSidebarWidth(value: number, availableWidth = 1000): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 1000
  const maximum = maxSidebarWidth(usableWidth)
  const candidate = Number.isNaN(value) ? DEFAULT_SIDEBAR_WIDTH : value
  return Math.round(Math.min(maximum, Math.max(MIN_SIDEBAR_WIDTH, candidate)))
}

/** Keep a visible editor area while resizing the open problem description. */
export function clampDailyDescriptionHeight(value: number, availableHeight = 800): number {
  const usableHeight = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 800
  const maximum = maxDailyDescriptionHeight(usableHeight)
  const candidate = Number.isNaN(value) ? DEFAULT_DAILY_DESCRIPTION_HEIGHT : value
  return Math.round(Math.min(maximum, Math.max(MIN_DAILY_DESCRIPTION_HEIGHT, candidate)))
}

export function maxGitFileListWidth(availableWidth: number): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 900
  return Math.max(MIN_GIT_FILE_LIST_WIDTH, Math.round(usableWidth - MIN_GIT_DIFF_WIDTH - GIT_SPLITTER_WIDTH - GIT_WORKSPACE_GAP))
}

export function maxSidebarWidth(availableWidth: number): number {
  const usableWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 1000
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(usableWidth - MIN_EDITOR_WIDTH - SIDEBAR_SPLITTER_WIDTH)),
  )
}

export function maxDailyDescriptionHeight(availableHeight: number): number {
  const usableHeight = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 800
  return Math.max(
    MIN_DAILY_DESCRIPTION_HEIGHT,
    Math.min(
      MAX_DAILY_DESCRIPTION_HEIGHT,
      Math.round(usableHeight - MIN_CODE_CARD_HEIGHT - DAILY_DESCRIPTION_LAYOUT_OVERHEAD),
    ),
  )
}

export function maxBottomPanelHeight(): number {
  return clampBottomPanelHeight(MAX_BOTTOM_PANEL_HEIGHT)
}

export function readBottomPanelHeight(storage: Storage | undefined): number {
  const value = storage?.getItem(BOTTOM_PANEL_HEIGHT_KEY)
  const parsed = value ? Number(value) : DEFAULT_BOTTOM_PANEL_HEIGHT
  return clampBottomPanelHeight(Number.isFinite(parsed) ? parsed : DEFAULT_BOTTOM_PANEL_HEIGHT)
}

export function readGitFileListWidth(storage: Storage | undefined): number {
  const value = storage?.getItem(GIT_FILE_LIST_WIDTH_KEY)
  const parsed = value ? Number(value) : DEFAULT_GIT_FILE_LIST_WIDTH
  return clampGitFileListWidth(Number.isFinite(parsed) ? parsed : DEFAULT_GIT_FILE_LIST_WIDTH)
}

export function readSidebarWidth(storage: Storage | undefined): number {
  const value = storage?.getItem(SIDEBAR_WIDTH_KEY)
  const parsed = value ? Number(value) : DEFAULT_SIDEBAR_WIDTH
  return clampSidebarWidth(Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH)
}

export function readDailyDescriptionHeight(storage: Storage | undefined): number {
  const value = storage?.getItem(DAILY_DESCRIPTION_HEIGHT_KEY)
  const parsed = value ? Number(value) : DEFAULT_DAILY_DESCRIPTION_HEIGHT
  return clampDailyDescriptionHeight(
    Number.isFinite(parsed) ? parsed : DEFAULT_DAILY_DESCRIPTION_HEIGHT,
  )
}

export function windowHeight(): number {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight) || window.innerHeight <= 0) {
    return 800
  }
  return window.innerHeight
}

/** Returns the calendar day used by the daily-problem service (UTC). */
export function utcDateKey(value: Date | number = new Date()): string {
  const date = typeof value === 'number' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return date.toISOString().slice(0, 10)
}

/**
 * Delay until just after the next UTC midnight. The small one-second cushion
 * avoids racing the provider while its daily cache rolls over.
 */
export function nextUtcMidnightDelayMs(value: Date | number = new Date(), paddingMs = 1000): number {
  const date = typeof value === 'number' ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) {
    return 24 * 60 * 60 * 1000 + Math.max(0, paddingMs)
  }
  const nextMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return Math.max(1, nextMidnight - date.getTime() + Math.max(0, paddingMs))
}

/** Accept only a real calendar date in the provider's UTC YYYY-MM-DD format. */
export function normalizeDailyProblemDateKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(Date.UTC(2000, 0, 1))
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  return value
}

/** Accept a positive LeetCode frontend id from the problem lookup field. */
export function normalizeProblemNumber(value: string): string | null {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    return null
  }
  const withoutLeadingZeroes = normalized.replace(/^0+/, '')
  return withoutLeadingZeroes.length > 0 ? withoutLeadingZeroes : null
}

export type { SettingsSection, ShortcutPlatform, ThemeMode }

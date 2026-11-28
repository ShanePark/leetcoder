import { describe, expect, it } from 'vitest'
import { normalizeThemeMode, readThemeMode } from '../../../src/app'
import { readSidebarTab, SIDEBAR_TAB_KEY } from '../../../src/app/layout'

describe('appearance settings', () => {
  it('accepts only system, dark, and light theme modes', () => {
    expect(normalizeThemeMode('system')).toBe('system')
    expect(normalizeThemeMode('dark')).toBe('dark')
    expect(normalizeThemeMode('light')).toBe('light')
    expect(normalizeThemeMode('sepia')).toBe('dark')
    expect(normalizeThemeMode(null)).toBe('dark')
  })

  it('reads a persisted theme mode and falls back to dark', () => {
    const values = new Map<string, string>([['leetcoder.theme-mode', 'light']])
    const storage = { getItem: (key: string) => values.get(key) ?? null } as Storage
    expect(readThemeMode(storage)).toBe('light')
    expect(readThemeMode({ getItem: () => 'invalid' } as Storage)).toBe('dark')
    expect(readThemeMode(undefined)).toBe('dark')
  })
})

describe('sidebar tab', () => {
  it('reads the persisted Description tab and falls back to Problems', () => {
    const values = new Map<string, string>([[SIDEBAR_TAB_KEY, 'description']])
    const storage = { getItem: (key: string) => values.get(key) ?? null } as Storage
    expect(readSidebarTab(storage)).toBe('description')
    expect(readSidebarTab({ getItem: () => 'problems' } as unknown as Storage)).toBe('problems')
    expect(readSidebarTab({ getItem: () => 'invalid' } as unknown as Storage)).toBe('problems')
    expect(readSidebarTab(undefined)).toBe('problems')
  })
})

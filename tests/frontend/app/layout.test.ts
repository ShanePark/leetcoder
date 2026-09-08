import { describe, expect, it } from 'vitest'
import { normalizeThemeMode, readThemeMode } from '../../../src/app'

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

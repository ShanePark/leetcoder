import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDevMockStorage, isDevMockActive } from '../../../src/dev-mock'

afterEach(() => vi.unstubAllGlobals())

describe('browser preview activation', () => {
  it('requires a browser, the explicit mock parameter, and no native bridge', () => {
    vi.stubGlobal('window', undefined)
    expect(isDevMockActive()).toBe(false)
    vi.stubGlobal('window', { location: { search: '?preview=mock' } })
    expect(isDevMockActive()).toBe(false)
    vi.stubGlobal('window', { location: { search: '?mock=pass' } })
    expect(isDevMockActive()).toBe(true)
    vi.stubGlobal('window', { location: { search: '?mock' }, __TAURI_INTERNALS__: undefined })
    expect(isDevMockActive()).toBe(false)
  })
})

describe('browser preview storage', () => {
  it('seeds the existing repository key and keeps independent stores', () => {
    const store = createDevMockStorage()
    const other = createDevMockStorage()
    expect(store.length).toBe(1)
    expect(store.key(0)).toBe('leetcoder.repository-path')
    expect(store.getItem('leetcoder.repository-path')).toBe('/Users/shane/ps')
    expect(store.key(1)).toBeNull()
    expect(store.getItem('missing')).toBeNull()

    store.setItem('theme', 'dark')
    store.setItem('theme', 'light')
    expect(store.length).toBe(2)
    expect(store.key(1)).toBe('theme')
    expect(store.getItem('theme')).toBe('light')
    expect(other.getItem('theme')).toBeNull()
    store.removeItem('theme')
    expect(store.length).toBe(1)
    store.clear()
    expect(store.length).toBe(0)
    expect(other.length).toBe(1)
  })
})

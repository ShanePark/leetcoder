import { describe, expect, it } from 'vitest'

import {
  SHORTCUT_SECTIONS,
  formatShortcut,
  platformBindings,
  primaryShortcut,
  shortcutHints,
  shortcutLabel,
} from '../../src/shortcuts'

describe('shortcut formatting', () => {
  it('uses stacked glyphs on macOS and named modifiers elsewhere', () => {
    expect(formatShortcut('Shift-Mod-r', true)).toBe('⇧⌘R')
    expect(formatShortcut('Shift-Mod-r', false)).toBe('Ctrl+Shift+R')
    expect(formatShortcut('Mod-Alt-l', true)).toBe('⌘⌥L')
    expect(formatShortcut('Mod-Alt-l', false)).toBe('Ctrl+Alt+L')
  })

  it('keeps multi-character key names readable', () => {
    expect(formatShortcut('Mod-Backspace', false)).toBe('Ctrl+Backspace')
    expect(formatShortcut('Ctrl-Space', true)).toBe('⌃Space')
    expect(formatShortcut('Alt-/', false)).toBe('Alt+/')
  })

  it('orders non-macOS modifiers Ctrl, Alt, Shift regardless of how they are written', () => {
    expect(formatShortcut('Shift-Alt-j', false)).toBe('Alt+Shift+J')
    expect(formatShortcut('Shift-Alt-z', false)).toBe('Alt+Shift+Z')
    expect(formatShortcut('Shift-Alt-j', true)).toBe('⇧⌥J')
  })
})

describe('platform primary binding', () => {
  const entryFor = (description: string) => {
    const entry = SHORTCUT_SECTIONS
      .flatMap((section) => section.entries)
      .find((candidate) => candidate.description === description)
    expect(entry, description).toBeDefined()
    return entry!
  }

  it('advertises the Alt form off macOS and the Cmd form on it', () => {
    expect(primaryShortcut(entryFor('Save'), false)).toBe('Alt+S')
    expect(primaryShortcut(entryFor('Save'), true)).toBe('⌘S')
    expect(primaryShortcut(entryFor('Insert JavaDoc'), false)).toBe('Alt+Shift+J')
    expect(primaryShortcut(entryFor('Insert JavaDoc'), true)).toBe('⇧⌘J')
  })

  it('keeps the Ctrl twin listed after the Alt form', () => {
    expect(platformBindings(entryFor('Save'), false)).toEqual(['Alt-s', 'Mod-s'])
    expect(platformBindings(entryFor('Save'), true)).toEqual(['Mod-s', 'Alt-s'])
  })

  it('leaves shortcuts without a twin alone', () => {
    expect(primaryShortcut(entryFor('Reformat code'), false)).toBe('Ctrl+Alt+L')
    expect(primaryShortcut(entryFor('Complete'), false)).toBe('Ctrl+Space')
    expect(primaryShortcut(entryFor('Toggle line comment'), false)).toBe('Ctrl+/')
  })
})

describe('shortcut table', () => {
  it('lists an Alt twin for every Cmd shortcut, so both platforms match', () => {
    for (const section of SHORTCUT_SECTIONS) {
      for (const entry of section.entries) {
        const modBinding = entry.bindings.find((binding) => binding.includes('Mod-'))
        if (!modBinding || modBinding === 'Mod-/' || modBinding.includes('Mod-Alt-')) {
          // Mod-/ stays on the default keymap's comment toggle, and Mod-Alt-l
          // is already the same physical chord on both platforms.
          continue
        }
        expect(entry.bindings).toContain(modBinding.replace('Mod-', 'Alt-'))
      }
    }
  })

  it('gives every entry a unique id so labels elsewhere cannot drift', () => {
    const ids = SHORTCUT_SECTIONS.flatMap((section) => section.entries).map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(shortcutLabel('save', false)).toBe('Alt+S')
    expect(shortcutLabel('run-test-at-cursor', true)).toBe('⇧⌘R')
    expect(() => shortcutLabel('not-a-shortcut', false)).toThrow(/Unknown shortcut id/)
  })

  it('gives every entry at least one binding and a description', () => {
    for (const section of SHORTCUT_SECTIONS) {
      expect(section.entries.length).toBeGreaterThan(0)
      for (const entry of section.entries) {
        expect(entry.bindings.length).toBeGreaterThan(0)
        expect(entry.description).not.toBe('')
      }
    }
  })
})

describe('empty editor hints', () => {
  it('renders the flagged entries with their primary binding', () => {
    const hints = shortcutHints(false)
    expect(hints.length).toBeGreaterThan(0)
    expect(hints).toContainEqual(['Alt+R', 'Run test'])
    expect(shortcutHints(true)).toContainEqual(['⌘R', 'Run test'])
  })
})

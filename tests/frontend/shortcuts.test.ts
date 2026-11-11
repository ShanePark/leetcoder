import { describe, expect, it } from 'vitest'

import {
  SHORTCUT_SECTIONS,
  formatShortcut,
  isFileSearchShortcut,
  isProjectSearchShortcut,
  isSettingsShortcut,
  platformBindings,
  platformShortcutBindings,
  primaryShortcut,
  runShortcutAction,
  shortcutBindings,
  shortcutHints,
  shortcutLabel,
  workspaceShortcutAction,
  type ShortcutKeyEvent,
} from '../../src/shortcuts'

describe('shortcut formatting', () => {
  it('declares and displays shifted font-size punctuation including a minus key', () => {
    expect(shortcutBindings('increase-editor-font-size')).toEqual(['Shift-Mod-=', 'Shift-Alt-='])
    expect(shortcutBindings('decrease-editor-font-size')).toEqual(['Shift-Mod--', 'Shift-Alt--'])
    expect(shortcutLabel('increase-editor-font-size', true)).toBe('⇧⌘=')
    expect(shortcutLabel('decrease-editor-font-size', true)).toBe('⇧⌘-')
    expect(shortcutLabel('increase-editor-font-size', false)).toBe('Alt+Shift+=')
    expect(shortcutLabel('decrease-editor-font-size', false)).toBe('Alt+Shift+-')
  })
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
    expect(primaryShortcut(entryFor('Complete current statement'), false)).toBe('Alt+Shift+Enter')
    expect(primaryShortcut(entryFor('Complete current statement'), true)).toBe('⇧⌘Enter')
    expect(primaryShortcut(entryFor('Show code actions'), false)).toBe('Alt+Enter')
    expect(primaryShortcut(entryFor('Show code actions'), true)).toBe('⌘Enter')
    expect(primaryShortcut(entryFor('Move to line end'), false)).toBe('Alt+ArrowRight')
    expect(primaryShortcut(entryFor('Move to line end'), true)).toBe('⌘ArrowRight')
    expect(primaryShortcut(entryFor('Focus file search'), false)).toBe('Alt+Shift+O')
    expect(primaryShortcut(entryFor('Focus file search'), true)).toBe('⇧⌘O')
    expect(primaryShortcut(entryFor('Extract method'), false)).toBe('Ctrl+Alt+M')
    expect(primaryShortcut(entryFor('Extract method'), true)).toBe('⌘⌥M')
    expect(primaryShortcut(entryFor('Rename symbol'), false)).toBe('Shift+F6')
    expect(primaryShortcut(entryFor('Rename symbol'), true)).toBe('⇧F6')
    expect(primaryShortcut(entryFor('Expand live template / next template field'), false)).toBe('Tab')
    expect(primaryShortcut(entryFor('Expand live template / next template field'), true)).toBe('Tab')
    expect(primaryShortcut(entryFor('Finish live template'), false)).toBe('Enter')
    expect(primaryShortcut(entryFor('Finish live template'), true)).toBe('Enter')
  })

  it('shows only the app binding for the selected operating system', () => {
    expect(platformBindings(entryFor('Save'), false)).toEqual(['Alt-s'])
    expect(platformBindings(entryFor('Save'), true)).toEqual(['Mod-s'])
    expect(platformShortcutBindings('duplicate-line', false)).toEqual(['Alt-d'])
    expect(platformShortcutBindings('duplicate-line', true)).toEqual(['Mod-d'])
  })

  it('keeps platform exceptions and run chords unchanged', () => {
    expect(primaryShortcut(entryFor('Reformat code'), false)).toBe('Ctrl+Alt+L')
    expect(primaryShortcut(entryFor('Complete'), false)).toBe('Ctrl+Space')
    expect(primaryShortcut(entryFor('Toggle line comment'), false)).toBe('Alt+/')
    expect(primaryShortcut(entryFor('Run all tests'), false)).toBe('Ctrl+R')
    expect(primaryShortcut(entryFor('Run all tests'), true)).toBe('⌃R')
    expect(primaryShortcut(entryFor('Run test at cursor'), false)).toBe('Ctrl+Shift+R')
    expect(primaryShortcut(entryFor('Run test at cursor'), true)).toBe('⌃⇧R')
    expect(shortcutBindings('rename-method')).toEqual(['Shift-F6'])
  })
})

describe('shortcut table', () => {
  it('declares parameter info with platform labels and both modifier bindings', () => {
    expect(shortcutBindings('show-parameter-info')).toEqual(['Mod-p', 'Alt-p'])
    expect(shortcutLabel('show-parameter-info', true)).toBe('⌘P')
    expect(shortcutLabel('show-parameter-info', false)).toBe('Alt+P')
  })

  it('declares the Linux Alt twins for clipboard and history actions', () => {
    expect(shortcutBindings('cut-line')).toEqual(['Mod-x', 'Alt-x'])
    expect(shortcutBindings('copy')).toEqual(['Mod-c', 'Alt-c'])
    expect(shortcutBindings('paste')).toEqual(['Mod-v', 'Alt-v'])
    expect(shortcutBindings('select-all')).toEqual(['Mod-a', 'Alt-a'])
    expect(shortcutBindings('undo')).toEqual(['Mod-z', 'Alt-z'])
    expect(shortcutBindings('redo')).toEqual(['Shift-Mod-z', 'Shift-Alt-z'])
  })

  it('lists an Alt twin for every Cmd shortcut, so both platforms match', () => {
    for (const section of SHORTCUT_SECTIONS) {
      for (const entry of section.entries) {
        const modBinding = entry.bindings.find((binding) => binding.includes('Mod-'))
        if (!modBinding || modBinding.includes('Mod-Alt-')) {
          // Mod-Alt-* chords are intentionally identical on both
          // platforms, so adding a second Alt modifier would be ambiguous.
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
    expect(shortcutLabel('run-test-at-cursor', true)).toBe('⌃⇧R')
    expect(shortcutLabel('run-test', false)).toBe('Ctrl+R')
    expect(shortcutLabel('complete-statement', false)).toBe('Alt+Shift+Enter')
    expect(shortcutLabel('show-intentions', false)).toBe('Alt+Enter')
    expect(shortcutLabel('show-intentions', true)).toBe('⌘Enter')
    expect(shortcutLabel('move-to-line-end', true)).toBe('⌘ArrowRight')
    expect(shortcutLabel('move-line-up', false)).toBe('Alt+Shift+ArrowUp')
    expect(shortcutLabel('move-line-down', true)).toBe('⇧⌘ArrowDown')
    expect(shortcutLabel('toggle-comment', false)).toBe('Alt+/')
    expect(shortcutLabel('show-shortcuts', false)).toBe('Alt+Shift+/')
    expect(shortcutLabel('open-settings', false)).toBe('Alt+,')
    expect(shortcutLabel('open-settings', true)).toBe('⌘,')
    expect(shortcutLabel('focus-file-search', false)).toBe('Alt+Shift+O')
    expect(shortcutLabel('focus-file-search', true)).toBe('⇧⌘O')
    expect(shortcutLabel('search-project', false)).toBe('Alt+Shift+F')
    expect(shortcutLabel('search-project', true)).toBe('⇧⌘F')
    expect(shortcutLabel('extract-method', false)).toBe('Ctrl+Alt+M')
    expect(shortcutLabel('extract-method', true)).toBe('⌘⌥M')
    expect(shortcutLabel('inline-field', false)).toBe('Ctrl+Alt+N')
    expect(shortcutLabel('inline-field', true)).toBe('⌘⌥N')
    expect(shortcutBindings('inline-field')).toEqual(['Mod-Alt-n'])
    expect(platformShortcutBindings('inline-field', false)).toEqual(['Mod-Alt-n'])
    expect(platformShortcutBindings('inline-field', true)).toEqual(['Mod-Alt-n'])
    expect(shortcutLabel('rename-method', false)).toBe('Shift+F6')
    expect(shortcutLabel('rename-method', true)).toBe('⇧F6')
    expect(shortcutLabel('expand-template', false)).toBe('Tab')
    expect(shortcutLabel('finish-template', false)).toBe('Enter')
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

describe('settings shortcut matching', () => {
  const base: ShortcutKeyEvent = {
    key: ',',
    code: 'Comma',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  }

  it('matches the platform primary modifier and physical Linux comma key', () => {
    expect(isSettingsShortcut({ ...base, altKey: true }, false)).toBe(true)
    expect(isSettingsShortcut({ ...base, key: '‚', altKey: true }, false)).toBe(true)
    expect(isSettingsShortcut({ ...base, metaKey: true }, true)).toBe(true)
  })

  it('rejects settings chords with the wrong platform or extra modifiers', () => {
    expect(isSettingsShortcut({ ...base, altKey: true }, true)).toBe(false)
    expect(isSettingsShortcut({ ...base, metaKey: true }, false)).toBe(false)
    expect(isSettingsShortcut({ ...base, altKey: true, shiftKey: true }, false)).toBe(false)
    expect(isSettingsShortcut({ ...base, altKey: true, ctrlKey: true }, false)).toBe(false)
  })
})

describe('file search shortcut matching', () => {
  const base: ShortcutKeyEvent = {
    key: 'o',
    code: 'KeyO',
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  }

  it('matches the platform primary modifier', () => {
    expect(isFileSearchShortcut({ ...base, altKey: true }, false)).toBe(true)
    expect(isFileSearchShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isFileSearchShortcut({ ...base, key: 'ø', altKey: true }, false)).toBe(true)
  })

  it('rejects the wrong platform and extra modifiers', () => {
    expect(isFileSearchShortcut({ ...base, altKey: true }, true)).toBe(false)
    expect(isFileSearchShortcut({ ...base, metaKey: true }, false)).toBe(false)
    expect(isFileSearchShortcut({ ...base, altKey: true, ctrlKey: true }, false)).toBe(false)
    expect(isFileSearchShortcut({ ...base, altKey: true, shiftKey: false }, false)).toBe(false)
  })
})

describe('project search shortcut matching', () => {
  const base: ShortcutKeyEvent = {
    key: 'f',
    code: 'KeyF',
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  }

  it('matches the platform primary modifier and the physical Alt-letter form', () => {
    expect(shortcutBindings('search-project')).toEqual(['Shift-Mod-f', 'Shift-Alt-f'])
    expect(isProjectSearchShortcut({ ...base, altKey: true }, false)).toBe(true)
    expect(isProjectSearchShortcut({ ...base, ctrlKey: true }, false)).toBe(true)
    expect(isProjectSearchShortcut({ ...base, metaKey: true }, true)).toBe(true)
    expect(isProjectSearchShortcut({ ...base, altKey: true }, true)).toBe(true)
    expect(isProjectSearchShortcut({ ...base, key: 'ƒ', altKey: true }, false)).toBe(true)
  })

  it('rejects the wrong Mod form and extra modifiers', () => {
    expect(isProjectSearchShortcut({ ...base, metaKey: true }, false)).toBe(false)
    expect(isProjectSearchShortcut({ ...base, ctrlKey: true }, true)).toBe(false)
    expect(isProjectSearchShortcut({ ...base, altKey: true, ctrlKey: true }, false)).toBe(false)
    expect(isProjectSearchShortcut({ ...base, altKey: true, shiftKey: false }, false)).toBe(false)
  })
})

describe('run shortcut matching', () => {
  const ctrlR: ShortcutKeyEvent = {
    key: 'r',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: true,
  }

  it('uses the declared bindings for the selected test and full run', () => {
    expect(shortcutBindings('run-test')).toEqual(['Ctrl-r'])
    expect(shortcutBindings('run-test-at-cursor')).toEqual(['Ctrl-Shift-r'])
    expect(runShortcutAction(ctrlR)).toBe('run-test')
    expect(runShortcutAction({ ...ctrlR, shiftKey: true })).toBe('run-test-at-cursor')
  })

  it('rejects Alt, Meta, missing Ctrl, and unexpected modifiers', () => {
    expect(runShortcutAction({ ...ctrlR, altKey: true })).toBeNull()
    expect(runShortcutAction({ ...ctrlR, metaKey: true })).toBeNull()
    expect(runShortcutAction({ ...ctrlR, ctrlKey: false })).toBeNull()
    expect(runShortcutAction({ ...ctrlR, shiftKey: true, altKey: true })).toBeNull()
    expect(runShortcutAction({ ...ctrlR, shiftKey: true, metaKey: true })).toBeNull()
    expect(runShortcutAction({ ...ctrlR, key: 's' })).toBeNull()
  })

  it('does not use the physical letter fallback for non-Alt chords', () => {
    expect(runShortcutAction({ ...ctrlR, key: 'ř', code: 'KeyR' })).toBeNull()
  })
})

describe('empty editor hints', () => {
  it('renders the flagged entries with their primary binding', () => {
    const hints = shortcutHints(false)
    expect(hints.length).toBeGreaterThan(0)
    expect(hints).toContainEqual(['Ctrl+R', 'Run all tests'])
    expect(hints).toContainEqual(['Ctrl+Shift+R', 'Run test at cursor'])
    expect(shortcutHints(true)).toContainEqual(['⌃R', 'Run all tests'])
    expect(shortcutHints(true)).toContainEqual(['⌃⇧R', 'Run test at cursor'])
  })
})

describe('workspace shortcut table', () => {
  it('declares the tool-window and Git chords with platform labels', () => {
    expect(shortcutBindings('toggle-sidebar')).toEqual(['Mod-1', 'Alt-1'])
    expect(shortcutBindings('show-tests-panel')).toEqual(['Mod-4', 'Alt-4'])
    expect(shortcutBindings('show-git-panel')).toEqual(['Mod-9', 'Alt-9'])
    expect(shortcutBindings('git-commit')).toEqual(['Mod-k', 'Alt-k'])
    expect(shortcutBindings('git-commit-push')).toEqual(['Mod-Alt-k'])
    expect(shortcutLabel('toggle-sidebar', true)).toBe('⌘1')
    expect(shortcutLabel('toggle-sidebar', false)).toBe('Alt+1')
    expect(shortcutLabel('show-tests-panel', true)).toBe('⌘4')
    expect(shortcutLabel('show-tests-panel', false)).toBe('Alt+4')
    expect(shortcutLabel('show-git-panel', true)).toBe('⌘9')
    expect(shortcutLabel('show-git-panel', false)).toBe('Alt+9')
    expect(shortcutLabel('git-commit', true)).toBe('⌘K')
    expect(shortcutLabel('git-commit', false)).toBe('Alt+K')
    expect(shortcutLabel('git-commit-push', true)).toBe('⌘⌥K')
    expect(shortcutLabel('git-commit-push', false)).toBe('Ctrl+Alt+K')
    expect(platformShortcutBindings('git-commit-push', false)).toEqual(['Mod-Alt-k'])
    expect(platformShortcutBindings('git-commit-push', true)).toEqual(['Mod-Alt-k'])
  })

  it('lists the new chords in the shortcut sections', () => {
    const sections = new Map(SHORTCUT_SECTIONS.map((section) => [
      section.title,
      section.entries.map((entry) => entry.id),
    ]))
    expect(sections.get('Tool windows')).toEqual(['toggle-sidebar', 'show-tests-panel', 'show-git-panel'])
    expect(sections.get('Git')).toEqual(['git-commit', 'git-commit-push'])
  })
})

describe('workspace shortcut matching', () => {
  const none: ShortcutKeyEvent = {
    key: '',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
  }

  it('matches Alt digits and K on Linux, including on their physical codes', () => {
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', altKey: true }, false)).toBe('toggle-sidebar')
    expect(workspaceShortcutAction({ ...none, key: '4', code: 'Digit4', altKey: true }, false)).toBe('show-tests-panel')
    expect(workspaceShortcutAction({ ...none, key: '9', code: 'Digit9', altKey: true }, false)).toBe('show-git-panel')
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', altKey: true }, false)).toBe('git-commit')
    // Layouts that need Shift for digits, or compose Alt+key, still match by code.
    expect(workspaceShortcutAction({ ...none, key: '&', code: 'Digit1', altKey: true }, false)).toBe('toggle-sidebar')
    expect(workspaceShortcutAction({ ...none, key: 'ĸ', code: 'KeyK', altKey: true }, false)).toBe('git-commit')
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', altKey: true, ctrlKey: true }, false))
      .toBe('git-commit-push')
  })

  it('matches Cmd digits and K on macOS, and Cmd+Option+K when Option composes a glyph', () => {
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', metaKey: true }, true)).toBe('toggle-sidebar')
    expect(workspaceShortcutAction({ ...none, key: '4', code: 'Digit4', metaKey: true }, true)).toBe('show-tests-panel')
    expect(workspaceShortcutAction({ ...none, key: '9', code: 'Digit9', metaKey: true }, true)).toBe('show-git-panel')
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', metaKey: true }, true)).toBe('git-commit')
    expect(workspaceShortcutAction({ ...none, key: '˚', code: 'KeyK', metaKey: true, altKey: true }, true))
      .toBe('git-commit-push')
  })

  it('rejects the other platform, extra modifiers, and other keys', () => {
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', altKey: true }, true)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: '¡', code: 'Digit1', altKey: true }, true)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', metaKey: true }, false)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', ctrlKey: true }, false)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: '1', code: 'Digit1', altKey: true, shiftKey: true }, false)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', ctrlKey: true }, false)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', metaKey: true, altKey: true }, false)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }, true)).toBeNull()
    expect(workspaceShortcutAction({ ...none, key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, shiftKey: true }, false))
      .toBeNull()
    expect(workspaceShortcutAction({ ...none, key: '2', code: 'Digit2', altKey: true }, false)).toBeNull()
    // The physical-code fallback is only for Alt chords.
    expect(workspaceShortcutAction({ ...none, key: '&', code: 'Digit1', metaKey: true }, true)).toBeNull()
  })
})

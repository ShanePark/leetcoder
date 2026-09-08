import { describe, expect, it } from 'vitest'
import {
  isCopyAltShortcut,
  isExtractMethodShortcut,
  isLineCutAltShortcut,
  isMoveLineDownAltShortcut,
  isMoveLineUpAltShortcut,
  isPasteAltShortcut,
  isRedoAltShortcut,
  isReformatShortcut,
  isSaveAltShortcut,
  isSelectAllAltShortcut,
  isSettingsAltShortcut,
  isShortcutHelpAltShortcut,
  isToggleCommentAltShortcut,
  isUndoAltShortcut,
} from '../../../src/editor'

describe('Option shortcut matchers', () => {
  const base = { shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }

  it('matches the clipboard, comment, save, settings, and shortcut-list forms on their physical keys', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX' })).toBe(true)
    expect(isCopyAltShortcut({ ...base, code: 'KeyC' })).toBe(true)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV' })).toBe(true)
    expect(isSelectAllAltShortcut({ ...base, code: 'KeyA' })).toBe(true)
    expect(isToggleCommentAltShortcut({ ...base, code: 'Slash' })).toBe(true)
    expect(isSaveAltShortcut({ ...base, code: 'KeyS' })).toBe(true)
    expect(isSettingsAltShortcut({ ...base, code: 'Comma' })).toBe(true)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash', shiftKey: true })).toBe(true)
    expect(isLineCutAltShortcut({ ...base, code: 'KeyV' })).toBe(false)
  })

  it('ignores the same keys with extra modifiers', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX', metaKey: true })).toBe(false)
    expect(isCopyAltShortcut({ ...base, code: 'KeyC', ctrlKey: true })).toBe(false)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV', shiftKey: true })).toBe(false)
    expect(isSelectAllAltShortcut({ ...base, code: 'KeyA', metaKey: true })).toBe(false)
    expect(isToggleCommentAltShortcut({ ...base, code: 'Slash', shiftKey: true })).toBe(false)
    expect(isSaveAltShortcut({ ...base, code: 'KeyS', ctrlKey: true })).toBe(false)
    expect(isSettingsAltShortcut({ ...base, code: 'Comma', shiftKey: true })).toBe(false)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash' })).toBe(false)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash', shiftKey: true, ctrlKey: true })).toBe(false)
  })

  it('separates undo from redo by the Shift modifier', () => {
    expect(isUndoAltShortcut({ ...base, code: 'KeyZ' })).toBe(true)
    expect(isUndoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true })).toBe(false)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true })).toBe(true)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ' })).toBe(false)
    expect(isRedoAltShortcut({ ...base, code: 'KeyZ', shiftKey: true, metaKey: true })).toBe(false)
  })

  it('matches line movement without falling through to the default line-copy chord', () => {
    expect(isMoveLineUpAltShortcut({ ...base, code: 'ArrowUp', shiftKey: true })).toBe(true)
    expect(isMoveLineDownAltShortcut({ ...base, code: 'ArrowDown', shiftKey: true })).toBe(true)
    expect(isMoveLineUpAltShortcut({ ...base, code: 'ArrowUp' })).toBe(false)
    expect(isMoveLineDownAltShortcut({ ...base, code: 'ArrowDown', shiftKey: true, ctrlKey: true })).toBe(false)
  })

  it('matches reformat on either primary modifier but not on Alt alone', () => {
    expect(isReformatShortcut({ ...base, code: 'KeyL', metaKey: true })).toBe(true)
    expect(isReformatShortcut({ ...base, code: 'KeyL', ctrlKey: true })).toBe(true)
    expect(isReformatShortcut({ ...base, code: 'KeyL' })).toBe(false)
    expect(isReformatShortcut({ ...base, code: 'KeyL', metaKey: true, shiftKey: true })).toBe(false)
  })

  it('matches method extraction on the physical M key for both primary modifiers', () => {
    expect(isExtractMethodShortcut({ ...base, code: 'KeyM', metaKey: true })).toBe(true)
    expect(isExtractMethodShortcut({ ...base, code: 'KeyM', ctrlKey: true })).toBe(true)
    expect(isExtractMethodShortcut({ ...base, code: 'KeyM' })).toBe(false)
    expect(isExtractMethodShortcut({ ...base, code: 'KeyM', metaKey: true, ctrlKey: true })).toBe(false)
    expect(isExtractMethodShortcut({ ...base, code: 'KeyM', metaKey: true, shiftKey: true })).toBe(false)
    expect(isExtractMethodShortcut({ ...base, code: 'KeyV', metaKey: true })).toBe(false)
  })
})

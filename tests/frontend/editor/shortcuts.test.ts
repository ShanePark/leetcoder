import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JavaEditor,
  isFontSizeShortcut,
  isIncreaseFontSizeAltShortcut,
  isDecreaseFontSizeAltShortcut,
  isCopyAltShortcut,
  isExtractMethodShortcut,
  isInlineFieldShortcut,
  isFileSearchAltShortcut,
  isProjectSearchAltShortcut,
  isLineCutAltShortcut,
  isMoveLineDownAltShortcut,
  isMoveLineUpAltShortcut,
  isPasteAltShortcut,
  isRedoAltShortcut,
  isReformatShortcut,
  isSaveAltShortcut,
  isSelectAllAltShortcut,
  isShowIntentionsAltShortcut,
  isParameterInfoAltShortcut,
  isSettingsAltShortcut,
  isShortcutHelpAltShortcut,
  isToggleCommentAltShortcut,
  isUndoAltShortcut,
} from '../../../src/editor'

// CodeMirror resolves Mod from the platform at import time, before test stubs.
const primaryModifier = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? 'metaKey' : 'ctrlKey'

const parameterInfoMocks = vi.hoisted(() => ({
  show: vi.fn(() => true),
  create: vi.fn(),
  handlers: [] as Array<{ keydown?: (event: KeyboardEvent, view: EditorView) => boolean }>,
}))

vi.mock('../../../src/editor/parameter-info', () => ({
  createJavaParameterInfo: (request: unknown) => {
    parameterInfoMocks.create(request)
    return { extension: [], show: parameterInfoMocks.show }
  },
}))

// Verify the editor's actual keymap composition without browser layout.
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>()
  class StateOnlyEditorView {
    state: EditorState
    constructor(options: { state: EditorState }) { this.state = options.state }
    dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state }
    static domEventHandlers(handlers: Parameters<typeof original.EditorView.domEventHandlers>[0]) {
      parameterInfoMocks.handlers.push(handlers)
      return original.EditorView.domEventHandlers(handlers)
    }
  }
  Object.setPrototypeOf(StateOnlyEditorView, original.EditorView)
  return { ...original, EditorView: StateOnlyEditorView }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  parameterInfoMocks.handlers.length = 0
})

describe('Option shortcut matchers', () => {
  const base = { shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }

  it('matches parameter info by physical P and rejects additional modifiers', () => {
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyP' })).toBe(true)
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyO' })).toBe(false)
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyP', altKey: false })).toBe(false)
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyP', shiftKey: true })).toBe(false)
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyP', ctrlKey: true })).toBe(false)
    expect(isParameterInfoAltShortcut({ ...base, code: 'KeyP', metaKey: true })).toBe(false)
  })

  it('matches font controls on shifted physical punctuation without accepting extra modifiers', () => {
    expect(isIncreaseFontSizeAltShortcut({ ...base, code: 'Equal', shiftKey: true })).toBe(true)
    expect(isDecreaseFontSizeAltShortcut({ ...base, code: 'Minus', shiftKey: true })).toBe(true)
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      const event = { code: 'Equal', shiftKey: true, altKey: false, metaKey: false, ctrlKey: false, [modifier]: true }
      const mac = modifier === 'metaKey'
      expect(isFontSizeShortcut(event, 'Equal', mac)).toBe(true)
      expect(isFontSizeShortcut({ ...event, shiftKey: false }, 'Equal', mac)).toBe(false)
      expect(isFontSizeShortcut({ ...event, code: 'Minus' }, 'Equal', mac)).toBe(false)
      if (modifier !== 'altKey') expect(isFontSizeShortcut(event, 'Equal', !mac)).toBe(false)
    }
    expect(isIncreaseFontSizeAltShortcut({ ...base, code: 'Equal', shiftKey: true, metaKey: true })).toBe(false)
  })

  it('matches the clipboard, comment, save, settings, and shortcut-list forms on their physical keys', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX' })).toBe(true)
    expect(isCopyAltShortcut({ ...base, code: 'KeyC' })).toBe(true)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV' })).toBe(true)
    expect(isSelectAllAltShortcut({ ...base, code: 'KeyA' })).toBe(true)
    expect(isToggleCommentAltShortcut({ ...base, code: 'Slash' })).toBe(true)
    expect(isSaveAltShortcut({ ...base, code: 'KeyS' })).toBe(true)
    expect(isSettingsAltShortcut({ ...base, code: 'Comma' })).toBe(true)
    expect(isFileSearchAltShortcut({ ...base, code: 'KeyO', shiftKey: true })).toBe(true)
    expect(isProjectSearchAltShortcut({ ...base, code: 'KeyF', shiftKey: true })).toBe(true)
    expect(isShortcutHelpAltShortcut({ ...base, code: 'Slash', shiftKey: true })).toBe(true)
    expect(isLineCutAltShortcut({ ...base, code: 'KeyV' })).toBe(false)
  })

  it('matches the plain Option+Enter intentions shortcut by physical key', () => {
    expect(isShowIntentionsAltShortcut({ ...base, code: 'Enter' })).toBe(true)
    expect(isShowIntentionsAltShortcut({ ...base, code: 'NumpadEnter' })).toBe(false)
    expect(isShowIntentionsAltShortcut({ ...base, code: 'Enter', shiftKey: true })).toBe(false)
    expect(isShowIntentionsAltShortcut({ ...base, code: 'Enter', metaKey: true })).toBe(false)
    expect(isShowIntentionsAltShortcut({ ...base, code: 'Enter', ctrlKey: true })).toBe(false)
  })

  it('ignores the same keys with extra modifiers', () => {
    expect(isLineCutAltShortcut({ ...base, code: 'KeyX', metaKey: true })).toBe(false)
    expect(isCopyAltShortcut({ ...base, code: 'KeyC', ctrlKey: true })).toBe(false)
    expect(isPasteAltShortcut({ ...base, code: 'KeyV', shiftKey: true })).toBe(false)
    expect(isSelectAllAltShortcut({ ...base, code: 'KeyA', metaKey: true })).toBe(false)
    expect(isToggleCommentAltShortcut({ ...base, code: 'Slash', shiftKey: true })).toBe(false)
    expect(isSaveAltShortcut({ ...base, code: 'KeyS', ctrlKey: true })).toBe(false)
    expect(isSettingsAltShortcut({ ...base, code: 'Comma', shiftKey: true })).toBe(false)
    expect(isFileSearchAltShortcut({ ...base, code: 'KeyO' })).toBe(false)
    expect(isProjectSearchAltShortcut({ ...base, code: 'KeyF' })).toBe(false)
    expect(isFileSearchAltShortcut({ ...base, code: 'KeyO', shiftKey: true, metaKey: true })).toBe(false)
    expect(isProjectSearchAltShortcut({ ...base, code: 'KeyF', shiftKey: true, metaKey: true })).toBe(false)
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

describe('parameter info shortcut integration', () => {
  it.each([false, true])('registers both bindings and physical Alt+P on macOS=%s', (mac) => {
    vi.stubGlobal('navigator', { platform: mac ? 'MacIntel' : 'Linux', userAgent: '' })
    const requestJavaTypeMembers = vi.fn()
    const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement, { requestJavaTypeMembers })
    expect(parameterInfoMocks.create).toHaveBeenCalledWith(requestJavaTypeMembers)
    const keys = editor.view.state.facet(keymap).flat().map((binding) => binding.key)
    expect(keys).toContain('Mod-p')
    expect(keys).toContain('Alt-p')
    const event = {
      key: 'π', code: 'KeyP', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent
    expect(parameterInfoMocks.handlers.some((handlers) => handlers.keydown?.(event, editor.view))).toBe(true)
    expect(parameterInfoMocks.show).toHaveBeenCalledWith(editor.view)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it.each(['altKey', primaryModifier] as const)('runs parameter info for the platform %s chord', (modifier) => {
    const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement)
    const event = {
      key: 'p', keyCode: 80, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
      [modifier]: true,
    } as KeyboardEvent
    expect(runScopeHandlers(editor.view, event, 'editor')).toBe(true)
    expect(parameterInfoMocks.show).toHaveBeenCalledWith(editor.view)
  })
})

describe('Inline Field shortcut', () => {
  const event = { code: 'KeyN', key: '˜', altKey: true, shiftKey: false, metaKey: true, ctrlKey: false }

  it('matches the physical N key even when Option produces a composed glyph', () => {
    expect(isInlineFieldShortcut(event)).toBe(true)
    expect(isInlineFieldShortcut({ ...event, metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('requires Alt and exactly one primary modifier without Shift', () => {
    expect(isInlineFieldShortcut({ ...event, metaKey: false })).toBe(false)
    expect(isInlineFieldShortcut({ ...event, altKey: false })).toBe(false)
    expect(isInlineFieldShortcut({ ...event, ctrlKey: true })).toBe(false)
    expect(isInlineFieldShortcut({ ...event, shiftKey: true })).toBe(false)
    expect(isInlineFieldShortcut({ ...event, code: 'KeyM' })).toBe(false)
  })
})

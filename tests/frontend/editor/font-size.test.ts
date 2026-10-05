import { history, undo } from '@codemirror/commands'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers, type PluginValue, type ViewUpdate } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorFontSizeControls, EDITOR_FONT_SIZE_KEY } from '../../../src/editor/font-size'
import { shortcutBindings } from '../../../src/shortcuts'
import { JavaEditor } from '../../../src/editor'

const pluginFactories = vi.hoisted(() => new Map<unknown, (view: EditorView) => PluginValue>())

// Exercise constructor composition without a browser layout engine.
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>()
  class StateOnlyEditorView {
    state: EditorState
    constructor(options: { state: EditorState }) { this.state = options.state }
    dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state }
  }
  Object.setPrototypeOf(StateOnlyEditorView, original.EditorView)
  const ViewPlugin = new Proxy(original.ViewPlugin, {
    get(target, property, receiver) {
      if (property === 'define') return (create: (view: EditorView) => PluginValue, spec?: unknown) => {
        const plugin = original.ViewPlugin.define(create, spec as never)
        pluginFactories.set(plugin, create)
        return plugin
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { ...original, EditorView: StateOnlyEditorView, ViewPlugin }
})

function harness(mac = false, value: string | null = null) {
  const storage = { getItem: vi.fn(() => value), setItem: vi.fn() }
  const controls = createEditorFontSizeControls(mac, storage)
  let state = EditorState.create({
    doc: 'class Solution {}',
    selection: { anchor: 6 },
    extensions: [controls.extension, history(), keymap.of([
      ...shortcutBindings('increase-editor-font-size').map((key) => ({ key, run: controls.increase })),
      ...shortcutBindings('decrease-editor-font-size').map((key) => ({ key, run: controls.decrease })),
    ])],
  })
  const view = {
    get state() { return state },
    dispatch: (spec: TransactionSpec) => { state = state.update(spec).state },
  } as unknown as EditorView
  return { controls, storage, view }
}

function wheel(fields: Partial<WheelEvent> = {}): WheelEvent {
  return { deltaY: -40, deltaX: 0, deltaMode: 0, altKey: false, metaKey: false, ctrlKey: false,
    shiftKey: false, preventDefault: vi.fn(), ...fields } as unknown as WheelEvent
}

describe('editor font size', () => {
  afterEach(() => { vi.useRealTimers() })

  it.each([
    [true, true, 10],
    [true, false, 40],
    [false, false, 100],
  ] as const)('changes by movement quantity regardless of packet splitting (mac=%s, magnification=%s)', (mac, magnification, total) => {
    const single = harness(mac, '8')
    const split = harness(mac, '8')
    const modifiers = magnification ? { ctrlKey: true } : mac ? { metaKey: true } : { altKey: true }
    single.controls.handleWheel(wheel({ ...modifiers, deltaY: -total }), single.view, magnification)
    for (let turn = 0; turn < 3; turn++) {
      for (let packet = 0; packet < 14; packet++) {
        expect(split.controls.handleWheel(wheel({ ...modifiers, deltaY: -total / 14 }), split.view, magnification)).toBe(true)
        expect(split.controls.readSize(split.view.state)).toBeLessThanOrEqual(9 + turn)
      }
      expect(split.controls.readSize(split.view.state)).toBe(9 + turn)
    }
    expect(single.controls.readSize(single.view.state)).toBe(9)
    expect(split.storage.setItem).toHaveBeenCalledTimes(3)
    expect(split.view.state.doc.toString()).toBe('class Solution {}')
    expect(split.view.state.selection.main.head).toBe(6)
    expect(undo(split.view)).toBe(false)
  })

  it.each([[1, 3], [2, 1]])('normalizes line and page units (mode=%s)', (deltaMode, delta) => {
    const { controls, view } = harness(true)
    controls.handleWheel(wheel({ metaKey: true, deltaMode, deltaY: -delta }), view)
    expect(controls.readSize(view.state)).toBe(15)
    controls.handleWheel(wheel({ metaKey: true, deltaMode, deltaY: delta }), view)
    expect(controls.readSize(view.state)).toBe(14)
  })

  it('clears unfinished wheel movements on reversal, ordinary input, invalid input, and keyboard commands', () => {
    const { controls, view, storage } = harness(true)
    const magnify = (deltaY: number) => controls.handleWheel(wheel({ ctrlKey: true, deltaY }), view, true)
    magnify(-9)
    expect(controls.readSize(view.state)).toBe(14)
    expect(storage.setItem).not.toHaveBeenCalled()
    controls.handleWheel(wheel(), view)
    magnify(-1)
    expect(controls.readSize(view.state)).toBe(14)
    controls.handleWheel(wheel({ metaKey: true, deltaY: NaN }), view)
    magnify(-9)
    expect(controls.readSize(view.state)).toBe(14)
    controls.increase(view)
    expect(controls.readSize(view.state)).toBe(15)
    magnify(-9)
    expect(controls.readSize(view.state)).toBe(15)
    magnify(1)
    magnify(9)
    expect(controls.readSize(view.state)).toBe(14)
  })

  it('handles either wheel axis whether Cmd is pressed before or during scrolling', () => {
    vi.useFakeTimers()
    const storage = { getItem: () => null, setItem: vi.fn() }
    const controls = createEditorFontSizeControls(true, storage)
    const source = 'class Solution {}'
    let state = EditorState.create({ doc: source, selection: { anchor: 6 }, extensions: [controls.extension, history()] })
    const indicator = { className: '', textContent: '', hidden: false, setAttribute: vi.fn(), remove: vi.fn() }
    const wheelListeners = new Map<string, (event: WheelEvent) => void>()
    const keyListeners = new Map<string, (event: KeyboardEvent) => void>()
    const dom = {
      ownerDocument: {
        createElement: () => indicator,
        defaultView: {
          addEventListener: (name: string, handler: (event: KeyboardEvent) => void) => { keyListeners.set(name, handler) },
          removeEventListener: (name: string) => { keyListeners.delete(name) },
        },
      },
      append: vi.fn(),
      addEventListener: (name: string, handler: (event: WheelEvent) => void) => { wheelListeners.set(name, handler) },
      removeEventListener: (name: string) => { wheelListeners.delete(name) },
    }
    let plugin: PluginValue
    const view = { dom, get state() { return state }, dispatch(spec: TransactionSpec) {
      const transaction = state.update(spec)
      state = transaction.state
      plugin.update?.({ state, transactions: [transaction] } as ViewUpdate)
    } } as unknown as EditorView
    plugin = pluginFactories.get(controls.extension.find((item) => pluginFactories.has(item)))!(view)
    const sendWheel = (fields: Partial<WheelEvent>) => {
      const event = wheel({ stopPropagation: vi.fn(), ...fields })
      wheelListeners.get('wheel')!(event)
      return event
    }
    const cmd = { key: 'Meta', metaKey: true, altKey: false, ctrlKey: false, shiftKey: false } as KeyboardEvent

    keyListeners.get('keydown')!(cmd)
    expect(sendWheel({ deltaX: -40, deltaY: 0 }).preventDefault).toHaveBeenCalledOnce()
    expect(controls.readSize(state)).toBe(15)
    expect(indicator.textContent).toBe('15px')
    expect(indicator.hidden).toBe(false)
    sendWheel({ deltaX: 40, deltaY: -1 })
    expect(controls.readSize(state)).toBe(14)

    keyListeners.get('keyup')!({ ...cmd, metaKey: false })
    expect(sendWheel({ deltaX: -20, deltaY: 0 }).preventDefault).not.toHaveBeenCalled()
    expect(sendWheel({ deltaY: -20 }).preventDefault).not.toHaveBeenCalled()
    keyListeners.get('keydown')!(cmd)
    sendWheel({ deltaY: -40 })
    sendWheel({ deltaX: -40, deltaY: 1 })
    expect(controls.readSize(state)).toBe(16)
    expect(indicator.textContent).toBe('16px')
    expect(storage.setItem).toHaveBeenLastCalledWith(EDITOR_FONT_SIZE_KEY, '16')
    expect(state.doc.toString()).toBe(source)
    expect(state.selection.main.head).toBe(6)
    expect(undo(view)).toBe(false)
    plugin.destroy?.()
  })

  it('handles wheel over the editor root and updates, retriggers, hides, and removes its size indicator', () => {
    vi.useFakeTimers()
    const controls = createEditorFontSizeControls(true)
    let state = EditorState.create({ doc: 'class Solution {}', extensions: controls.extension })
    const indicator = { className: '', textContent: '', hidden: false, setAttribute: vi.fn(), remove: vi.fn() }
    const listeners = new Map<string, (event: WheelEvent) => void>()
    const windowListeners = new Map<string, (event: KeyboardEvent) => void>()
    const window = {
      addEventListener: vi.fn((name: string, listener: (event: KeyboardEvent) => void) => { windowListeners.set(name, listener) }),
      removeEventListener: vi.fn((name: string) => { windowListeners.delete(name) }),
    }
    const dom = {
      ownerDocument: { createElement: vi.fn(() => indicator), defaultView: window },
      append: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: WheelEvent) => void) => { listeners.set(name, listener) }),
      removeEventListener: vi.fn((name: string) => { listeners.delete(name) }),
    }
    let plugin: PluginValue
    const view = {
      dom,
      get state() { return state },
      dispatch(spec: TransactionSpec) {
        const transaction = state.update(spec)
        state = transaction.state
        plugin.update?.({ state, transactions: [transaction] } as ViewUpdate)
      },
    } as unknown as EditorView
    const extension = controls.extension.find((item) => pluginFactories.has(item))
    plugin = pluginFactories.get(extension)!(view)
    expect(dom.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { capture: true, passive: false })
    expect(dom.append).toHaveBeenCalledWith(indicator)
    expect(indicator.hidden).toBe(true)
    expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(window.addEventListener).toHaveBeenCalledWith('keyup', expect.any(Function), true)
    expect(window.addEventListener).toHaveBeenCalledWith('blur', expect.any(Function))

    for (const target of [{ className: 'cm-gutters' }, { className: 'cm-scroller' }]) {
      const event = wheel({ metaKey: true, target: target as unknown as EventTarget, stopPropagation: vi.fn() })
      listeners.get('wheel')!(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(event.stopPropagation).toHaveBeenCalledOnce()
    }
    expect(controls.readSize(state)).toBe(16)
    expect(indicator.textContent).toBe('16px')
    expect(indicator.hidden).toBe(false)

    vi.advanceTimersByTime(1000)
    controls.decrease(view)
    expect(indicator.textContent).toBe('15px')
    vi.advanceTimersByTime(1199)
    expect(indicator.hidden).toBe(false)
    vi.advanceTimersByTime(1)
    expect(indicator.hidden).toBe(true)

    const ordinary = wheel({ stopPropagation: vi.fn() })
    listeners.get('wheel')!(ordinary)
    expect(ordinary.preventDefault).not.toHaveBeenCalled()
    expect(ordinary.stopPropagation).not.toHaveBeenCalled()

    const keyEvent = (fields: Partial<KeyboardEvent> = {}) => ({ key: 'Meta', metaKey: true,
      altKey: false, ctrlKey: false, shiftKey: false, ...fields } as KeyboardEvent)
    windowListeners.get('keydown')!(keyEvent())
    const unflaggedWheel = wheel({ stopPropagation: vi.fn() })
    listeners.get('wheel')!(unflaggedWheel)
    expect(unflaggedWheel.preventDefault).toHaveBeenCalledOnce()
    expect(controls.readSize(state)).toBe(16)
    expect(indicator.textContent).toBe('16px')
    expect(indicator.hidden).toBe(false)

    const subthresholdWheel = wheel({ ctrlKey: true, deltaY: -9, stopPropagation: vi.fn() })
    listeners.get('wheel')!(subthresholdWheel)
    expect(subthresholdWheel.preventDefault).toHaveBeenCalledOnce()
    expect(controls.readSize(state)).toBe(16)
    expect(indicator.textContent).toBe('16px')
    expect(indicator.hidden).toBe(false)
    const magnifyWheel = wheel({ ctrlKey: true, deltaY: -1, stopPropagation: vi.fn() })
    listeners.get('wheel')!(magnifyWheel)
    expect(magnifyWheel.preventDefault).toHaveBeenCalledOnce()
    expect(controls.readSize(state)).toBe(17)
    expect(indicator.textContent).toBe('17px')
    listeners.get('wheel')!(wheel({ ctrlKey: true, deltaY: 10, stopPropagation: vi.fn() }))
    expect(controls.readSize(state)).toBe(16)

    for (const fields of [{ altKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      windowListeners.get('keydown')!(keyEvent(fields))
      const mixed = wheel({ ctrlKey: true, stopPropagation: vi.fn() })
      listeners.get('wheel')!(mixed)
      expect(mixed.preventDefault).not.toHaveBeenCalled()
      expect(controls.readSize(state)).toBe(16)
    }
    windowListeners.get('keydown')!(keyEvent())
    listeners.get('wheel')!(wheel({ ctrlKey: true, deltaY: -9, stopPropagation: vi.fn() }))
    windowListeners.get('keyup')!(keyEvent({ metaKey: false }))
    const released = wheel({ ctrlKey: true, stopPropagation: vi.fn() })
    listeners.get('wheel')!(released)
    expect(released.preventDefault).not.toHaveBeenCalled()
    windowListeners.get('keydown')!(keyEvent())
    listeners.get('wheel')!(wheel({ ctrlKey: true, deltaY: -1, stopPropagation: vi.fn() }))
    expect(controls.readSize(state)).toBe(16)
    listeners.get('wheel')!(wheel({ ctrlKey: true, deltaY: -8, stopPropagation: vi.fn() }))
    windowListeners.get('blur')!(keyEvent())
    const blurred = wheel({ ctrlKey: true, stopPropagation: vi.fn() })
    listeners.get('wheel')!(blurred)
    expect(blurred.preventDefault).not.toHaveBeenCalled()
    windowListeners.get('keydown')!(keyEvent())
    listeners.get('wheel')!(wheel({ ctrlKey: true, deltaY: -1, stopPropagation: vi.fn() }))
    expect(controls.readSize(state)).toBe(16)
    controls.increase(view)
    expect(vi.getTimerCount()).toBe(1)
    plugin.destroy?.()
    expect(dom.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), true)
    expect(indicator.remove).toHaveBeenCalledOnce()
    expect(window.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(window.removeEventListener).toHaveBeenCalledWith('keyup', expect.any(Function), true)
    expect(window.removeEventListener).toHaveBeenCalledWith('blur', expect.any(Function))
    expect(windowListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('installs persisted font state and font shortcuts in the JavaEditor constructor', () => {
    const storage = { getItem: vi.fn(() => '20'), setItem: vi.fn() }
    const parent = { ownerDocument: { body: {} } } as HTMLElement
    const editor = new JavaEditor(parent, { storage: storage as unknown as Storage })
    const fontStyle = () => editor.view.state.facet(EditorView.editorAttributes)
      .flatMap((attribute) => typeof attribute === 'function' ? attribute(editor.view)?.style ?? [] : attribute.style ?? [])
    expect(fontStyle()).toContain('font-size: 20px')
    expect(runScopeHandlers(editor.view, {
      key: '=', keyCode: 187, shiftKey: true, altKey: true, ctrlKey: false, metaKey: false,
    } as KeyboardEvent, 'editor')).toBe(true)
    expect(fontStyle()).toContain('font-size: 21px')
    expect(storage.setItem).toHaveBeenCalledWith(EDITOR_FONT_SIZE_KEY, '21')
  })

  it('wires Shift+F6 to variable rename while preserving the document', () => {
    const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement)
    const source = 'class Solution { int solve() { int count = 1; return count; } }'
    editor.setValue(source)
    editor.view.dispatch({ selection: { anchor: source.indexOf('count') + 2 } })
    expect(runScopeHandlers(editor.view, {
      key: 'F6', keyCode: 117, shiftKey: true, altKey: false, ctrlKey: false, metaKey: false,
    } as KeyboardEvent, 'editor')).toBe(true)
    expect(editor.getValue()).toBe(source)
    expect(editor.view.state.selection.ranges.map((range) => source.slice(range.from, range.to)))
      .toEqual(['count', 'count'])
  })
  it('restores the saved size and applies it to the editor attributes', () => {
    const { controls, view, storage } = harness(false, '19')
    expect(controls.readSize(view.state)).toBe(19)
    expect(storage.getItem).toHaveBeenCalledWith(EDITOR_FONT_SIZE_KEY)
    const attributes = view.state.facet(EditorView.editorAttributes)
    expect(attributes.some((attribute) => typeof attribute === 'function'
      && attribute(view)?.style === 'font-size: 19px')).toBe(true)
  })

  it.each([null, '', 'bad', 'NaN', 'Infinity'])('uses the default for invalid saved size %s', (value) => {
    const { controls, view } = harness(false, value)
    expect(controls.readSize(view.state)).toBe(14)
  })

  it('changes size without changing source, selection, or undo history', () => {
    const { controls, view, storage } = harness()
    const selection = view.state.selection
    controls.increase(view)
    expect(controls.readSize(view.state)).toBe(15)
    expect(view.state.doc.toString()).toBe('class Solution {}')
    expect(view.state.selection).toBe(selection)
    expect(undo(view)).toBe(false)
    expect(storage.setItem).toHaveBeenCalledWith(EDITOR_FONT_SIZE_KEY, '15')
    controls.decrease(view)
    expect(controls.readSize(view.state)).toBe(14)
  })

  it.each([['3', 8, 'decrease'], ['99', 40, 'increase']] as const)(
    'clamps restored size %s and consumes further changes at its boundary', (value, expected, command) => {
      const { controls, view, storage } = harness(false, value)
      expect(controls.readSize(view.state)).toBe(expected)
      expect(controls[command](view)).toBe(true)
      expect(controls.readSize(view.state)).toBe(expected)
      expect(storage.setItem).not.toHaveBeenCalled()
    },
  )

  it('keeps adjustment functional when storage reads or writes fail', () => {
    const controls = createEditorFontSizeControls(false, {
      getItem: () => { throw new Error('disabled') },
      setItem: () => { throw new Error('disabled') },
    })
    let state = EditorState.create({ extensions: controls.extension })
    const view = { get state() { return state }, dispatch: (spec: TransactionSpec) => {
      state = state.update(spec).state
    } } as unknown as EditorView
    expect(controls.readSize(state)).toBe(14)
    expect(controls.increase(view)).toBe(true)
    expect(controls.readSize(state)).toBe(15)
  })

  it('runs shifted punctuation with the registered Alt and platform Mod forms', () => {
    const modKey = /Mac/.test(navigator.platform) ? 'metaKey' : 'ctrlKey'
    for (const modifier of ['altKey', modKey] as const) {
      const { controls, view } = harness()
      const event = { key: '=', keyCode: 187, shiftKey: true, altKey: false,
        ctrlKey: false, metaKey: false, [modifier]: true } as KeyboardEvent
      expect(runScopeHandlers(view, event, 'editor'), modifier).toBe(true)
      expect(controls.readSize(view.state)).toBe(15)
      expect(runScopeHandlers(view, { ...event, key: '-', keyCode: 189 } as KeyboardEvent, 'editor')).toBe(true)
      expect(controls.readSize(view.state)).toBe(14)
    }
  })

  it('zooms with Cmd wheel on macOS and Alt or Ctrl wheel elsewhere', () => {
    for (const [mac, modifier] of [[true, 'metaKey'], [false, 'altKey'], [false, 'ctrlKey']] as const) {
      const { controls, view } = harness(mac)
      const event = wheel({ [modifier]: true, deltaY: mac ? -40 : -100 })
      expect(controls.handleWheel(event, view)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(controls.readSize(view.state)).toBe(15)
      expect(controls.handleWheel(wheel({ [modifier]: true, deltaY: mac ? 40 : 100 }), view)).toBe(true)
      expect(controls.readSize(view.state)).toBe(14)
    }
  })

  it('leaves ordinary, zero, invalid, mixed-modifier and macOS pinch wheel gestures alone', () => {
    for (const [mac, event] of [
      [false, wheel()], [false, wheel({ altKey: true, deltaY: 0 })],
      [false, wheel({ deltaX: 200 })],
      [false, wheel({ altKey: true, deltaX: NaN })],
      [false, wheel({ altKey: true, deltaY: Infinity })],
      [false, wheel({ altKey: true, ctrlKey: true })],
      [false, wheel({ altKey: true, shiftKey: true })],
      [true, wheel({ ctrlKey: true })],
      [true, wheel({ metaKey: true, ctrlKey: true })],
    ] as const) {
      const { controls, view } = harness(mac)
      expect(controls.handleWheel(event, view)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(controls.readSize(view.state)).toBe(14)
    }
  })
})

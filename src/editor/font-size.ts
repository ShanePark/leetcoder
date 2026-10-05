import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export const EDITOR_FONT_SIZE_KEY = 'leetcoder.editor-font-size'
const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 40

type FontSizeStorage = Pick<Storage, 'getItem' | 'setItem'>

function clampFontSize(size: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
}

function readFontSize(storage?: FontSizeStorage): number {
  try {
    const value = storage?.getItem(EDITOR_FONT_SIZE_KEY)
    const size = value ? Number(value) : NaN
    return Number.isFinite(size) ? clampFontSize(Math.round(size)) : DEFAULT_FONT_SIZE
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

/** Keep font changes separate from document edits and undo history. */
export function createEditorFontSizeControls(macPlatform: boolean, storage?: FontSizeStorage) {
  const setSize = StateEffect.define<number>()
  const sizeField = StateField.define<number>({
    create: () => readFontSize(storage),
    update: (size, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setSize)) size = effect.value
      }
      return size
    },
  })
  const readSize = (state: EditorState): number => state.field(sizeField)
  let wheelRemainder = 0
  const resetWheel = (): void => { wheelRemainder = 0 }
  const change = (view: EditorView, delta: number): boolean => {
    const current = readSize(view.state)
    const next = clampFontSize(current + delta)
    view.dispatch({ effects: setSize.of(next) })
    if (next !== current) {
      try {
        storage?.setItem(EDITOR_FONT_SIZE_KEY, String(next))
      } catch {
        // A disabled preference store must not prevent changing the font.
      }
    }
    return true
  }
  const increase = (view: EditorView): boolean => { resetWheel(); return change(view, 1) }
  const decrease = (view: EditorView): boolean => { resetWheel(); return change(view, -1) }
  const handleWheel = (event: WheelEvent, view: EditorView, commandHeld = false): boolean => {
    const modifier = macPlatform
      ? (event.metaKey || commandHeld) && !event.altKey && (!event.ctrlKey || commandHeld)
      : !event.metaKey && (event.altKey !== event.ctrlKey)
    if (!modifier || event.shiftKey || !Number.isFinite(event.deltaY)
      || !Number.isFinite(event.deltaX) || ![0, 1, 2].includes(event.deltaMode)) {
      resetWheel()
      return false
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return false
    event.preventDefault()
    // Smooth input splits one movement into many packets. Accumulate its
    // quantity so font changes depend on movement rather than packet count.
    const unitsPerStep = event.deltaMode === 1 ? 3
      : event.deltaMode === 2 ? 1
        : macPlatform && event.ctrlKey && commandHeld ? 10
          : macPlatform ? 40 : 100
    if (wheelRemainder * delta < 0) resetWheel()
    wheelRemainder += delta / unitsPerStep
    const steps = Math.sign(wheelRemainder) * Math.floor(Math.abs(wheelRemainder) + 1e-7)
    wheelRemainder -= steps
    const handled = change(view, -steps)
    const size = readSize(view.state)
    if ((size === MAX_FONT_SIZE && delta < 0) || (size === MIN_FONT_SIZE && delta > 0)) resetWheel()
    return handled
  }
  const wheelAndIndicator = ViewPlugin.define((view) => {
    const indicator = view.dom.ownerDocument.createElement('div')
    indicator.className = 'cm-font-size-indicator'
    indicator.setAttribute('role', 'status')
    indicator.hidden = true
    view.dom.append(indicator)
    let timer: ReturnType<typeof setTimeout> | undefined
    const window = view.dom.ownerDocument.defaultView
    let commandHeld = false
    let otherModifiersHeld = false
    const onKeyDown = (event: KeyboardEvent): void => {
      commandHeld = event.metaKey || event.key === 'Meta'
      otherModifiersHeld = event.altKey || event.ctrlKey || event.shiftKey
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      commandHeld = event.metaKey
      otherModifiersHeld = event.altKey || event.ctrlKey || event.shiftKey
      resetWheel()
    }
    const clearModifiers = (): void => {
      commandHeld = false
      otherModifiersHeld = false
      resetWheel()
    }
    const onWheel = (event: WheelEvent): void => {
      // Magnification input can arrive as a Ctrl-marked wheel event. Accept
      // that path only while keyboard events independently report held Cmd.
      const heldCommand = commandHeld && !otherModifiersHeld
      if (handleWheel(event, view, heldCommand)) event.stopPropagation()
    }
    // CodeMirror's event handlers attach to the text content, excluding the
    // gutters and scroller padding. Capture wheel gestures across the editor.
    view.dom.addEventListener('wheel', onWheel, { capture: true, passive: false })
    if (macPlatform) {
      window?.addEventListener('keydown', onKeyDown, true)
      window?.addEventListener('keyup', onKeyUp, true)
      window?.addEventListener('blur', clearModifiers)
    }
    return {
      update(update: ViewUpdate) {
        if (!update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setSize)))) return
        indicator.textContent = `${readSize(update.state)}px`
        indicator.hidden = false
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => { indicator.hidden = true; timer = undefined }, 1200)
      },
      destroy() {
        view.dom.removeEventListener('wheel', onWheel, true)
        if (macPlatform) {
          window?.removeEventListener('keydown', onKeyDown, true)
          window?.removeEventListener('keyup', onKeyUp, true)
          window?.removeEventListener('blur', clearModifiers)
        }
        clearModifiers()
        if (timer !== undefined) clearTimeout(timer)
        indicator.remove()
      },
    }
  })
  return {
    increase,
    decrease,
    readSize,
    handleWheel,
    extension: [
      sizeField,
      EditorView.editorAttributes.of((view) => ({ style: `font-size: ${readSize(view.state)}px` })),
      wheelAndIndicator,
      EditorView.theme({
        '.cm-font-size-indicator': {
          position: 'absolute',
          right: '12px',
          bottom: '12px',
          zIndex: '10',
          padding: '4px 8px',
          border: '1px solid var(--border-strong)',
          borderRadius: '6px',
          backgroundColor: 'var(--surface-2)',
          color: 'var(--text)',
          fontSize: '12px',
          lineHeight: '1.4',
          pointerEvents: 'none',
        },
      }),
    ],
  }
}

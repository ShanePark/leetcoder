import { describe, expect, it, vi } from 'vitest'

import { AiCaseDialog } from '../../../src/app/ai-case-dialog'

class FakeControl {
  hidden = false
  value = ''
  textContent = ''
  isConnected = true
  readonly listeners = new Map<string, (event: unknown) => void>()

  constructor(private readonly document: { activeElement: unknown }) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }

  dispatch(type: string, event: object = {}): void {
    this.listeners.get(type)?.(event)
  }

  focus(): void {
    this.document.activeElement = this
  }

  select(): void {}

  closest(): null {
    return null
  }
}

function setup(): { dialog: AiCaseDialog; confirm: ReturnType<typeof vi.fn>; input: FakeControl; submit: (text?: string) => void; cancel: () => void } {
  const document = { activeElement: null as unknown }
  const controls = new Map<string, FakeControl>()
  const root = {
    ownerDocument: document,
    querySelector: (selector: string) => {
      let control = controls.get(selector)
      if (!control) {
        control = new FakeControl(document)
        controls.set(selector, control)
      }
      return control
    },
  } as unknown as HTMLElement
  const confirm = vi.fn()
  const dialog = new AiCaseDialog({ root, confirm, showMessage: vi.fn() })
  dialog.bindEvents()
  const input = root.querySelector('#ai-case-input') as unknown as FakeControl
  return {
    dialog,
    confirm,
    input,
    submit: (text) => {
      if (text !== undefined) input.value = text
      ;(root.querySelector('#ai-case-form') as unknown as FakeControl).dispatch('submit', { preventDefault: vi.fn() })
    },
    cancel: () => (root.querySelector('#cancel-ai-case') as unknown as FakeControl).dispatch('click'),
  }
}

describe('failing case dialog draft', () => {
  it('keeps the paste after a cancel so a retry needs no new paste', () => {
    const { dialog, input, cancel } = setup()
    dialog.show('Q1TwoSum.java')
    input.value = 'nums = [1]'
    cancel()

    dialog.show('Q1TwoSum.java')
    expect(input.value).toBe('nums = [1]')
  })

  it('opens empty once the submitted case was added as a test', () => {
    const { dialog, confirm, input, submit } = setup()
    dialog.show('Q1TwoSum.java')
    submit('nums = [1]\nExpected\n1')
    expect(confirm).toHaveBeenCalledWith('nums = [1]\nExpected\n1')
    expect(dialog.isOpen).toBe(false)
    // Until the case is added the draft stays, so a failed request can be retried.
    expect(input.value).toBe('nums = [1]\nExpected\n1')

    dialog.clearDraft()
    dialog.show('Q1TwoSum.java')
    expect(input.value).toBe('')
  })

  it('does not wipe a new paste typed while the request was running', () => {
    const { dialog, input, submit } = setup()
    dialog.show('Q1TwoSum.java')
    submit('first case')
    dialog.show('Q1TwoSum.java')
    input.value = 'second case'

    dialog.clearDraft()
    expect(input.value).toBe('second case')
  })
})

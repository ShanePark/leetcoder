import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/icons', () => ({
  iconFor: () => ({ tagName: 'svg', className: '', children: [], textContent: '' }),
}))

import { AiEditDiffDialog, type AiEditDiffRequest } from '../../../src/app/ai-edit-diff-dialog'
import { aiFollowUpProposal } from '../../../src/app/ai-follow-up'

class FakeElement extends EventTarget {
  className = ''
  textContent = ''
  id = ''
  title = ''
  type = ''
  tabIndex = -1
  hidden = false
  disabled = false
  open = false
  isConnected = true
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {
    super()
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  remove(): void {
    this.isConnected = false
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  closest(): null {
    return null
  }

  showModal(): void {
    this.open = true
  }

  close(): void {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }

  click(): void {
    this.dispatchEvent(new Event('click'))
  }

  find(className: string): FakeElement {
    const found = this.all(className)
    if (found.length !== 1) throw new Error(`Expected one .${className}, found ${found.length}`)
    return found[0]
  }

  all(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...(typeof child.all === 'function' ? child.all(className) : []),
    ])
  }

  text(): string {
    return this.textContent + this.children.map((child) => child.text?.() ?? '').join('')
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }
}

function setup(macPlatform = false) {
  const document = new FakeDocument()
  const host = document.createElement('body')
  const opener = document.createElement('button')
  opener.focus()
  const dialog = new AiEditDiffDialog(host as unknown as HTMLElement, macPlatform)
  const accept = vi.fn()
  const reject = vi.fn()
  const view = () => host.children[0]
  const key = ({ target, ...init }: Partial<Omit<KeyboardEvent, 'target'>> & { target?: FakeElement } = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
    }, init)
    if (target) Object.defineProperty(event, 'target', { value: target })
    view().dispatchEvent(event)
    return event
  }
  return { dialog, host, document, opener, accept, reject, view, key }
}

const base = 'class A {\n  int f() {\n    return 1;\n  }\n}\n'
const code = 'class A {\n  // note\n  int f() {\n    return 2;\n  }\n}\n'

const request = (overrides: Partial<AiEditDiffRequest> = {}): AiEditDiffRequest => ({
  fileName: 'Q1TwoSum.java',
  proposal: aiFollowUpProposal({ summary: 'Return two.', code, baseCode: base }),
  canAccept: true,
  note: null,
  ...overrides,
})

describe('proposed change dialog', () => {
  it('shows the whole file as a unified diff with both line numbers and the summary', () => {
    const { dialog, view, accept, reject } = setup()
    dialog.open(request(), { accept, reject })
    const element = view()

    expect(element.tagName).toBe('dialog')
    expect(element.open).toBe(true)
    expect(element.hidden).toBe(false)
    expect(element.find('ai-edit-title').text()).toBe('Proposed change to Q1TwoSum.java')
    expect(element.find('ai-edit-summary').textContent).toBe('Return two.')
    expect(element.find('is-added').textContent).toBe('+2')
    expect(element.find('is-removed').textContent).toBe('−1')
    const rows = element.find('ai-edit-lines').children.map((row) => [
      row.className,
      ...row.children.map((cell) => cell.textContent),
    ])
    expect(rows).toEqual([
      ['git-diff-line', '1', '1', ' ', 'class A {'],
      ['git-diff-line is-addition', '', '2', '+', '  // note'],
      ['git-diff-line', '2', '3', ' ', '  int f() {'],
      ['git-diff-line is-deletion', '3', '', '−', '    return 1;'],
      ['git-diff-line is-addition', '', '4', '+', '    return 2;'],
      ['git-diff-line', '4', '5', ' ', '  }'],
      ['git-diff-line', '5', '6', ' ', '}'],
    ])
  })

  it('labels its keys from the shortcut list on each platform', () => {
    for (const [mac, close] of [[false, 'Esc'], [true, 'Esc']] as const) {
      const { dialog, view } = setup(mac)
      dialog.open(request(), { accept: vi.fn(), reject: vi.fn() })
      expect(view().find('ai-edit-accept').text()).toBe('Accept Enter')
      expect(view().find('ai-edit-close').title).toBe(`Close without deciding (${close})`)
    }
  })

  it('accepts from the button or Enter, and focuses Accept when it opens', () => {
    const { dialog, view, accept, reject, document, opener, key } = setup()
    dialog.open(request(), { accept, reject })
    const acceptButton = view().find('ai-edit-accept')
    expect(acceptButton.disabled).toBe(false)
    expect(document.activeElement).toBe(acceptButton)
    acceptButton.click()
    expect(accept).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(view().open).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(dialog.isOpen).toBe(false)

    dialog.open(request(), { accept, reject })
    expect(key().defaultPrevented).toBe(true)
    expect(accept).toHaveBeenCalledTimes(2)
  })

  it('leaves Enter on Reject to the button, and ignores composing and modified Enter', () => {
    const { dialog, view, accept, reject, key } = setup()
    dialog.open(request(), { accept, reject })
    expect(key({ target: view().find('ai-edit-reject') }).defaultPrevented).toBe(false)
    expect(key({ isComposing: true }).defaultPrevented).toBe(false)
    expect(key({ shiftKey: true }).defaultPrevented).toBe(false)
    expect(accept).not.toHaveBeenCalled()
    view().find('ai-edit-reject').click()
    expect(reject).toHaveBeenCalledOnce()
    expect(accept).not.toHaveBeenCalled()
    expect(view().open).toBe(false)
  })

  it('disables Accept with the reason when the change cannot be applied', () => {
    const { dialog, view, accept, reject, key, document } = setup()
    const note = 'The file changed since this change was proposed. Ask again for a new one.'
    dialog.open(request({ canAccept: false, note }), { accept, reject })
    const acceptButton = view().find('ai-edit-accept')
    expect(acceptButton.disabled).toBe(true)
    expect(view().find('ai-edit-note').textContent).toBe(note)
    expect(view().find('ai-edit-note').className).toBe('ai-edit-note is-blocked')
    expect(document.activeElement).toBe(view().find('ai-edit-reject'))
    acceptButton.click()
    key()
    expect(accept).not.toHaveBeenCalled()
    expect(dialog.isOpen).toBe(true)
  })

  it('closes without deciding on Escape or the close button', () => {
    const { dialog, view, accept, reject } = setup()
    dialog.open(request(), { accept, reject })
    const cancel = new Event('cancel', { cancelable: true })
    view().dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(view().open).toBe(false)
    expect(dialog.isOpen).toBe(false)

    dialog.open(request(), { accept, reject })
    view().find('ai-edit-close').click()
    expect(dialog.isOpen).toBe(false)
    expect(accept).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
  })

  it.each(['accepted', 'rejected'] as const)('does not open an %s change, which has nothing left to decide', (status) => {
    const { dialog, host, accept, reject } = setup()
    const proposal = { ...request().proposal, status }
    dialog.open(request({ proposal }), { accept, reject })
    expect(dialog.isOpen).toBe(false)
    expect(host.children).toHaveLength(0)
  })

  it('reuses one dialog element, ignores a second open, and removes it on dispose', () => {
    const { dialog, host, accept, reject } = setup()
    dialog.open(request(), { accept, reject })
    dialog.open(request({ fileName: 'Other.java' }), { accept, reject })
    expect(host.children[0].find('ai-edit-file').textContent).toBe('Q1TwoSum.java')
    dialog.close()
    dialog.open(request({ fileName: 'Other.java' }), { accept, reject })
    expect(host.children).toHaveLength(1)
    const element = host.children[0]
    dialog.dispose()
    expect(element.open).toBe(false)
    expect(element.isConnected).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearProgressOverlay, syncProgressOverlay } from '../../../src/app/progress-overlay'
import { clearGitProgressOverlay, syncGitProgressOverlay } from '../../../src/app/git-progress'

/** Just enough of the DOM for the overlay: a tree with class/id lookup and focus. */
class FakeNode {
  id = ''
  className = ''
  hidden = false
  textContent = ''
  readonly tagName: string
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: FakeNode[] = []
  readonly style = { width: '', setProperty: (_name: string, value: string) => { this.style.width = value } }
  readonly classList = {
    values: new Set<string>(),
    add: (name: string) => this.classList.values.add(name),
    remove: (name: string) => this.classList.values.delete(name),
    contains: (name: string) => this.classList.values.has(name),
  }
  parent: FakeNode | null = null

  constructor(tagName: string, readonly ownerDocument: FakeDocument) {
    this.tagName = tagName
  }

  get isConnected(): boolean {
    return this.parent ? this.parent.isConnected : this === this.ownerDocument.body
  }

  get firstElementChild(): FakeNode | null {
    return this.children[0] ?? null
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0).forEach((node) => { node.parent = null })
    this.append(...nodes)
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (selector.startsWith('#') ? child.id === selector.slice(1) : child.className.split(' ').includes(selector.slice(1))) {
        return child
      }
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
}

class FakeDocument {
  readonly body: FakeNode = new FakeNode('body', this)
  activeElement: FakeNode | null = null

  createElement(tagName: string): FakeNode {
    return new FakeNode(tagName, this)
  }

  querySelector(selector: string): FakeNode | null {
    return this.body.querySelector(selector)
  }
}

function setup(): { document: FakeDocument; root: HTMLElement; modalRoot: FakeNode; shell: FakeNode; button: FakeNode } {
  const document = new FakeDocument()
  const root = document.createElement('div')
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  const button = document.createElement('button')
  shell.append(button)
  const modalRoot = document.createElement('div')
  modalRoot.id = 'modal-root'
  root.append(shell, modalRoot)
  document.body.append(root)
  button.focus()
  return { document, root: root as unknown as HTMLElement, modalRoot, shell, button }
}

const text = (node: FakeNode | null): string => node?.textContent ?? ''

describe('progress overlay', () => {
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')

  beforeEach(() => {
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeNode })
  })

  afterEach(() => {
    if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
  })

  it('shows a generic state as a modal, updates it in place, and restores focus on removal', () => {
    const { document, root, modalRoot, shell, button } = setup()

    syncProgressOverlay(root, {
      kicker: 'AI',
      title: 'Reviewing code',
      stages: ['Prepare request', 'Wait for the model', 'Read the reply'],
      current: 1,
      detail: 'Waiting for model-x',
    })

    const overlay = modalRoot.children[0]!
    expect(modalRoot.children).toHaveLength(1)
    expect('progressOverlay' in overlay.dataset).toBe(true)
    const dialog = overlay.querySelector('.progress-overlay-dialog')!
    expect(dialog.attributes.get('role')).toBe('dialog')
    expect(dialog.attributes.get('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog)
    expect(shell.attributes.has('inert')).toBe(true)
    expect(shell.attributes.get('aria-hidden')).toBe('true')
    expect(document.body.classList.contains('is-progress-overlay')).toBe(true)

    expect(text(overlay.querySelector('.progress-overlay-kicker'))).toBe('AI')
    expect(text(overlay.querySelector('#progress-overlay-title'))).toBe('Reviewing code')
    expect(text(overlay.querySelector('#progress-overlay-message'))).toBe('Waiting for model-x')
    expect(text(overlay.querySelector('.progress-overlay-step-label'))).toBe('Step 2 of 3')
    expect(overlay.querySelector('.progress-overlay-footnote')!.hidden).toBe(true)
    const track = overlay.querySelector('.progress-overlay-track')!
    expect(track.attributes.get('aria-valuenow')).toBe('2')
    expect(track.attributes.get('aria-valuemax')).toBe('3')
    expect(track.attributes.get('aria-valuetext')).toBe('Step 2 of 3 — Wait for the model')
    expect(overlay.querySelector('.progress-overlay-fill')!.style.width).toBe('67%')
    const items = overlay.querySelector('.progress-overlay-stages')!.children
    expect(items.map((item) => item.dataset.state)).toEqual(['complete', 'current', 'pending'])
    expect(items.map((item) => item.firstElementChild!.textContent)).toEqual(['✓', '', '3'])
    expect(items[1]!.attributes.get('aria-current')).toBe('step')
    expect(items[1]!.attributes.get('aria-label')).toBe('Wait for the model: in progress')

    syncProgressOverlay(root, {
      kicker: 'AI',
      title: 'Reviewing code',
      stages: ['Prepare request', 'Wait for the model', 'Read the reply'],
      current: 2,
      footnote: 'The call is recorded in usage.',
    })

    expect(modalRoot.children).toEqual([overlay])
    expect(overlay.querySelector('.progress-overlay-stages')!.children).toEqual(items)
    expect(document.activeElement).toBe(dialog)
    expect(text(overlay.querySelector('#progress-overlay-message'))).toBe('Read the reply')
    expect(text(overlay.querySelector('.progress-overlay-step-label'))).toBe('Step 3 of 3')
    expect(items.map((item) => item.dataset.state)).toEqual(['complete', 'complete', 'current'])
    expect(items[1]!.attributes.has('aria-current')).toBe(false)
    const footnote = overlay.querySelector('.progress-overlay-footnote')!
    expect(footnote.hidden).toBe(false)
    expect(footnote.children[1]!.textContent).toBe('The call is recorded in usage.')

    syncProgressOverlay(root, null)

    expect(modalRoot.children).toHaveLength(0)
    expect(document.activeElement).toBe(button)
    expect(shell.attributes.has('inert')).toBe(false)
    expect(shell.attributes.has('aria-hidden')).toBe(false)
    expect(document.body.classList.contains('is-progress-overlay')).toBe(false)

    // Removing again is a no-op.
    clearProgressOverlay(root)
    expect(document.activeElement).toBe(button)
  })

  it('shows each commit-and-push phase with its description, and an idle Git render leaves other overlays alone', () => {
    const { document, root, modalRoot, button } = setup()

    syncGitProgressOverlay(root, true, 'Preparing commit and push…')
    const overlay = modalRoot.children[0]!
    expect(text(overlay.querySelector('.progress-overlay-kicker'))).toBe('Commit & Push')
    expect(text(overlay.querySelector('#progress-overlay-title'))).toBe('Publishing changes')
    expect(text(overlay.querySelector('.progress-overlay-step-label'))).toBe('Step 1 of 5')
    const items = overlay.querySelector('.progress-overlay-stages')!.children
    expect(items.map((item) => item.querySelector('.progress-overlay-stage-copy')!.children.map((node) => node.textContent)))
      .toEqual([
        ['Prepare changes', 'Saving the current file before committing'],
        ['Pull latest changes', 'Updating the branch from the remote repository'],
        ['Create commit', 'Writing the selected changes to Git'],
        ['Push changes', 'Sending the commit to the remote repository'],
        ['Refresh status', 'Loading the latest repository status'],
      ])
    expect(overlay.querySelector('.progress-overlay-footnote')!.children[1]!.textContent)
      .toBe('Keep this window open while the changes are published.')

    syncGitProgressOverlay(root, true, 'Pushing changes…')
    expect(modalRoot.children).toEqual([overlay])
    expect(text(overlay.querySelector('#progress-overlay-message'))).toBe('Pushing changes…')
    expect(items.map((item) => item.dataset.state)).toEqual(['complete', 'complete', 'complete', 'current', 'pending'])

    syncGitProgressOverlay(root, false, null)
    expect(modalRoot.children).toHaveLength(0)
    expect(document.activeElement).toBe(button)

    syncProgressOverlay(root, { kicker: 'AI', title: 'Generating tests', stages: ['Send', 'Apply'], current: 0 })
    syncGitProgressOverlay(root, false, null)
    expect(modalRoot.children).toHaveLength(1)

    clearGitProgressOverlay(root)
    expect(modalRoot.children).toHaveLength(0)
    expect(document.activeElement).toBe(button)
  })
})

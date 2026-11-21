import { describe, expect, it, vi } from 'vitest'

import { GitCommitDialog } from '../../../src/app/git-commit-dialog'
import type { GitCommitConfirmation } from '../../../src/app/git-controller'

class DialogElement extends EventTarget {
  hidden = true
  open = false
  isConnected = true
  textContent = ''

  constructor(private readonly document: { activeElement: DialogElement | null }) {
    super()
  }

  focus(): void {
    this.document.activeElement = this
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
}

function harness() {
  const document: { activeElement: DialogElement | null } = { activeElement: null }
  const elements = new Map<string, DialogElement>()
  for (const id of ['commit-git-dialog', 'cancel-commit-git', 'confirm-commit-git',
    'commit-git-message', 'commit-git-paths', 'commit-git-branch', 'commit-git-title', 'editor']) {
    elements.set(`#${id}`, new DialogElement(document))
  }
  const element = (selector: string): DialogElement => elements.get(selector)!
  const root = {
    ownerDocument: document,
    querySelector: (selector: string) => element(selector),
  } as unknown as HTMLElement
  const controller = new GitCommitDialog(root)
  element('#editor').focus()
  return { controller, document, element }
}

const request: GitCommitConfirmation = {
  branch: 'feature',
  paths: ['Q1.java', 'Q2.java'],
  message: 'Solve two problems',
  pushAfterCommit: true,
}

describe('GitCommitDialog', () => {
  it('shows the commit details with Cancel focused and resolves false when cancelled', async () => {
    const { controller, document, element } = harness()
    const pending = controller.confirm(request)

    expect(controller.isOpen).toBe(true)
    expect(element('#commit-git-dialog').open).toBe(true)
    expect(element('#commit-git-dialog').hidden).toBe(false)
    expect(document.activeElement).toBe(element('#cancel-commit-git'))
    expect(element('#commit-git-branch').textContent).toContain('2 files to feature')
    expect(element('#commit-git-message').textContent).toBe(request.message)
    expect(element('#commit-git-paths').textContent).toBe('Q1.java\nQ2.java')

    element('#cancel-commit-git').dispatchEvent(new Event('click'))

    await expect(pending).resolves.toBe(false)
    expect(controller.isOpen).toBe(false)
    expect(element('#commit-git-dialog').open).toBe(false)
    expect(element('#commit-git-dialog').hidden).toBe(true)
    expect(document.activeElement).toBe(element('#editor'))
    controller.dispose()
  })

  it('requires an explicit confirmation click and rejects a duplicate prompt', async () => {
    const { controller, element } = harness()
    const resolved = vi.fn()
    const pending = controller.confirm(request)
    void pending.then(resolved)

    await expect(controller.confirm(request)).resolves.toBe(false)
    element('#commit-git-dialog').dispatchEvent(new Event('keydown'))
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    expect(controller.isOpen).toBe(true)

    element('#confirm-commit-git').dispatchEvent(new Event('click'))
    await expect(pending).resolves.toBe(true)
    expect(resolved).toHaveBeenCalledExactlyOnceWith(true)
    expect(controller.isOpen).toBe(false)
    controller.dispose()
  })

  it('updates the title, action and branch summary when reused for each commit mode', async () => {
    const { controller, element } = harness()

    for (const pushAfterCommit of [true, false, true]) {
      const pending = controller.confirm({ ...request, pushAfterCommit })

      expect(element('#commit-git-title').textContent)
        .toBe(pushAfterCommit ? 'Commit and push?' : 'Commit changes?')
      expect(element('#confirm-commit-git').textContent)
        .toBe(pushAfterCommit ? 'Commit & Push' : 'Commit')
      expect(element('#commit-git-branch').textContent)
        .toBe(pushAfterCommit
          ? 'Commit 2 files to feature and push to its upstream?'
          : 'Commit 2 files to feature?')

      element('#cancel-commit-git').dispatchEvent(new Event('click'))
      await expect(pending).resolves.toBe(false)
    }
    controller.dispose()
  })

  it.each(['cancel', 'close'])('cancels through the native %s event', async (eventName) => {
    const { controller, document, element } = harness()
    const pending = controller.confirm(request)
    const event = new Event(eventName, { cancelable: true })

    if (eventName === 'close') element('#commit-git-dialog').open = false
    element('#commit-git-dialog').dispatchEvent(event)

    await expect(pending).resolves.toBe(false)
    expect(document.activeElement).toBe(element('#editor'))
    if (eventName === 'cancel') expect(event.defaultPrevented).toBe(true)
    controller.dispose()
  })

  it('keeps a newly opened prompt active when a previous close event arrives late', async () => {
    const { controller, element } = harness()
    const first = controller.confirm(request)
    element('#cancel-commit-git').dispatchEvent(new Event('click'))
    await expect(first).resolves.toBe(false)
    const second = controller.confirm(request)

    element('#commit-git-dialog').dispatchEvent(new Event('close'))

    expect(controller.isOpen).toBe(true)
    element('#confirm-commit-git').dispatchEvent(new Event('click'))
    await expect(second).resolves.toBe(true)
    controller.dispose()
  })

  it('cancels a pending prompt when disposed and removes its listeners', async () => {
    const { controller, element } = harness()
    const pending = controller.confirm(request)

    controller.dispose()
    element('#confirm-commit-git').dispatchEvent(new Event('click'))

    await expect(pending).resolves.toBe(false)
    expect(controller.isOpen).toBe(false)
  })

  it('safely cancels if the native dialog cannot be opened', async () => {
    const { controller, element } = harness()
    element('#commit-git-dialog').showModal = () => { throw new Error('unavailable') }

    await expect(controller.confirm(request)).resolves.toBe(false)
    expect(controller.isOpen).toBe(false)
    expect(element('#commit-git-dialog').hidden).toBe(true)
    controller.dispose()
  })
})

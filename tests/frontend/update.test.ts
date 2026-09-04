import { describe, expect, it } from 'vitest'

import { createUpdateController } from '../../src/update-controller'
import {
  formatUpdateElapsed,
  createUpdateProgressView,
  normaliseUpdateProgress,
  renderUpdateProgressOverlay,
  updateProgressStageIndex,
} from '../../src/update-progress'
import type { UpdateStatus } from '../../src/backend'

class TestClassList {
  private readonly values = new Set<string>()

  add(value: string): void {
    this.values.add(value)
  }

  remove(value: string): void {
    this.values.delete(value)
  }

  contains(value: string): boolean {
    return this.values.has(value)
  }
}

class TestElement {
  innerHTML = ''
  textContent: string | null = null
  dateTime = ''
  isConnected = true
  readonly classList = new TestClassList()
  readonly children: TestElement[] = []
  parentElement: TestElement | null = null
  private readonly attributes = new Map<string, string>()

  append(child: TestElement): void {
    child.parentElement = this
    this.children.push(child)
  }

  contains(target: TestElement): boolean {
    return this === target || this.children.some((child) => child.contains(target))
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  focus(): void {}

  replaceChildren(): void {
    this.innerHTML = ''
    this.children.splice(0)
  }
}

function installUpdateProgressDom(): {
  appShell: TestElement
  modalRoot: TestElement
  body: TestElement
  restore: () => void
} {
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  const originalHTMLElement = globalThis.HTMLElement
  const body = new TestElement()
  const appShell = new TestElement()
  const modalRoot = new TestElement()
  const trigger = new TestElement()
  const dialog = new TestElement()
  const elapsed = new TestElement()
  body.append(appShell)
  body.append(modalRoot)
  appShell.append(trigger)

  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: TestElement })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      activeElement: trigger,
      getElementById: (id: string) => id === 'modal-root' ? modalRoot : null,
      querySelector: (selector: string) => {
        if (selector === '.app-shell') return appShell
        if (selector === '.update-progress-dialog') return dialog
        if (selector === '[data-update-elapsed]') return elapsed
        return null
      },
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval: () => 1,
      clearInterval: () => {},
    },
  })

  return {
    appShell,
    modalRoot,
    body,
    restore: () => {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
      Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: originalHTMLElement })
    },
  }
}

function updateStatus(available: boolean, supported = true): UpdateStatus {
  return {
    supported,
    available,
    currentCommit: 'current',
    latestCommit: available ? 'latest' : 'current',
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('update progress', () => {
  it('normalizes unknown progress values to safe stages and bounds', () => {
    expect(normaliseUpdateProgress({ stage: 'building', step: 2, total: 4, message: ' Building ', detail: ' npm run build ' })).toEqual({
      stage: 'building',
      step: 2,
      total: 4,
      message: 'Building',
      detail: 'npm run build',
    })
    expect(normaliseUpdateProgress({ stage: 'unknown', step: 99, total: 0, message: '' })).toMatchObject({
      stage: 'validating',
      step: 4,
      total: 4,
      message: 'Checking the latest local commit',
    })
    expect(updateProgressStageIndex('restarting')).toBe(3)
    expect(formatUpdateElapsed(65)).toBe('1m 5s')
  })

  it('renders an accessible blocking overlay with all four stages', () => {
    const overlay = renderUpdateProgressOverlay()
    expect(overlay).toContain('role="dialog" aria-modal="true"')
    expect(overlay).toContain('data-update-stage="validating"')
    expect(overlay).toContain('data-update-stage="building"')
    expect(overlay).toContain('data-update-stage="preparing"')
    expect(overlay).toContain('data-update-stage="restarting"')
  })

  it('mounts the progress overlay outside the inert app shell', () => {
    const dom = installUpdateProgressDom()
    const view = createUpdateProgressView()
    try {
      view.start()

      expect(view.isActive()).toBe(true)
      expect(dom.modalRoot.innerHTML).toContain('data-update-progress-overlay')
      expect(dom.modalRoot.parentElement).toBe(dom.body)
      expect(dom.appShell.contains(dom.modalRoot)).toBe(false)
      expect(dom.appShell.getAttribute('inert')).toBe('')
      expect(dom.appShell.getAttribute('aria-hidden')).toBe('true')
      expect(dom.modalRoot.getAttribute('inert')).toBeNull()
      expect(dom.body.classList.contains('is-update-progress')).toBe(true)

      view.fail()
      expect(view.isActive()).toBe(false)
      expect(dom.modalRoot.innerHTML).toBe('')
      expect(dom.appShell.getAttribute('inert')).toBeNull()
      expect(dom.body.classList.contains('is-update-progress')).toBe(false)
    } finally {
      dom.restore()
    }
  })
})

describe('update controller', () => {
  it('only exposes supported available updates', async () => {
    const available: boolean[] = []
    const controller = createUpdateController(
      {
        checkForUpdate: async () => updateStatus(true, false),
        updateAndRestart: async () => {},
      },
      {
        setUpdateAvailable: (value) => available.push(value),
        setUpdateBusy: () => {},
        showUpdateStarted: () => {},
        showError: () => {},
      },
    )
    await controller.checkForUpdate()
    expect(available).toEqual([false])
  })

  it('does not overlap checks and restores the button after an update error', async () => {
    const check = deferred<UpdateStatus>()
    const update = deferred<void>()
    const available: boolean[] = []
    const busy: boolean[] = []
    const errors: string[] = []
    let checks = 0
    const controller = createUpdateController(
      {
        checkForUpdate: () => {
          checks += 1
          return check.promise
        },
        updateAndRestart: () => update.promise,
      },
      {
        setUpdateAvailable: (value) => available.push(value),
        setUpdateBusy: (value) => busy.push(value),
        showUpdateStarted: () => {},
        showError: (message) => errors.push(message),
      },
    )
    const firstCheck = controller.checkForUpdate()
    const secondCheck = controller.checkForUpdate()
    expect(checks).toBe(1)
    check.resolve(updateStatus(true))
    await Promise.all([firstCheck, secondCheck])
    const updatePromise = controller.updateAndRestart()
    update.reject(new Error('release build failed'))
    await updatePromise
    expect(available).toEqual([true, true])
    expect(busy).toEqual([true, false])
    expect(errors).toEqual(['release build failed'])
  })
})

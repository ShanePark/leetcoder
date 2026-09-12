import type { ProblemFileEntry } from '../backend'
import { isFileTabsShiftWheel } from './navigation'
import type { OpenFileTab } from './types'
import { sameFilePath } from './path-helpers'

/** The state needed to render the open-file tab strip. */
export interface FileTabsViewModel {
  readonly openTabs: readonly OpenFileTab[]
  readonly activeTabId: number | null
  readonly dirty: boolean
  readonly hasPendingChanges: boolean
  readonly busy: boolean
}

/** User actions stay with the app controller. */
export interface FileTabsViewCallbacks {
  readonly onOpenTab: (tabId: number) => void | Promise<void>
  readonly onCloseTab: (tabId: number) => void | Promise<void>
}

/**
 * Owns the open-file tab strip and its short-lived DOM state.
 *
 * The app still owns tab/file state and the asynchronous open/close lifecycle;
 * this view only turns that state into controls and reports user actions back
 * through callbacks.
 */
export class FileTabsView {
  private renderedActiveTabId: number | null = null
  private renderedTabsSignature: string | null = null
  private renderedStateSignature: string | null = null
  private revealFrame: number | null = null
  private revealToken = 0

  readonly handleWheel = (event: WheelEvent): void => {
    handleFileTabsWheel(this.list, event)
  }

  constructor(
    private readonly list: HTMLElement,
    private readonly callbacks: FileTabsViewCallbacks,
  ) {
    this.list.addEventListener('wheel', this.handleWheel, { passive: false })
  }

  /** Render the tab strip from scratch after its membership or metadata changes. */
  render(model: FileTabsViewModel): void {
    const tabsSignature = fileTabsSignature(model.openTabs)
    if (this.renderedTabsSignature === tabsSignature) {
      this.update(model)
      return
    }
    const activeChanged = this.renderedActiveTabId !== model.activeTabId
    if (activeChanged) {
      this.cancelScheduledReveal()
    }
    this.renderedActiveTabId = model.activeTabId
    this.renderedTabsSignature = tabsSignature
    this.renderedStateSignature = fileTabsStateSignature(model)
    this.list.innerHTML = ''
    for (const tab of model.openTabs) {
      this.list.append(this.renderTab(tab, model))
    }
    if (activeChanged && model.activeTabId !== null) {
      this.scheduleActiveTabReveal(model.activeTabId)
    }
  }

  /** Update active/dirty state without rebuilding tab controls when possible. */
  update(model: FileTabsViewModel): void {
    const items = Array.from(this.list.querySelectorAll<HTMLElement>('.file-tab'))
    if (this.renderedTabsSignature !== fileTabsSignature(model.openTabs)
      || items.length !== model.openTabs.length) {
      // `render()` delegates to `update()` when the membership signature is
      // unchanged, so invalidate the cached signature before asking it to
      // rebuild after external DOM removal.
      this.renderedTabsSignature = null
      this.renderedStateSignature = null
      this.render(model)
      return
    }
    if (this.renderedStateSignature === fileTabsStateSignature(model)) {
      return
    }

    const activeChanged = this.renderedActiveTabId !== model.activeTabId
    const itemsById = new Map(items.map((item) => [item.dataset.tabId ?? '', item]))
    for (const tab of model.openTabs) {
      const item = itemsById.get(String(tab.id))
      const tabButton = item?.querySelector<HTMLButtonElement>('[role="tab"]')
      if (!item || !tabButton) {
        this.renderedTabsSignature = null
        this.renderedStateSignature = null
        this.render(model)
        return
      }
      const active = tab.id === model.activeTabId
      item.classList.toggle('is-active', active)
      tabButton.setAttribute('aria-selected', String(active))
      tabButton.tabIndex = active ? 0 : -1
      const close = item.querySelector<HTMLButtonElement>('.file-tab-close')
      if (close) {
        close.disabled = model.busy
      }
      this.updateDirtyMarker(item, tabButton, active && this.isDirty(model))
    }

    if (activeChanged && model.activeTabId !== null) {
      this.cancelScheduledReveal()
      this.renderedActiveTabId = model.activeTabId
      this.scheduleActiveTabReveal(model.activeTabId)
    } else {
      this.renderedActiveTabId = model.activeTabId
    }
    this.renderedStateSignature = fileTabsStateSignature(model)
  }

  /** Cancel pending reveal work and detach the wheel listener. */
  dispose(): void {
    this.cancelScheduledReveal()
    this.renderedTabsSignature = null
    this.renderedStateSignature = null
    this.list.removeEventListener('wheel', this.handleWheel)
  }

  private renderTab(tab: OpenFileTab, model: FileTabsViewModel): HTMLElement {
    const item = document.createElement('div')
    item.className = 'file-tab'
    item.setAttribute('role', 'presentation')
    item.dataset.tabId = String(tab.id)

    const tabButton = document.createElement('button')
    tabButton.type = 'button'
    tabButton.className = 'file-tab-button'
    tabButton.setAttribute('role', 'tab')
    const active = tab.id === model.activeTabId
    item.classList.toggle('is-active', active)
    tabButton.setAttribute('aria-selected', String(active))
    tabButton.setAttribute('aria-controls', 'editor-host')
    tabButton.tabIndex = active ? 0 : -1
    tabButton.title = tab.path

    const label = document.createElement('span')
    label.className = 'file-tab-label'
    label.textContent = tab.name.replace(/\.java$/i, '')
    tabButton.append(label)
    tabButton.setAttribute('aria-label', tab.name)

    this.updateDirtyMarker(item, tabButton, active && this.isDirty(model))

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'file-tab-close'
    close.setAttribute('aria-label', `Close ${tab.name}`)
    close.title = `Close ${tab.name}`
    close.textContent = '×'
    close.disabled = model.busy
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.callbacks.onCloseTab(tab.id)
    })
    close.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void this.callbacks.onCloseTab(tab.id)
    })

    tabButton.addEventListener('click', () => {
      void this.callbacks.onOpenTab(tab.id)
    })
    tabButton.addEventListener('keydown', (event) => {
      const tabs = Array.from(this.list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      const currentIndex = tabs.indexOf(tabButton)
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void this.callbacks.onOpenTab(tab.id)
        return
      }
      if (currentIndex < 0 || tabs.length === 0) {
        return
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return
      }
      event.preventDefault()
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : Math.max(0, Math.min(
            tabs.length - 1,
            currentIndex + (event.key === 'ArrowLeft' ? -1 : 1),
          ))
      tabs[nextIndex].focus()
    })

    item.append(tabButton, close)
    return item
  }

  private updateDirtyMarker(item: HTMLElement, tabButton: HTMLButtonElement, dirty: boolean): void {
    const dirtyMarker = item.querySelector<HTMLElement>('.file-tab-dirty')
    if (dirty && !dirtyMarker) {
      const marker = document.createElement('span')
      marker.className = 'file-tab-dirty'
      marker.setAttribute('aria-label', 'Unsaved changes')
      tabButton.append(marker)
    } else if (!dirty && dirtyMarker) {
      dirtyMarker.remove()
    }
    item.classList.toggle('is-dirty', dirty)
  }

  private isDirty(model: FileTabsViewModel): boolean {
    return model.dirty || model.hasPendingChanges
  }

  private scheduleActiveTabReveal(tabId: number): void {
    const token = ++this.revealToken
    const reveal = (): void => {
      this.revealFrame = null
      if (token !== this.revealToken || this.renderedActiveTabId !== tabId) {
        return
      }
      const item = Array.from(this.list.querySelectorAll<HTMLElement>('.file-tab'))
        .find((entry) => entry.dataset.tabId === String(tabId))
      item?.querySelector<HTMLElement>('[role="tab"]')?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      })
    }
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      this.revealFrame = window.requestAnimationFrame(reveal)
    } else {
      queueMicrotask(reveal)
    }
  }

  private cancelScheduledReveal(): void {
    this.revealToken += 1
    if (this.revealFrame === null) {
      return
    }
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.revealFrame)
    }
    this.revealFrame = null
  }
}

export function createFileTabsView(
  list: HTMLElement,
  callbacks: FileTabsViewCallbacks,
): FileTabsView {
  return new FileTabsView(list, callbacks)
}

function fileTabsSignature(tabs: readonly OpenFileTab[]): string {
  return tabs
    .map((tab) => `${tab.id}\u0000${tab.path}\u0000${tab.name}\u0000${tab.packageSegment}`)
    .join('\u0001')
}

function fileTabsStateSignature(model: FileTabsViewModel): string {
  return `${model.activeTabId ?? ''}\u0000${String(model.dirty)}\u0000${String(model.hasPendingChanges)}\u0000${String(model.busy)}`
}

/** Whether a file-tab wheel gesture should move the tab strip horizontally. */
export function handleFileTabsWheel(
  list: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>,
  event: Pick<WheelEvent, 'deltaY' | 'shiftKey' | 'preventDefault'>,
): void {
  if (!isFileTabsShiftWheel(event) || list.scrollWidth <= list.clientWidth) {
    return
  }
  event.preventDefault()
  list.scrollLeft += event.deltaY
}

export interface FileHeadingViewElements {
  readonly selectedFile: HTMLElement
  readonly saveStatus: HTMLElement
  readonly editorHost: HTMLElement
}

/** The state needed to render the selected-file heading and save indicator. */
export interface FileHeadingViewModel {
  readonly files: readonly ProblemFileEntry[]
  readonly selectedPath: string | null
  readonly savedSource: string
  readonly saveError: string | null
  readonly saveWriteInFlight: boolean
  readonly dirty: boolean
  readonly hasPendingChanges: boolean
  readonly savedFlash: boolean
  readonly saveShortcutLabel: string
}

export function renderFileHeading(
  elements: FileHeadingViewElements,
  model: FileHeadingViewModel,
): void {
  const file = model.files.find((entry) => sameFilePath(entry.path, model.selectedPath ?? ''))
  elements.selectedFile.textContent = file?.name ?? ''
  elements.saveStatus.className = 'save-status'
  elements.saveStatus.innerHTML = ''
  elements.saveStatus.removeAttribute('title')
  if (!model.selectedPath) {
    elements.editorHost.dataset.savedSource = model.savedSource
    return
  }
  if (model.saveError) {
    elements.saveStatus.classList.add('is-error')
    elements.saveStatus.textContent = 'Save failed'
    elements.saveStatus.title = model.saveError
  } else if (model.saveWriteInFlight) {
    elements.saveStatus.classList.add('is-saving')
    elements.saveStatus.textContent = 'Saving…'
  } else if (model.dirty || model.hasPendingChanges) {
    elements.saveStatus.classList.add('is-unsaved')
    const dot = document.createElement('span')
    dot.className = 'save-dot'
    dot.setAttribute('aria-hidden', 'true')
    elements.saveStatus.append(dot, document.createTextNode('Unsaved'))
    elements.saveStatus.title = `Saves automatically · ${model.saveShortcutLabel}`
  } else if (model.savedFlash) {
    elements.saveStatus.classList.add('is-saved')
    elements.saveStatus.textContent = 'Saved'
  }
  elements.editorHost.dataset.savedSource = model.savedSource
}

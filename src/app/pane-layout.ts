import {
  BOTTOM_PANEL_HEIGHT_KEY,
  clampBottomPanelHeight,
  clampGitFileListWidth,
  clampSidebarWidth,
  GIT_FILE_LIST_WIDTH_KEY,
  maxBottomPanelHeight,
  maxGitFileListWidth,
  maxSidebarWidth,
  MIN_BOTTOM_PANEL_HEIGHT,
  MIN_GIT_FILE_LIST_WIDTH,
  MIN_SIDEBAR_WIDTH,
  readBottomPanelHeight,
  readGitFileListWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_KEY,
} from './layout'
import { TestSplitLayout } from './test-split-layout'

export interface PaneLayoutControllerOptions {
  storage?: Storage
}

/**
 * Owns the resizable panes in the application shell.
 *
 * The controller keeps dimensions independent from the app state machine and
 * only communicates through the shell DOM and its optional persistent store.
 * `apply` is useful after a render, while `refresh` reclamps every dimension
 * against the current viewport and measurable workspace sizes.
 */
export class PaneLayoutController {
  private readonly root: HTMLElement
  private readonly storage: Storage | undefined
  private readonly window: Window | null
  private bottomPanelHeight: number
  private panelResizeStartY: number | null = null
  private panelResizeStartHeight: number | null = null
  private gitFileListWidth: number
  private gitSplitterStartX: number | null = null
  private gitSplitterStartWidth: number | null = null
  private sidebarWidth: number
  private sidebarCollapsedState: boolean
  private sidebarSplitterStartX: number | null = null
  private sidebarSplitterStartWidth: number | null = null
  private readonly testSplit: TestSplitLayout
  private destroyed = false

  private readonly handlePanelPointerMove = (event: PointerEvent): void => {
    if (this.panelResizeStartY === null || this.panelResizeStartHeight === null) {
      return
    }
    const nextHeight = clampBottomPanelHeight(
      this.panelResizeStartHeight + this.panelResizeStartY - event.clientY,
    )
    if (nextHeight === this.bottomPanelHeight) {
      return
    }
    this.bottomPanelHeight = nextHeight
    this.applyBottomPanelHeight()
  }

  private readonly handlePanelPointerUp = (): void => {
    if (this.panelResizeStartY === null) {
      return
    }
    this.panelResizeStartY = null
    this.panelResizeStartHeight = null
    this.root.classList.remove('is-resizing-panel')
    this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
  }

  private readonly handleWindowBlur = (): void => {
    this.handlePanelPointerUp()
    this.handleGitSplitterPointerUp()
    this.handleSidebarSplitterPointerUp()
    this.testSplit.endDrag()
  }

  private readonly handleWindowResize = (): void => {
    this.refresh()
  }

  private readonly handleGitSplitterPointerMove = (event: PointerEvent): void => {
    if (this.gitSplitterStartX === null || this.gitSplitterStartWidth === null) {
      return
    }
    const nextWidth = clampGitFileListWidth(
      this.gitSplitterStartWidth + event.clientX - this.gitSplitterStartX,
      this.gitWorkspaceWidth(),
    )
    if (nextWidth === this.gitFileListWidth) {
      return
    }
    this.gitFileListWidth = nextWidth
    this.applyGitFileListWidth()
  }

  private readonly handleGitSplitterPointerUp = (): void => {
    if (this.gitSplitterStartX === null) {
      return
    }
    this.gitSplitterStartX = null
    this.gitSplitterStartWidth = null
    this.root.classList.remove('is-resizing-git')
    this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
  }

  private readonly handleGitSplitterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextWidth = event.key === 'Home'
      ? MIN_GIT_FILE_LIST_WIDTH
      : event.key === 'End'
        ? maxGitFileListWidth(this.gitWorkspaceWidth())
        : this.gitFileListWidth + (event.key === 'ArrowRight' ? 16 : -16)
    this.gitFileListWidth = clampGitFileListWidth(nextWidth, this.gitWorkspaceWidth())
    this.applyGitFileListWidth()
    this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
  }

  private readonly handleSidebarSplitterPointerMove = (event: PointerEvent): void => {
    if (this.sidebarSplitterStartX === null || this.sidebarSplitterStartWidth === null) {
      return
    }
    const nextWidth = clampSidebarWidth(
      this.sidebarSplitterStartWidth + event.clientX - this.sidebarSplitterStartX,
      this.sidebarWorkspaceWidth(),
    )
    if (nextWidth === this.sidebarWidth) {
      return
    }
    this.sidebarWidth = nextWidth
    this.applySidebarWidth()
  }

  private readonly handleSidebarSplitterPointerUp = (): void => {
    if (this.sidebarSplitterStartX === null) {
      return
    }
    this.sidebarSplitterStartX = null
    this.sidebarSplitterStartWidth = null
    this.root.classList.remove('is-resizing-sidebar')
    this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
  }

  private readonly handleSidebarSplitterKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextWidth = event.key === 'Home'
      ? MIN_SIDEBAR_WIDTH
      : event.key === 'End'
        ? maxSidebarWidth(this.sidebarWorkspaceWidth())
        : this.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16)
    this.sidebarWidth = clampSidebarWidth(nextWidth, this.sidebarWorkspaceWidth())
    this.applySidebarWidth()
    this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
  }

  private readonly handlePanelKeydown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 40 : 16
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextHeight = event.key === 'Home'
      ? MIN_BOTTOM_PANEL_HEIGHT
      : event.key === 'End'
        ? maxBottomPanelHeight()
        : this.bottomPanelHeight + (event.key === 'ArrowUp' ? step : -step)
    this.bottomPanelHeight = clampBottomPanelHeight(nextHeight)
    this.applyBottomPanelHeight()
    this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
  }

  constructor(root: HTMLElement, options: PaneLayoutControllerOptions = {}) {
    this.root = root
    this.storage = options.storage
    this.window = typeof window === 'undefined' ? null : window
    this.bottomPanelHeight = readBottomPanelHeight(this.storage)
    this.gitFileListWidth = readGitFileListWidth(this.storage)
    this.sidebarWidth = readSidebarWidth(this.storage)
    this.sidebarCollapsedState = readSidebarCollapsed(this.storage)
    this.testSplit = new TestSplitLayout(root, this.storage, this.window)
    this.bindEvents()
  }

  get bottomPanelHeightValue(): number {
    return this.bottomPanelHeight
  }

  get gitFileListWidthValue(): number {
    return this.gitFileListWidth
  }

  get testListWidthValue(): number {
    return this.testSplit.value
  }

  get sidebarWidthValue(): number {
    return this.sidebarWidth
  }

  get sidebarCollapsed(): boolean {
    return this.sidebarCollapsedState
  }

  /** Hide the problem-files pane so the editor takes its width, or restore it. */
  setSidebarCollapsed(collapsed: boolean): void {
    if (collapsed === this.sidebarCollapsedState) {
      return
    }
    this.sidebarCollapsedState = collapsed
    this.handleSidebarSplitterPointerUp()
    this.applySidebarWidth()
    this.storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'collapsed' : 'expanded')
  }

  /** Apply the current dimensions after a shell or panel render. */
  apply(): void {
    this.applyBottomPanelHeight()
    this.applySidebarWidth()
    this.applyGitFileListWidth()
    this.applyTestListWidth()
  }

  /** Reclamp dimensions against the current viewport and measurable panes. */
  refresh(): void {
    const nextHeight = clampBottomPanelHeight(this.bottomPanelHeight)
    if (nextHeight !== this.bottomPanelHeight) {
      this.bottomPanelHeight = nextHeight
      this.storage?.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(this.bottomPanelHeight))
    }
    this.applyBottomPanelHeight()

    const nextWidth = clampGitFileListWidth(this.gitFileListWidth, this.gitWorkspaceWidth())
    if (nextWidth !== this.gitFileListWidth) {
      this.gitFileListWidth = nextWidth
      this.storage?.setItem(GIT_FILE_LIST_WIDTH_KEY, String(this.gitFileListWidth))
    }
    this.applyGitFileListWidth()

    const nextSidebarWidth = clampSidebarWidth(this.sidebarWidth, this.sidebarWorkspaceWidth())
    if (nextSidebarWidth !== this.sidebarWidth) {
      this.sidebarWidth = nextSidebarWidth
      this.storage?.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth))
    }
    this.applySidebarWidth()
    this.testSplit.refresh()
  }

  /** Apply only the bottom panel height after a render or a panel drag. */
  applyBottomPanelHeight(): void {
    const panel = this.query<HTMLElement>('#bottom-panel')
    panel?.style.setProperty('--bottom-panel-height', `${this.bottomPanelHeight}px`)
    const handle = this.query<HTMLElement>('#bottom-panel-resize-handle')
    handle?.setAttribute('aria-valuenow', String(this.bottomPanelHeight))
    handle?.setAttribute('aria-valuemax', String(maxBottomPanelHeight()))
  }

  /** Apply only the changed-files pane width after the Git tab becomes visible. */
  applyGitFileListWidth(): void {
    const width = clampGitFileListWidth(this.gitFileListWidth, this.gitWorkspaceWidth())
    this.gitFileListWidth = width
    const workspace = this.query<HTMLElement>('.git-workspace')
    workspace?.style.setProperty('--git-file-list-width', `${width}px`)
    const splitter = this.query<HTMLElement>('#git-splitter')
    splitter?.setAttribute('aria-valuenow', String(width))
    splitter?.setAttribute('aria-valuemax', String(maxGitFileListWidth(this.gitWorkspaceWidth())))
  }

  /** Apply only the test list width after a results render or a tab switch. */
  applyTestListWidth(): void {
    this.testSplit.apply()
  }

  /** Apply only the problem-files pane width. */
  applySidebarWidth(): void {
    const width = clampSidebarWidth(this.sidebarWidth, this.sidebarWorkspaceWidth())
    this.sidebarWidth = width
    const workspace = this.query<HTMLElement>('.workspace')
    workspace?.style.setProperty('--sidebar-width', `${width}px`)
    const splitter = this.query<HTMLElement>('#sidebar-splitter')
    splitter?.setAttribute('aria-valuenow', String(width))
    splitter?.setAttribute('aria-valuemax', String(maxSidebarWidth(this.sidebarWorkspaceWidth())))
    const collapsed = this.sidebarCollapsedState
    workspace?.classList.toggle('is-sidebar-collapsed', collapsed)
    const sidebar = this.query<HTMLElement>('.sidebar')
    if (sidebar) sidebar.hidden = collapsed
    if (splitter) splitter.hidden = collapsed
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.handleWindowBlur()
    this.testSplit.destroy()
    this.removeElementEvent('#sidebar-splitter', 'pointerdown', this.handleSidebarSplitterPointerDown)
    this.removeElementEvent('#sidebar-splitter', 'keydown', this.handleSidebarSplitterKeydown)
    this.removeElementEvent('#sidebar-splitter', 'lostpointercapture', this.handleSidebarSplitterPointerUp)
    this.removeElementEvent('#git-splitter', 'pointerdown', this.handleGitSplitterPointerDown)
    this.removeElementEvent('#git-splitter', 'keydown', this.handleGitSplitterKeydown)
    this.removeElementEvent('#git-splitter', 'lostpointercapture', this.handleGitSplitterPointerUp)
    this.removeElementEvent('#bottom-panel-resize-handle', 'pointerdown', this.handlePanelPointerDown)
    this.removeElementEvent('#bottom-panel-resize-handle', 'keydown', this.handlePanelKeydown)
    this.removeElementEvent('#bottom-panel-resize-handle', 'lostpointercapture', this.handlePanelPointerUp)
    if (!this.window) {
      return
    }
    this.window.removeEventListener('pointermove', this.handlePanelPointerMove)
    this.window.removeEventListener('pointerup', this.handlePanelPointerUp)
    this.window.removeEventListener('pointercancel', this.handlePanelPointerUp)
    this.window.removeEventListener('pointermove', this.handleGitSplitterPointerMove)
    this.window.removeEventListener('pointerup', this.handleGitSplitterPointerUp)
    this.window.removeEventListener('pointercancel', this.handleGitSplitterPointerUp)
    this.window.removeEventListener('pointermove', this.handleSidebarSplitterPointerMove)
    this.window.removeEventListener('pointerup', this.handleSidebarSplitterPointerUp)
    this.window.removeEventListener('pointercancel', this.handleSidebarSplitterPointerUp)
    this.window.removeEventListener('blur', this.handleWindowBlur)
    this.window.removeEventListener('resize', this.handleWindowResize)
  }

  private bindEvents(): void {
    this.addElementEvent('#sidebar-splitter', 'pointerdown', this.handleSidebarSplitterPointerDown)
    this.addElementEvent('#sidebar-splitter', 'keydown', this.handleSidebarSplitterKeydown)
    this.addElementEvent('#sidebar-splitter', 'lostpointercapture', this.handleSidebarSplitterPointerUp)
    this.addElementEvent('#git-splitter', 'pointerdown', this.handleGitSplitterPointerDown)
    this.addElementEvent('#git-splitter', 'keydown', this.handleGitSplitterKeydown)
    this.addElementEvent('#git-splitter', 'lostpointercapture', this.handleGitSplitterPointerUp)
    this.addElementEvent('#bottom-panel-resize-handle', 'pointerdown', this.handlePanelPointerDown)
    this.addElementEvent('#bottom-panel-resize-handle', 'keydown', this.handlePanelKeydown)
    this.addElementEvent('#bottom-panel-resize-handle', 'lostpointercapture', this.handlePanelPointerUp)
    if (!this.window) {
      return
    }
    this.window.addEventListener('pointermove', this.handlePanelPointerMove)
    this.window.addEventListener('pointerup', this.handlePanelPointerUp)
    this.window.addEventListener('pointercancel', this.handlePanelPointerUp)
    this.window.addEventListener('pointermove', this.handleGitSplitterPointerMove)
    this.window.addEventListener('pointerup', this.handleGitSplitterPointerUp)
    this.window.addEventListener('pointercancel', this.handleGitSplitterPointerUp)
    this.window.addEventListener('pointermove', this.handleSidebarSplitterPointerMove)
    this.window.addEventListener('pointerup', this.handleSidebarSplitterPointerUp)
    this.window.addEventListener('pointercancel', this.handleSidebarSplitterPointerUp)
    this.window.addEventListener('blur', this.handleWindowBlur)
    this.window.addEventListener('resize', this.handleWindowResize)
  }

  private readonly handlePanelPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    this.panelResizeStartY = event.clientY
    this.panelResizeStartHeight = this.bottomPanelHeight
    this.root.classList.add('is-resizing-panel')
    this.query<HTMLElement>('#bottom-panel-resize-handle')?.setPointerCapture?.(event.pointerId)
  }

  private readonly handleGitSplitterPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    this.gitSplitterStartX = event.clientX
    this.gitSplitterStartWidth = this.gitFileListWidth
    this.root.classList.add('is-resizing-git')
    this.query<HTMLElement>('#git-splitter')?.setPointerCapture?.(event.pointerId)
  }

  private readonly handleSidebarSplitterPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    this.sidebarSplitterStartX = event.clientX
    this.sidebarSplitterStartWidth = this.sidebarWidth
    this.root.classList.add('is-resizing-sidebar')
    this.query<HTMLElement>('#sidebar-splitter')?.setPointerCapture?.(event.pointerId)
  }

  private gitWorkspaceWidth(): number {
    const workspace = this.query<HTMLElement>('.git-workspace')
    return workspace && workspace.clientWidth > 0 ? workspace.clientWidth : 900
  }

  private sidebarWorkspaceWidth(): number {
    const workspace = this.query<HTMLElement>('.workspace')
    if (workspace && workspace.clientWidth > 0) {
      return workspace.clientWidth
    }
    if (this.window && this.window.innerWidth > 0) {
      return this.window.innerWidth
    }
    return 1000
  }

  private query<T extends HTMLElement>(selector: string): T | null {
    return this.root.querySelector<T>(selector)
  }

  private addElementEvent<K extends keyof HTMLElementEventMap>(
    selector: string,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    this.query<HTMLElement>(selector)?.addEventListener(type, listener as EventListener)
  }

  private removeElementEvent<K extends keyof HTMLElementEventMap>(
    selector: string,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    const element = this.query<HTMLElement>(selector)
    if (!element) {
      return
    }
    element.removeEventListener(type, listener as EventListener)
  }
}

export function createPaneLayoutController(
  root: HTMLElement,
  options: PaneLayoutControllerOptions = {},
): PaneLayoutController {
  return new PaneLayoutController(root, options)
}

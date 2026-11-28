import {
  clampTestListWidth,
  maxTestListWidth,
  MIN_TEST_LIST_WIDTH,
  readTestListWidth,
  TEST_LIST_WIDTH_KEY,
} from './layout'

const SPLITTER_SELECTOR = '#test-splitter'

/**
 * Owns the draggable split between the test list and the run output.
 *
 * The results view rebuilds the split on every render, so events are
 * delegated from the static `#test-body` and the width lives on the static
 * `#tests-panel` as a CSS variable that each new split inherits.
 */
export class TestSplitLayout {
  private width: number
  private dragStartX: number | null = null
  private dragStartWidth: number | null = null

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const splitter = splitterFrom(event.target)
    if (event.button !== 0 || !splitter) {
      return
    }
    event.preventDefault()
    this.dragStartX = event.clientX
    this.dragStartWidth = this.width
    this.root.classList.add('is-resizing-tests')
    splitter.setPointerCapture?.(event.pointerId)
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.dragStartX === null || this.dragStartWidth === null) {
      return
    }
    const nextWidth = clampTestListWidth(
      this.dragStartWidth + event.clientX - this.dragStartX,
      this.workspaceWidth(),
    )
    if (nextWidth === this.width) {
      return
    }
    this.width = nextWidth
    this.apply()
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (!splitterFrom(event.target)) {
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const nextWidth = event.key === 'Home'
      ? MIN_TEST_LIST_WIDTH
      : event.key === 'End'
        ? maxTestListWidth(this.workspaceWidth())
        : this.width + (event.key === 'ArrowRight' ? 16 : -16)
    this.width = clampTestListWidth(nextWidth, this.workspaceWidth())
    this.apply()
    this.storage?.setItem(TEST_LIST_WIDTH_KEY, String(this.width))
  }

  /** Ends a drag; also used for pointer cancel, lost capture, and window blur. */
  readonly endDrag = (): void => {
    if (this.dragStartX === null) {
      return
    }
    this.dragStartX = null
    this.dragStartWidth = null
    this.root.classList.remove('is-resizing-tests')
    this.storage?.setItem(TEST_LIST_WIDTH_KEY, String(this.width))
  }

  constructor(
    private readonly root: HTMLElement,
    private readonly storage: Storage | undefined,
    private readonly window: Window | null,
  ) {
    this.width = readTestListWidth(storage)
    const body = this.root.querySelector<HTMLElement>('#test-body')
    body?.addEventListener('pointerdown', this.handlePointerDown)
    body?.addEventListener('keydown', this.handleKeydown)
    body?.addEventListener('lostpointercapture', this.endDrag)
    this.window?.addEventListener('pointermove', this.handlePointerMove)
    this.window?.addEventListener('pointerup', this.endDrag)
    this.window?.addEventListener('pointercancel', this.endDrag)
  }

  get value(): number {
    return this.width
  }

  /** Apply the width after a results render or when the Tests tab becomes measurable. */
  apply(): void {
    const available = this.workspaceWidth()
    this.width = clampTestListWidth(this.width, available)
    this.root.querySelector<HTMLElement>('#tests-panel')
      ?.style.setProperty('--test-list-width', `${this.width}px`)
    const splitter = this.root.querySelector<HTMLElement>(SPLITTER_SELECTOR)
    splitter?.setAttribute('aria-valuenow', String(this.width))
    splitter?.setAttribute('aria-valuemax', String(maxTestListWidth(available)))
  }

  /** Reclamp against the current workspace and persist a changed width. */
  refresh(): void {
    const nextWidth = clampTestListWidth(this.width, this.workspaceWidth())
    if (nextWidth !== this.width) {
      this.width = nextWidth
      this.storage?.setItem(TEST_LIST_WIDTH_KEY, String(this.width))
    }
    this.apply()
  }

  destroy(): void {
    this.endDrag()
    const body = this.root.querySelector<HTMLElement>('#test-body')
    body?.removeEventListener('pointerdown', this.handlePointerDown)
    body?.removeEventListener('keydown', this.handleKeydown)
    body?.removeEventListener('lostpointercapture', this.endDrag)
    this.window?.removeEventListener('pointermove', this.handlePointerMove)
    this.window?.removeEventListener('pointerup', this.endDrag)
    this.window?.removeEventListener('pointercancel', this.endDrag)
  }

  /** The split's own width, or a fallback while the Tests tab is hidden or idle. */
  private workspaceWidth(): number {
    const workspace = this.root.querySelector<HTMLElement>('.test-results-workspace')
    return workspace && workspace.clientWidth > 0 ? workspace.clientWidth : 900
  }
}

function splitterFrom(target: EventTarget | null): HTMLElement | null {
  const element = target as HTMLElement | null
  return typeof element?.closest === 'function' ? element.closest<HTMLElement>(SPLITTER_SELECTOR) : null
}

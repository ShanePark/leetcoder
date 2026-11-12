/** A step shown in the list; an object adds a short description under its label. */
export type ProgressOverlayStage = string | { label: string; detail?: string }

export interface ProgressOverlayState {
  /** Small label above the title, e.g. "Git" or "AI". */
  kicker: string
  title: string
  stages: readonly ProgressOverlayStage[]
  /** Index into stages of the step in progress. */
  current: number
  /** Optional detail line for the current step. Defaults to the step's label. */
  detail?: string
  footnote?: string
}

interface MountedOverlay {
  overlay: HTMLElement
  kicker: HTMLElement
  title: HTMLElement
  message: HTMLElement
  stepLabel: HTMLElement
  track: HTMLElement
  fill: HTMLElement
  stageList: HTMLElement
  stageItems: HTMLElement[]
  stageSignature: string
  footnote: HTMLElement
  footnoteText: HTMLElement
  focusReturn: HTMLElement | null
}

const mountedOverlays = new WeakMap<HTMLElement, MountedOverlay>()

/**
 * Mount, update, or remove (with `null`) the blocking progress modal. Updates
 * reuse the existing dialog node so focus and screen-reader context survive
 * every step change; removal restores the app shell and the previous focus.
 */
export function syncProgressOverlay(root: HTMLElement, state: ProgressOverlayState | null): void {
  const modalRoot = root.id === 'modal-root'
    ? root
    : root.querySelector<HTMLElement>('#modal-root')
  if (!modalRoot) return

  const documentRef = root.ownerDocument
  let mounted = mountedOverlays.get(modalRoot)
  if (!state) {
    if (!mounted) return
    mountedOverlays.delete(modalRoot)
    mounted.overlay.remove()
    const appShell = documentRef.querySelector<HTMLElement>('.app-shell')
    documentRef.body.classList.remove('is-progress-overlay')
    appShell?.removeAttribute('inert')
    appShell?.removeAttribute('aria-hidden')
    if (mounted.focusReturn?.isConnected) mounted.focusReturn.focus()
    return
  }

  if (!mounted) {
    const activeElement = documentRef.activeElement
    const focusReturn = activeElement instanceof HTMLElement && activeElement !== documentRef.body
      ? activeElement
      : null
    mounted = createOverlay(documentRef, focusReturn)
    updateOverlay(documentRef, mounted, state)
    mountedOverlays.set(modalRoot, mounted)
    modalRoot.append(mounted.overlay)
    const appShell = documentRef.querySelector<HTMLElement>('.app-shell')
    appShell?.setAttribute('inert', '')
    appShell?.setAttribute('aria-hidden', 'true')
    documentRef.body.classList.add('is-progress-overlay')
    mounted.overlay.querySelector<HTMLElement>('.progress-overlay-dialog')?.focus()
    return
  }
  updateOverlay(documentRef, mounted, state)
}

export function clearProgressOverlay(root: HTMLElement): void {
  syncProgressOverlay(root, null)
}

function createOverlay(documentRef: Document, focusReturn: HTMLElement | null): MountedOverlay {
  const make = (tag: string, className?: string): HTMLElement => {
    const element = documentRef.createElement(tag)
    if (className) element.className = className
    return element
  }

  const overlay = make('div', 'progress-overlay-backdrop')
  overlay.dataset.progressOverlay = ''
  overlay.setAttribute('role', 'presentation')

  const dialog = make('section', 'progress-overlay-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-busy', 'true')
  dialog.setAttribute('aria-labelledby', 'progress-overlay-title')
  dialog.setAttribute('aria-describedby', 'progress-overlay-message')
  dialog.setAttribute('tabindex', '-1')

  const intro = make('div', 'progress-overlay-intro')
  const spinner = make('div', 'progress-overlay-spinner')
  spinner.setAttribute('aria-hidden', 'true')
  spinner.append(make('span'))
  const heading = make('div', 'progress-overlay-heading')
  const kicker = make('p', 'progress-overlay-kicker')
  const title = make('h2')
  title.id = 'progress-overlay-title'
  const message = make('p')
  message.id = 'progress-overlay-message'
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  message.setAttribute('aria-atomic', 'true')
  heading.append(kicker, title, message)
  intro.append(spinner, heading)

  const summary = make('div', 'progress-overlay-summary')
  const stepLabel = make('span', 'progress-overlay-step-label')
  summary.append(stepLabel)

  const track = make('div', 'progress-overlay-track')
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '1')
  const fill = make('span', 'progress-overlay-fill')
  const shimmer = make('span', 'progress-overlay-shimmer')
  shimmer.setAttribute('aria-hidden', 'true')
  track.append(fill, shimmer)

  const stageList = make('ol', 'progress-overlay-stages')

  const footnote = make('p', 'progress-overlay-footnote')
  const footnoteDot = make('span', 'progress-overlay-footnote-dot')
  footnoteDot.setAttribute('aria-hidden', 'true')
  const footnoteText = make('span')
  footnote.append(footnoteDot, footnoteText)

  dialog.append(intro, summary, track, stageList, footnote)
  overlay.append(dialog)
  return {
    overlay,
    kicker,
    title,
    message,
    stepLabel,
    track,
    fill,
    stageList,
    stageItems: [],
    stageSignature: '',
    footnote,
    footnoteText,
    focusReturn,
  }
}

function updateOverlay(documentRef: Document, mounted: MountedOverlay, state: ProgressOverlayState): void {
  const stages = state.stages.map((stage) => typeof stage === 'string' ? { label: stage } : stage)
  const total = stages.length
  const currentIndex = Math.min(Math.max(state.current, 0), Math.max(total - 1, 0))
  const currentLabel = stages[currentIndex]?.label ?? ''
  const step = currentIndex + 1

  setText(mounted.kicker, state.kicker)
  setText(mounted.title, state.title)
  setText(mounted.message, state.detail ?? currentLabel)
  setText(mounted.stepLabel, `Step ${step} of ${total}`)
  mounted.footnote.hidden = !state.footnote
  setText(mounted.footnoteText, state.footnote ?? '')

  mounted.track.setAttribute('aria-label', `${state.kicker} progress`)
  mounted.track.setAttribute('aria-valuemax', String(total))
  mounted.track.setAttribute('aria-valuenow', String(step))
  mounted.track.setAttribute('aria-valuetext', `Step ${step} of ${total} — ${currentLabel}`)
  mounted.fill.style.setProperty('width', `${total ? Math.round((step / total) * 100) : 0}%`)
  mounted.stageList.setAttribute('aria-label', `${state.kicker} steps`)

  const signature = JSON.stringify(stages)
  if (signature !== mounted.stageSignature) {
    mounted.stageSignature = signature
    mounted.stageItems = stages.map((stage) => {
      const item = documentRef.createElement('li')
      item.className = 'progress-overlay-stage'
      const mark = documentRef.createElement('span')
      mark.className = 'progress-overlay-stage-mark'
      mark.setAttribute('aria-hidden', 'true')
      const copy = documentRef.createElement('span')
      copy.className = 'progress-overlay-stage-copy'
      const label = documentRef.createElement('strong')
      label.textContent = stage.label
      copy.append(label)
      if (stage.detail) {
        const detail = documentRef.createElement('small')
        detail.textContent = stage.detail
        copy.append(detail)
      }
      item.append(mark, copy)
      return item
    })
    mounted.stageList.replaceChildren(...mounted.stageItems)
  }

  mounted.stageItems.forEach((item, index) => {
    const itemState = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'pending'
    item.dataset.state = itemState
    if (itemState === 'current') item.setAttribute('aria-current', 'step')
    else item.removeAttribute('aria-current')
    const spoken = itemState === 'current' ? 'in progress' : itemState
    item.setAttribute('aria-label', `${stages[index]!.label}: ${spoken}`)
    const mark = item.firstElementChild as HTMLElement | null
    if (mark) setText(mark, itemState === 'complete' ? '✓' : itemState === 'current' ? '' : String(index + 1))
  })
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

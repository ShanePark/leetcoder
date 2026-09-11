/**
 * The visible stages of a Commit & Push operation. Git does not expose a
 * byte-level progress value, so the operation is represented by the four
 * user meaningful phases already reported by GitController.
 */
export const GIT_PROGRESS_STAGES = [
  { id: 'preparing', label: 'Prepare changes', detail: 'Saving the current file before committing' },
  { id: 'committing', label: 'Create commit', detail: 'Writing the selected changes to Git' },
  { id: 'pushing', label: 'Push changes', detail: 'Sending the commit to the remote repository' },
  { id: 'refreshing', label: 'Refresh status', detail: 'Loading the latest repository status' },
] as const

export type GitProgressStage = typeof GIT_PROGRESS_STAGES[number]['id']

const GIT_PROGRESS_LABELS = [
  'Preparing commit and push…',
  'Committing changes…',
  'Pushing changes…',
  'Refreshing Git status…',
] as const

export function gitProgressStageIndex(label: string | null | undefined): number {
  const index = GIT_PROGRESS_LABELS.indexOf(label as typeof GIT_PROGRESS_LABELS[number])
  return index >= 0 ? index : 0
}

/** Render the initial, accessible modal mounted while Commit & Push runs. */
export function renderGitProgressOverlay(): string {
  const stages = GIT_PROGRESS_STAGES.map((stage, index) => {
    const current = index === 0
    return `<li class="git-progress-stage" data-git-stage="${stage.id}" data-state="${current ? 'current' : 'pending'}"${current ? ' aria-current="step"' : ''} aria-label="${escapeProgressText(`${stage.label}: ${current ? 'in progress' : 'pending'}`)}"><span class="git-progress-stage-mark" aria-hidden="true">${current ? '' : index + 1}</span><span class="git-progress-stage-copy"><strong>${escapeProgressText(stage.label)}</strong><small>${escapeProgressText(stage.detail)}</small></span></li>`
  }).join('')

  return `<div class="git-progress-backdrop" data-git-progress-overlay role="presentation"><section class="git-progress-dialog" role="dialog" aria-modal="true" aria-busy="true" aria-labelledby="git-progress-title" aria-describedby="git-progress-message" tabindex="-1"><div class="git-progress-intro"><div class="git-progress-spinner" aria-hidden="true"><span></span></div><div class="git-progress-heading"><p class="git-progress-kicker">COMMIT &amp; PUSH</p><h2 id="git-progress-title">Publishing changes</h2><p id="git-progress-message" data-git-progress-message role="status" aria-live="polite" aria-atomic="true">Preparing commit and push…</p></div></div><div class="git-progress-summary"><span class="git-progress-step-label" data-git-progress-step>Step 1 of ${GIT_PROGRESS_STAGES.length}</span></div><div class="git-progress-track" role="progressbar" aria-label="Commit and push progress" aria-valuemin="1" aria-valuemax="${GIT_PROGRESS_STAGES.length}" aria-valuenow="1" aria-valuetext="Step 1 of ${GIT_PROGRESS_STAGES.length} — ${escapeProgressText(GIT_PROGRESS_STAGES[0]!.label)}"><span class="git-progress-fill" data-git-progress-fill></span><span class="git-progress-shimmer" aria-hidden="true"></span></div><ol class="git-progress-stages" aria-label="Commit and push steps">${stages}</ol><p class="git-progress-footnote"><span class="git-progress-footnote-dot" aria-hidden="true"></span>Keep this window open while the changes are published.</p></section></div>`
}

/**
 * Mount or update the modal without rebuilding it on every phase change.
 * Keeping the existing dialog node preserves focus and screen-reader context.
 */
export function syncGitProgressOverlay(
  root: HTMLElement,
  active: boolean,
  label: string | null | undefined,
): void {
  const modalRoot = root.id === 'modal-root'
    ? root
    : root.querySelector<HTMLElement>('#modal-root')
  if (!modalRoot) return

  const documentRef = root.ownerDocument
  const existing = modalRoot.querySelector<HTMLElement>('[data-git-progress-overlay]')
  if (!active || !label) {
    if (!existing && !gitProgressOverlayState.has(root)) return
    existing?.remove()
    restoreGitProgressInteraction(root, modalRoot)
    gitProgressOverlayState.delete(root)
    return
  }

  let overlay = existing
  if (!overlay) {
    const activeElement = documentRef.activeElement
    const focusReturn = activeElement instanceof HTMLElement && activeElement !== documentRef.body
      ? activeElement
      : null
    gitProgressOverlayState.set(root, { focusReturn })
    modalRoot.insertAdjacentHTML('beforeend', renderGitProgressOverlay())
    overlay = modalRoot.querySelector<HTMLElement>('[data-git-progress-overlay]')
    documentRef.querySelector<HTMLElement>('.app-shell')?.setAttribute('inert', '')
    documentRef.querySelector<HTMLElement>('.app-shell')?.setAttribute('aria-hidden', 'true')
    documentRef.body.classList.add('is-git-progress')
    overlay?.querySelector<HTMLElement>('.git-progress-dialog')?.focus()
  }
  if (!overlay) return

  const currentIndex = gitProgressStageIndex(label)
  const stage = GIT_PROGRESS_STAGES[currentIndex]!
  overlay.dataset.stage = stage.id
  const message = overlay.querySelector<HTMLElement>('[data-git-progress-message]')
  if (message && message.textContent !== label) message.textContent = label
  const stepLabel = overlay.querySelector<HTMLElement>('[data-git-progress-step]')
  if (stepLabel) stepLabel.textContent = `Step ${currentIndex + 1} of ${GIT_PROGRESS_STAGES.length}`
  const track = overlay.querySelector<HTMLElement>('.git-progress-track')
  if (track) {
    const step = currentIndex + 1
    const percent = Math.round((step / GIT_PROGRESS_STAGES.length) * 100)
    track.setAttribute('aria-valuenow', String(step))
    track.setAttribute('aria-valuetext', `Step ${step} of ${GIT_PROGRESS_STAGES.length} — ${stage.label}`)
    overlay.querySelector<HTMLElement>('[data-git-progress-fill]')?.style.setProperty('width', `${percent}%`)
  }
  overlay.querySelectorAll<HTMLElement>('[data-git-stage]').forEach((item, index) => {
    const state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'pending'
    const itemStage = GIT_PROGRESS_STAGES[index]
    if (!itemStage) return
    item.dataset.state = state
    item.toggleAttribute('aria-current', state === 'current')
    if (state === 'current') item.setAttribute('aria-current', 'step')
    item.setAttribute('aria-label', `${itemStage.label}: ${state === 'complete' ? 'complete' : state === 'current' ? 'in progress' : 'pending'}`)
    const mark = item.querySelector<HTMLElement>('.git-progress-stage-mark')
    if (mark) mark.textContent = state === 'complete' ? '✓' : state === 'current' ? '' : String(index + 1)
  })
}

/** Remove the modal when the application is torn down during a Git request. */
export function clearGitProgressOverlay(root: HTMLElement): void {
  syncGitProgressOverlay(root, false, null)
}

interface GitProgressOverlayState {
  focusReturn: HTMLElement | null
}

const gitProgressOverlayState = new WeakMap<HTMLElement, GitProgressOverlayState>()

function restoreGitProgressInteraction(root: HTMLElement, modalRoot: HTMLElement): void {
  const appShell = root.ownerDocument.querySelector<HTMLElement>('.app-shell')
  const updateOverlayActive = Boolean(modalRoot.querySelector('[data-update-progress-overlay]'))
  root.ownerDocument.body.classList.remove('is-git-progress')
  if (!updateOverlayActive) {
    appShell?.removeAttribute('inert')
    appShell?.removeAttribute('aria-hidden')
  }
  const returnFocus = gitProgressOverlayState.get(root)?.focusReturn
  if (!updateOverlayActive && returnFocus?.isConnected) returnFocus.focus()
}

function escapeProgressText(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character] ?? character))
}

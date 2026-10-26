import type { UpdateBuild } from './backend'
import { iconFor, type AppIcon } from './icons'
import type { UpdatePhase } from './update-controller'

/** Native progress stages: three while building, two while applying. */
export const UPDATE_PROGRESS_STAGES = [
  { id: 'validating', phase: 'build', message: 'Checking the latest local commit' },
  { id: 'building', phase: 'build', message: 'Building the update' },
  { id: 'staging', phase: 'build', message: 'Preparing the update' },
  { id: 'preparing', phase: 'apply', message: 'Installing the update' },
  { id: 'restarting', phase: 'apply', message: 'Restarting leetcoder' },
] as const

export type UpdateProgressStage = typeof UPDATE_PROGRESS_STAGES[number]['id']
export type UpdateProgressPhase = typeof UPDATE_PROGRESS_STAGES[number]['phase']

export interface UpdateProgressEvent {
  stage: UpdateProgressStage
  step: number
  total: number
  message: string
  detail?: string
}

export interface NormalizedUpdateProgress {
  stage: UpdateProgressStage
  phase: UpdateProgressPhase
  step: number
  total: number
  message: string
  detail?: string
}

/** Label, icon, and busy state shared by the sidebar button and the app menu. */
export interface UpdateActionPresentation {
  icon: AppIcon
  busy: boolean
  label: string
  title: string
  menuLabel: string
  menuDetail: string
}

const UPDATE_ACTIONS: Record<Exclude<UpdatePhase, 'hidden'>, UpdateActionPresentation> = {
  available: {
    icon: 'download',
    busy: false,
    label: 'Update leetcoder',
    title: 'Update available — build it in the background',
    menuLabel: 'Update leetcoder',
    menuDetail: 'Build in background',
  },
  building: {
    icon: 'loader',
    busy: true,
    label: 'Building update',
    title: 'Building the update in the background',
    menuLabel: 'Building update…',
    menuDetail: 'In background',
  },
  ready: {
    icon: 'refresh',
    busy: false,
    label: 'Restart to update',
    title: 'Update ready — restart to install the new build',
    menuLabel: 'Restart to update',
    menuDetail: 'Install the new build',
  },
  applying: {
    icon: 'loader',
    busy: true,
    label: 'Restarting leetcoder',
    title: 'Installing the update and restarting',
    menuLabel: 'Restarting leetcoder…',
    menuDetail: '',
  },
}

export function updateActionPresentation(phase: UpdatePhase): UpdateActionPresentation | null {
  return phase === 'hidden' ? null : UPDATE_ACTIONS[phase]
}

export function isUpdateProgressStage(value: string): value is UpdateProgressStage {
  return UPDATE_PROGRESS_STAGES.some((stage) => stage.id === value)
}

/** Returns null for an unknown stage so it cannot be shown in the wrong phase. */
export function normaliseUpdateProgress(payload: unknown): NormalizedUpdateProgress | null {
  const value = isRecord(payload) ? payload : {}
  if (typeof value.stage !== 'string' || !isUpdateProgressStage(value.stage)) return null
  const stage = UPDATE_PROGRESS_STAGES.find((item) => item.id === value.stage)!
  const phaseStages = UPDATE_PROGRESS_STAGES.filter((item) => item.phase === stage.phase)
  const defaultTotal = phaseStages.length
  const total = positiveInteger(value.total, defaultTotal)
  const step = clamp(positiveInteger(value.step, phaseStages.indexOf(stage) + 1), 1, total)
  const message = typeof value.message === 'string' && value.message.trim()
    ? value.message.trim()
    : stage.message
  const detail = typeof value.detail === 'string' && value.detail.trim()
    ? value.detail.trim()
    : undefined
  const progress = { stage: stage.id, phase: stage.phase, step, total, message }
  return detail ? { ...progress, detail } : progress
}

export function formatUpdateElapsed(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  if (elapsed < 60) return `${elapsed}s`
  const minutes = Math.floor(elapsed / 60)
  const remainder = elapsed % 60
  if (minutes < 60) return `${minutes}m ${remainder}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export type UpdateStatusState =
  | { kind: 'idle' }
  | { kind: 'building' | 'applying'; startedAt: number; progress: NormalizedUpdateProgress | null }
  | { kind: 'ready'; commit: string }
  | { kind: 'failed'; message: string }

export interface UpdateStatusModel {
  visible: boolean
  tone: 'busy' | 'ready' | 'error'
  message: string
  /** Secondary monospace text: the latest build output line or the commit. */
  detail: string
  /** Full text for the tooltip when the message or detail is ellipsized. */
  title: string
  elapsedSeconds: number | null
  restart: boolean
  dismiss: boolean
}

const SHORT_COMMIT_LENGTH = 7

/** Pure description of the status row so its states can be tested without a DOM. */
export function describeUpdateStatus(state: UpdateStatusState, now: number): UpdateStatusModel {
  const base = { visible: true, detail: '', title: '', elapsedSeconds: null, restart: false, dismiss: false }
  switch (state.kind) {
    case 'idle':
      return { ...base, visible: false, tone: 'busy', message: '' }
    case 'building': {
      const message = state.progress?.message ?? UPDATE_PROGRESS_STAGES[0].message
      const detail = state.progress?.stage === 'building' ? state.progress.detail ?? '' : ''
      return {
        ...base,
        tone: 'busy',
        message,
        detail,
        title: detail,
        elapsedSeconds: elapsedSince(state.startedAt, now),
      }
    }
    case 'applying': {
      const detail = state.progress?.message ?? UPDATE_PROGRESS_STAGES[3].message
      return {
        ...base,
        tone: 'busy',
        message: 'Restarting leetcoder…',
        detail,
        elapsedSeconds: elapsedSince(state.startedAt, now),
      }
    }
    case 'ready':
      return {
        ...base,
        tone: 'ready',
        message: 'Update ready',
        detail: state.commit.slice(0, SHORT_COMMIT_LENGTH),
        title: `Build ${state.commit}`,
        restart: true,
      }
    case 'failed':
      return {
        ...base,
        tone: 'error',
        message: `Update failed: ${errorSummary(state.message)}`,
        title: state.message,
        dismiss: true,
      }
  }
}

export interface UpdateStatusViewOptions {
  onRestart: () => void
  now?: () => number
}

export interface UpdateStatusView {
  /** Mirror the controller phase; `hidden`/`available` keep a failure visible until dismissed. */
  setPhase: (phase: UpdatePhase, build: UpdateBuild | null) => void
  update: (payload: unknown) => void
  showFailed: (message: string) => void
  dispose: () => void
}

/**
 * The slim status row at the bottom of the window. It is part of the layout,
 * so it shrinks the workspace instead of covering it, and it never moves focus.
 */
export function createUpdateStatusView(
  root: HTMLElement,
  options: UpdateStatusViewOptions,
): UpdateStatusView {
  const now = options.now ?? Date.now
  const row = root.querySelector<HTMLElement>('#update-status')
  const icon = root.querySelector<HTMLElement>('#update-status-icon')
  const message = root.querySelector<HTMLElement>('#update-status-message')
  const detail = root.querySelector<HTMLElement>('#update-status-detail')
  const elapsed = root.querySelector<HTMLTimeElement>('#update-status-elapsed')
  const restart = root.querySelector<HTMLButtonElement>('#update-status-restart')
  const dismiss = root.querySelector<HTMLButtonElement>('#update-status-dismiss')
  let state: UpdateStatusState = { kind: 'idle' }
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let renderedTone: UpdateStatusModel['tone'] | null = null
  let disposed = false

  const handleRestart = (): void => options.onRestart()
  const handleDismiss = (): void => {
    if (state.kind === 'failed') setState({ kind: 'idle' })
  }
  restart?.addEventListener('click', handleRestart)
  dismiss?.addEventListener('click', handleDismiss)
  if (dismiss && !dismiss.firstChild) dismiss.append(iconFor('close', 'button-icon'))

  const render = (): void => {
    if (!row) return
    const model = describeUpdateStatus(state, now())
    row.hidden = !model.visible
    if (!model.visible) return
    row.dataset.tone = model.tone
    if (icon && renderedTone !== model.tone) {
      renderedTone = model.tone
      const name: AppIcon = model.tone === 'busy' ? 'loader' : model.tone === 'ready' ? 'check' : 'alert'
      icon.replaceChildren(iconFor(name, 'update-status-svg'))
      icon.classList.toggle('is-spinning', model.tone === 'busy')
    }
    if (message && message.textContent !== model.message) message.textContent = model.message
    if (detail) detail.textContent = model.detail
    row.title = model.title
    if (elapsed) {
      elapsed.hidden = model.elapsedSeconds === null
      if (model.elapsedSeconds !== null) {
        const formatted = formatUpdateElapsed(model.elapsedSeconds)
        elapsed.textContent = formatted
        elapsed.dateTime = `PT${model.elapsedSeconds}S`
        elapsed.setAttribute('aria-label', `${formatted} elapsed`)
      }
    }
    if (restart) restart.hidden = !model.restart
    if (dismiss) dismiss.hidden = !model.dismiss
  }

  const stopTimer = (): void => {
    if (elapsedTimer === null) return
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }

  const setState = (next: UpdateStatusState): void => {
    if (disposed) return
    state = next
    const timing = next.kind === 'building' || next.kind === 'applying'
    if (timing && elapsedTimer === null) elapsedTimer = setInterval(render, 1000)
    if (!timing) stopTimer()
    render()
  }

  return {
    setPhase: (phase, build) => {
      if (phase === 'building' && state.kind !== 'building') {
        setState({ kind: 'building', startedAt: now(), progress: null })
      } else if (phase === 'applying' && state.kind !== 'applying') {
        setState({ kind: 'applying', startedAt: now(), progress: null })
      } else if (phase === 'ready' && build) {
        setState({ kind: 'ready', commit: build.commit })
      } else if ((phase === 'hidden' || phase === 'available') && state.kind !== 'failed') {
        setState({ kind: 'idle' })
      }
    },
    update: (payload) => {
      const progress = normaliseUpdateProgress(payload)
      if (!progress) return
      const expected = progress.phase === 'build' ? 'building' : 'applying'
      if (state.kind !== expected) return
      setState({ ...state, progress })
    },
    showFailed: (failure) => setState({ kind: 'failed', message: failure }),
    dispose: () => {
      if (disposed) return
      stopTimer()
      disposed = true
      restart?.removeEventListener('click', handleRestart)
      dismiss?.removeEventListener('click', handleDismiss)
    },
  }
}

/** Lazily subscribe so the Vite browser preview remains independent of Tauri. */
export async function listenForUpdateProgress(
  handler: (payload: unknown) => void,
): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<UpdateProgressEvent>('update-progress', (event) => handler(event.payload))
  } catch {
    return () => {}
  }
}

function elapsedSince(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** Native errors can carry a build log; the row shows its first line. */
function errorSummary(message: string): string {
  return message.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Unknown error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

import type { UpdateBuild } from './backend'
import { iconFor, type AppIcon } from './icons'
import type { UpdatePhase } from './update-controller'

/**
 * Native progress stages in the order they run. The build phase has four
 * steps (validating and frontend share step 1); the apply phase has two.
 */
export const UPDATE_PROGRESS_STAGES = [
  { id: 'validating', phase: 'build', step: 1, message: 'Checking the latest local commit' },
  { id: 'frontend', phase: 'build', step: 1, message: 'Building the frontend' },
  { id: 'compiling', phase: 'build', step: 2, message: 'Compiling the app' },
  { id: 'bundling', phase: 'build', step: 3, message: 'Bundling the app' },
  { id: 'staging', phase: 'build', step: 4, message: 'Preparing the update' },
  { id: 'preparing', phase: 'apply', step: 1, message: 'Installing the update' },
  { id: 'restarting', phase: 'apply', step: 2, message: 'Restarting leetcoder' },
] as const

export type UpdateProgressStage = typeof UPDATE_PROGRESS_STAGES[number]['id']
export type UpdateProgressPhase = typeof UPDATE_PROGRESS_STAGES[number]['phase']
export type UpdateBuildStage = Extract<typeof UPDATE_PROGRESS_STAGES[number], { phase: 'build' }>['id']

/** Build stage ids in run order. */
export const UPDATE_BUILD_STAGES = UPDATE_PROGRESS_STAGES
  .filter((stage) => stage.phase === 'build')
  .map((stage) => stage.id) as UpdateBuildStage[]

/** Milliseconds each build stage took in the last successful build. */
export type UpdateStageDurations = Partial<Record<UpdateBuildStage, number>>

export const UPDATE_BUILD_DURATIONS_KEY = 'leetcoder.update-build-durations'

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
  const defaultTotal = Math.max(...UPDATE_PROGRESS_STAGES
    .filter((item) => item.phase === stage.phase)
    .map((item) => item.step))
  const total = positiveInteger(value.total, defaultTotal)
  const step = clamp(positiveInteger(value.step, stage.step), 1, total)
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

/** Remaining time as compact text, e.g. `40s` or `1m 5s`; partial seconds round up. */
export function formatUpdateRemaining(milliseconds: number): string {
  return formatUpdateElapsed(Math.ceil(Math.max(0, milliseconds) / 1000))
}

export interface UpdateBuildEstimateInput {
  stage: UpdateBuildStage
  step: number
  total: number
  /** Milliseconds spent in the current stage so far. */
  stageElapsed: number
  history: UpdateStageDurations | null
  /** Highest fraction already shown in this build; the result never drops below it. */
  floor?: number
}

export interface UpdateBuildEstimate {
  /** Bar fill from 0 to 1. */
  fraction: number
  /** Whole percent, or null when there is no usable history. */
  percent: number | null
  /**
   * Estimated milliseconds left, or null without history or when the last
   * stage overruns. An earlier stage that overruns leaves the later stages'
   * estimates.
   */
  remaining: number | null
  /** The current stage has taken longer than its estimate. */
  overrun: boolean
}

/** Share of the current stage's estimate the bar may fill before the stage ends. */
const STAGE_FILL_LIMIT = 0.95

/**
 * Estimates build progress from the previous successful build's stage
 * durations. Stages before the current one count as done, including any the
 * native side skipped. Without an estimate for the current stage it falls
 * back to the completed-step fraction.
 */
export function estimateUpdateBuildProgress(input: UpdateBuildEstimateInput): UpdateBuildEstimate {
  const floor = clamp(input.floor ?? 0, 0, 1)
  const estimate = (stage: UpdateBuildStage): number => {
    const value = input.history?.[stage]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  const totalEstimate = UPDATE_BUILD_STAGES.reduce((sum, stage) => sum + estimate(stage), 0)
  const current = input.history?.[input.stage]
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 0 || totalEstimate <= 0) {
    const stepFraction = clamp((input.step - 1) / Math.max(1, input.total), 0, 1)
    return { fraction: Math.max(floor, stepFraction), percent: null, remaining: null, overrun: false }
  }
  const index = UPDATE_BUILD_STAGES.indexOf(input.stage)
  const before = UPDATE_BUILD_STAGES.slice(0, index).reduce((sum, stage) => sum + estimate(stage), 0)
  const elapsed = Math.max(0, input.stageElapsed)
  const progressed = before + Math.min(elapsed, current * STAGE_FILL_LIMIT)
  const fraction = Math.max(floor, clamp(progressed / totalEstimate, 0, 1))
  const overrun = elapsed > current
  const after = totalEstimate - before - current
  return {
    fraction,
    // A running build never reads as finished.
    percent: Math.min(99, Math.floor(fraction * 100)),
    remaining: !overrun ? Math.max(0, totalEstimate * (1 - fraction)) : after > 0 ? after : null,
    overrun,
  }
}

/**
 * Durations of the stages seen in a successful build. A stage ends when the
 * next seen stage starts; the last one ends when the build became ready.
 */
export function measureUpdateBuildStages(
  stageStarts: UpdateStageDurations,
  readyAt: number,
): UpdateStageDurations {
  const seen = UPDATE_BUILD_STAGES
    .filter((stage) => typeof stageStarts[stage] === 'number')
    .sort((left, right) => stageStarts[left]! - stageStarts[right]!)
  const durations: UpdateStageDurations = {}
  seen.forEach((stage, index) => {
    const next = seen[index + 1]
    const end = next === undefined ? readyAt : stageStarts[next]!
    durations[stage] = Math.max(0, end - stageStarts[stage]!)
  })
  return durations
}

type DurationStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Returns null when storage is missing, unreadable, or holds no durations. */
export function readUpdateBuildDurations(storage: DurationStorage | undefined): UpdateStageDurations | null {
  try {
    const raw = storage?.getItem(UPDATE_BUILD_DURATIONS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const durations: UpdateStageDurations = {}
    for (const stage of UPDATE_BUILD_STAGES) {
      const value = parsed[stage]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) durations[stage] = value
    }
    return Object.keys(durations).length > 0 ? durations : null
  } catch {
    return null
  }
}

/** Keeps earlier durations for stages this build skipped. */
export function writeUpdateBuildDurations(
  storage: DurationStorage | undefined,
  durations: UpdateStageDurations,
  previous: UpdateStageDurations | null,
): void {
  if (Object.keys(durations).length === 0) return
  try {
    storage?.setItem(UPDATE_BUILD_DURATIONS_KEY, JSON.stringify({ ...previous, ...durations }))
  } catch {
    // A disabled store only costs the next build its estimate.
  }
}

export interface UpdateBuildTiming {
  /** When each build stage was first seen, by event arrival. */
  stageStarts: UpdateStageDurations
  history: UpdateStageDurations | null
  /** Highest bar fraction shown so far in this build. */
  floor: number
}

export type UpdateStatusState =
  | { kind: 'idle' }
  | { kind: 'building'; startedAt: number; progress: NormalizedUpdateProgress | null; timing: UpdateBuildTiming }
  | { kind: 'applying'; startedAt: number; progress: NormalizedUpdateProgress | null }
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
  /** Build progress bar; null outside the build phase. */
  progress: UpdateStatusProgress | null
  restart: boolean
  dismiss: boolean
}

export interface UpdateStatusProgress {
  fraction: number
  /** `68% · about 40s left`, or empty without history. */
  text: string
  /** Spoken value for the progress bar. */
  valueText: string
}

const SHORT_COMMIT_LENGTH = 7

/** Pure description of the status row so its states can be tested without a DOM. */
export function describeUpdateStatus(state: UpdateStatusState, now: number): UpdateStatusModel {
  const base = { visible: true, detail: '', title: '', elapsedSeconds: null, progress: null, restart: false, dismiss: false }
  switch (state.kind) {
    case 'idle':
      return { ...base, visible: false, tone: 'busy', message: '' }
    case 'building': {
      const current = buildProgress(state.progress)
      const detail = state.progress?.detail ?? ''
      const stageStartedAt = state.timing.stageStarts[current.stage] ?? state.startedAt
      const estimate = estimateUpdateBuildProgress({
        stage: current.stage,
        step: current.step,
        total: current.total,
        stageElapsed: now - stageStartedAt,
        history: state.timing.history,
        floor: state.timing.floor,
      })
      return {
        ...base,
        tone: 'busy',
        message: `${current.message} · ${current.step}/${current.total}`,
        detail,
        title: detail,
        elapsedSeconds: elapsedSince(state.startedAt, now),
        progress: describeEstimate(estimate, current.step, current.total),
      }
    }
    case 'applying': {
      const detail = state.progress?.message ?? stageMessage('preparing')
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
  /** Where previous build durations are kept; defaults to localStorage when available. */
  storage?: DurationStorage
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
  const storage = 'storage' in options ? options.storage : defaultStorage()
  const row = root.querySelector<HTMLElement>('#update-status')
  const icon = root.querySelector<HTMLElement>('#update-status-icon')
  const message = root.querySelector<HTMLElement>('#update-status-message')
  const progress = root.querySelector<HTMLElement>('#update-status-progress')
  const bar = root.querySelector<HTMLElement>('#update-status-bar')
  const barFill = root.querySelector<HTMLElement>('#update-status-bar-fill')
  const estimate = root.querySelector<HTMLElement>('#update-status-estimate')
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
    if (progress) progress.hidden = model.progress === null
    if (model.progress) {
      const percent = Math.round(model.progress.fraction * 100)
      // Later renders start from here so the bar never moves backwards in a build.
      if (state.kind === 'building') state.timing.floor = model.progress.fraction
      bar?.setAttribute('aria-valuenow', String(percent))
      bar?.setAttribute('aria-valuetext', model.progress.valueText)
      if (barFill) barFill.style.width = `${model.progress.fraction * 100}%`
      if (estimate) {
        estimate.textContent = model.progress.text
        estimate.hidden = !model.progress.text
      }
    }
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
        const history = readUpdateBuildDurations(storage)
        setState({ kind: 'building', startedAt: now(), progress: null, timing: { stageStarts: {}, history, floor: 0 } })
      } else if (phase === 'applying' && state.kind !== 'applying') {
        setState({ kind: 'applying', startedAt: now(), progress: null })
      } else if (phase === 'ready' && build) {
        // Only a build that just succeeded here teaches the next estimate.
        if (state.kind === 'building') {
          const { stageStarts, history } = state.timing
          writeUpdateBuildDurations(storage, measureUpdateBuildStages(stageStarts, now()), history)
        }
        setState({ kind: 'ready', commit: build.commit })
      } else if ((phase === 'hidden' || phase === 'available') && state.kind !== 'failed') {
        setState({ kind: 'idle' })
      }
    },
    update: (payload) => {
      const progress = normaliseUpdateProgress(payload)
      if (!progress) return
      if (progress.phase === 'build') {
        if (state.kind !== 'building') return
        const stage = progress.stage as UpdateBuildStage
        const { stageStarts } = state.timing
        if (stageStarts[stage] === undefined) stageStarts[stage] = now()
        setState({ ...state, progress })
      } else if (state.kind === 'applying') {
        setState({ ...state, progress })
      }
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

interface BuildProgress {
  stage: UpdateBuildStage
  step: number
  total: number
  message: string
}

/** The current build stage, or the first one before any event arrives. */
function buildProgress(progress: NormalizedUpdateProgress | null): BuildProgress {
  if (progress?.phase === 'build') {
    return { stage: progress.stage as UpdateBuildStage, step: progress.step, total: progress.total, message: progress.message }
  }
  const first = UPDATE_PROGRESS_STAGES[0]
  return { stage: first.id, step: first.step, total: UPDATE_BUILD_TOTAL, message: first.message }
}

const UPDATE_BUILD_TOTAL = Math.max(...UPDATE_PROGRESS_STAGES
  .filter((stage) => stage.phase === 'build')
  .map((stage) => stage.step))

function describeEstimate(estimate: UpdateBuildEstimate, step: number, total: number): UpdateStatusProgress {
  let text = ''
  if (estimate.percent !== null) {
    const left = estimate.remaining === null
      ? 'almost done'
      : `about ${formatUpdateRemaining(estimate.remaining)} left`
    text = `${estimate.percent}% · ${left}`
  }
  return { fraction: estimate.fraction, text, valueText: text || `Step ${step} of ${total}` }
}

function stageMessage(id: UpdateProgressStage): string {
  return UPDATE_PROGRESS_STAGES.find((stage) => stage.id === id)!.message
}

function defaultStorage(): DurationStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
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

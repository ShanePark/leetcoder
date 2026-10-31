import type { UpdateBuild, UpdateStatus } from './backend'

/** Poll often enough to notice a local commit without adding startup work. */
export const UPDATE_CHECK_INTERVAL_MS = 30_000

/**
 * - `hidden`: no update to offer.
 * - `available`: a newer local commit exists; activating builds it.
 * - `building`: a background build is running; activation is ignored.
 * - `ready`: a build is staged; activating installs it and restarts.
 * - `applying`: the staged build is being installed; activation is ignored.
 */
export type UpdatePhase = 'hidden' | 'available' | 'building' | 'ready' | 'applying'

export type UpdateFailureKind = 'build' | 'prepare' | 'apply'

export interface UpdateControllerApi {
  checkForUpdate: () => Promise<UpdateStatus>
  buildUpdate: () => Promise<UpdateBuild>
  /** Flush pending work before the running app is replaced. */
  prepareToClose: () => Promise<void>
  applyUpdate: () => Promise<void>
}

export interface UpdateControllerUi {
  /** `build` is the staged build while the phase is `ready` or `applying`. */
  setPhase: (phase: UpdatePhase, build: UpdateBuild | null) => void
  showError: (kind: UpdateFailureKind, message: string) => void
}

export interface UpdateController {
  readonly phase: UpdatePhase
  checkForUpdate: () => Promise<void>
  /** The update button and menu action: build when available, restart when ready. */
  activate: () => Promise<void>
}

/**
 * Coordinates polling with the background build and the restart that installs
 * it. Poll results only move between `hidden` and `available`; once a build is
 * running or staged they are ignored, so newer commits never replace a staged
 * build. A poll that started before a build is also ignored after the build
 * fails, so it cannot hide the restored button.
 */
export function createUpdateController(
  api: UpdateControllerApi,
  ui: UpdateControllerUi,
): UpdateController {
  let phase: UpdatePhase = 'hidden'
  let readyBuild: UpdateBuild | null = null
  let checkBusy = false
  let updateAttempt = 0

  const setPhase = (next: UpdatePhase): void => {
    phase = next
    ui.setPhase(next, next === 'ready' || next === 'applying' ? readyBuild : null)
  }

  const pollable = (): boolean => phase === 'hidden' || phase === 'available'

  const checkForUpdate = async (): Promise<void> => {
    if (checkBusy || !pollable()) return
    checkBusy = true
    const attemptAtStart = updateAttempt
    try {
      const result = await api.checkForUpdate()
      if (attemptAtStart !== updateAttempt || !pollable()) return
      const next = result.supported && result.available ? 'available' : 'hidden'
      if (next !== phase) setPhase(next)
    } catch {
      if (attemptAtStart !== updateAttempt || !pollable()) return
      if (phase !== 'hidden') setPhase('hidden')
    } finally {
      checkBusy = false
    }
  }

  const build = async (): Promise<void> => {
    updateAttempt += 1
    setPhase('building')
    try {
      readyBuild = await api.buildUpdate()
      setPhase('ready')
    } catch (error) {
      readyBuild = null
      setPhase('available')
      ui.showError('build', messageOf(error))
    }
  }

  const apply = async (): Promise<void> => {
    updateAttempt += 1
    setPhase('applying')
    try {
      await api.prepareToClose()
    } catch (error) {
      setPhase('ready')
      ui.showError('prepare', messageOf(error))
      return
    }
    try {
      await api.applyUpdate()
      // A successful native apply exits this process once the replacement is
      // launched. Stay in `applying` if the command resolves during that
      // short handoff window.
    } catch (error) {
      readyBuild = null
      setPhase('available')
      ui.showError('apply', messageOf(error))
    }
  }

  const activate = async (): Promise<void> => {
    if (phase === 'available') await build()
    else if (phase === 'ready') await apply()
  }

  return {
    get phase() {
      return phase
    },
    checkForUpdate,
    activate,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

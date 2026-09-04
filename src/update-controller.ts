import type { UpdateStatus } from './backend'

/** Poll often enough to notice a local commit without adding startup work. */
export const UPDATE_CHECK_INTERVAL_MS = 30_000

export interface UpdateControllerApi {
  checkForUpdate: () => Promise<UpdateStatus>
  updateAndRestart: () => Promise<void>
}

export interface UpdateControllerUi {
  setUpdateAvailable: (available: boolean) => void
  setUpdateBusy: (busy: boolean) => void
  showUpdateStarted: () => void
  showError: (message: string) => void
}

export interface UpdateController {
  checkForUpdate: () => Promise<void>
  updateAndRestart: () => Promise<void>
}

/**
 * Coordinates polling and the one-shot update action. A stale poll is ignored
 * after an update begins so it cannot hide a button that should be restored
 * when a build fails.
 */
export function createUpdateController(
  api: UpdateControllerApi,
  ui: UpdateControllerUi,
): UpdateController {
  let checkBusy = false
  let updateBusy = false
  let updateAvailable = false
  let updateAttempt = 0

  const checkForUpdate = async (): Promise<void> => {
    if (checkBusy || updateBusy) return
    checkBusy = true
    const attemptAtStart = updateAttempt
    try {
      const result = await api.checkForUpdate()
      if (attemptAtStart !== updateAttempt || updateBusy) return
      updateAvailable = result.supported && result.available
      ui.setUpdateAvailable(updateAvailable)
    } catch {
      if (attemptAtStart !== updateAttempt || updateBusy) return
      updateAvailable = false
      ui.setUpdateAvailable(false)
    } finally {
      checkBusy = false
    }
  }

  const updateAndRestart = async (): Promise<void> => {
    if (updateBusy || !updateAvailable) return
    updateBusy = true
    updateAttempt += 1
    ui.setUpdateBusy(true)
    ui.showUpdateStarted()
    try {
      await api.updateAndRestart()
      // A successful native update exits the old process after the installer
      // launches the replacement. Keep this controller busy if the command
      // resolves during that short handoff window.
    } catch (error) {
      updateBusy = false
      updateAvailable = true
      ui.setUpdateAvailable(true)
      ui.setUpdateBusy(false)
      ui.showError(messageOf(error))
    }
  }

  return { checkForUpdate, updateAndRestart }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

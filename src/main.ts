import './styles.css'

import { LeetcoderApp } from './app'

const root = document.querySelector<HTMLElement>('#app')
if (!root) {
  throw new Error('leetcoder root element was not found.')
}

const app = new LeetcoderApp(root)
void bootstrap(app)

async function bootstrap(editorApp: LeetcoderApp): Promise<void> {
  await installCloseHandler(editorApp)
  await editorApp.start()
}

/**
 * Tauri's window bridge is intentionally loaded lazily so Vite's browser
 * preview remains usable. In the desktop runtime, prevent the native close
 * until the current editor snapshot has reached disk.
 */
async function installCloseHandler(editorApp: LeetcoderApp): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()
    let closing = false
    await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault()
      if (closing) {
        return
      }
      closing = true
      try {
        await editorApp.prepareToClose()
        // Keep the editor, autosave coordinator, and listener alive until the
        // native destroy succeeds. A failed destroy must be safely retryable.
        await currentWindow.destroy()
      } catch (error) {
        // prepareToClose already leaves the editor dirty and reports the
        // save error. Keep the window open so the user can retry.
        closing = false
        console.error('Could not close leetcoder safely.', error)
      }
    })
  } catch {
    // The Vite browser preview has no Tauri window bridge; it needs no close
    // interception and should remain a normal browser page.
  }
}

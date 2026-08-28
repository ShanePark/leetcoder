/** Reading and writing the system clipboard from the editor. */
export interface ClipboardBridge {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

/**
 * Alt-modified keys never produce the browser's native `cut` and `paste`
 * events, so the Alt forms of those shortcuts have to reach the clipboard on
 * their own. Tauri's clipboard plugin is the only path that works on both
 * WebKitGTK and macOS; `navigator.clipboard` stays as the fallback for the
 * Vite browser preview, which has no plugin bridge behind it.
 */
export function createClipboardBridge(): ClipboardBridge {
  let plugin: Promise<typeof import('@tauri-apps/plugin-clipboard-manager')> | null = null
  const load = (): Promise<typeof import('@tauri-apps/plugin-clipboard-manager')> => {
    plugin ??= import('@tauri-apps/plugin-clipboard-manager')
    return plugin
  }

  return {
    async readText() {
      try {
        return (await (await load()).readText()) ?? ''
      } catch {
        return (await navigator?.clipboard?.readText()) ?? ''
      }
    },

    async writeText(text) {
      try {
        await (await load()).writeText(text)
      } catch {
        await navigator?.clipboard?.writeText(text)
      }
    },
  }
}

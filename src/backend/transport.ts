import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core'

import type { Invoke, Listen } from './contracts'

/** The Rust watcher's event name. Keep in sync with `src-tauri/src/watcher.rs`. */
export const REPOSITORY_FILES_CHANGED_EVENT = 'repository-files-changed'

interface ProgressChannelFallback {
  onmessage: (event: unknown) => void
  toJSON(): string
}

/** Default native command transport used by the desktop client. */
export const defaultInvoke: Invoke = tauriInvoke

/**
 * Tauri's event bridge is imported lazily so the Vite browser preview, which
 * has no desktop runtime behind it, still loads. Without it the subscription
 * is simply inert.
 */
export const defaultListen: Listen = async (event, handler) => {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen(event, handler as Parameters<typeof listen>[1])
  } catch {
    return () => {}
  }
}

/**
 * Create the callback channel expected by the native test command.
 *
 * Unit tests and the browser preview do not expose Tauri's callback bridge.
 * Keep the same callback-shaped argument there so custom Invoke mocks can
 * exercise progress handling without requiring a desktop runtime.
 */
export function createProgressChannel(
  handler: (event: unknown) => void,
): Channel<unknown> | ProgressChannelFallback {
  const internals = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  if (!internals) {
    return {
      onmessage: handler,
      toJSON: () => '',
    }
  }
  return new Channel<unknown>(handler)
}

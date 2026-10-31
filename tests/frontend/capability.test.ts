import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function readTauriJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../src-tauri/${file}`, import.meta.url), 'utf8'))
}

describe('desktop capability', () => {
  it('allows the close handler to force-destroy the main window', () => {
    const capability = readTauriJson('capabilities/default.json') as {
      permissions?: unknown
    }

    expect(capability.permissions).toEqual(expect.arrayContaining(['core:window:allow-destroy']))
  })

  it('allows the title bar controls and native theme sync', () => {
    const capability = readTauriJson('capabilities/default.json') as {
      permissions?: unknown
    }

    expect(capability.permissions).toEqual(expect.arrayContaining([
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-start-dragging',
      'core:window:allow-set-background-color',
      'core:window:allow-set-theme',
    ]))
  })
})

describe('platform window overrides', () => {
  type WindowsConfig = { app: { windows: Array<Record<string, unknown>> } }

  // Platform files replace `app.windows` wholesale, so each must repeat the base entry.
  it.each([
    ['tauri.macos.conf.json', { titleBarStyle: 'Transparent' }],
    ['tauri.linux.conf.json', { decorations: false }],
  ])('%s keeps the base main window and adds only its title bar setting', (file, chrome) => {
    const base = readTauriJson('tauri.conf.json') as WindowsConfig
    const platform = readTauriJson(file) as WindowsConfig

    expect(platform.app.windows).toEqual([{ ...base.app.windows[0], ...chrome }])
  })
})

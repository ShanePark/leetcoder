import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('desktop capability', () => {
  it('allows the close handler to force-destroy the main window', () => {
    const path = new URL('../../src-tauri/capabilities/default.json', import.meta.url)
    const capability = JSON.parse(readFileSync(path, 'utf8')) as {
      permissions?: unknown
    }

    expect(capability.permissions).toEqual(expect.arrayContaining(['core:window:allow-destroy']))
  })
})

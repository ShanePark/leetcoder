import { describe, expect, it } from 'vitest'

import { rebuildPlan } from '../../scripts/leetcoder-rebuild.mjs'

describe('leetcoder rebuild platform plan', () => {
  it('uses the macOS app bundle and Dock application path', () => {
    const plan = rebuildPlan('darwin', '/Users/tester')
    expect(plan.bundleKind).toBe('app')
    expect(plan.artifact).toMatch(/src-tauri\/target\/release\/bundle\/macos\/leetcoder\.app$/)
    expect(plan.installedApp).toBe('/Applications/leetcoder.app')
  })

  it('uses a user-local AppImage and desktop entry on Linux', () => {
    const plan = rebuildPlan('linux', '/home/tester')
    expect(plan.bundleKind).toBe('appimage')
    expect(plan.installedApp).toBe('/home/tester/.local/lib/leetcoder/leetcoder.AppImage')
    expect(plan.desktopEntry).toBe('/home/tester/.local/share/applications/leetcoder.desktop')
    expect(plan.installedIcon).toBe('/home/tester/.local/share/icons/hicolor/128x128/apps/leetcoder.png')
  })

  it('rejects unsupported operating systems', () => {
    expect(() => rebuildPlan('win32', 'C:\\Users\\tester')).toThrow(/supports macOS and Linux/)
  })
})

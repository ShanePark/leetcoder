import { describe, expect, it } from 'vitest'

import {
  appImageCandidateNames,
  isLeetcoderOwnedLegacyDesktopEntry,
  isLeetcoderOwnedLegacyLauncher,
  isRegularNonSymlink,
  parseUpdateOldPid,
  rebuildPlan,
  selectUniqueAppImageName,
  stopRunningAppStrategy,
} from '../../scripts/leetcoder-rebuild.mjs'

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
    expect(plan.legacyLauncher).toBe('/home/tester/.local/bin/leetcoder')
    expect(plan.legacyDesktopEntry).toBe(
      '/home/tester/.local/share/applications/dev.shanepark.leetcoder.desktop',
    )
  })

  it('rejects unsupported operating systems', () => {
    expect(() => rebuildPlan('win32', 'C:\\Users\\tester')).toThrow(/supports macOS and Linux/)
  })
})

describe('leetcoder rebuild safety helpers', () => {
  it('uses the exact updater PID and never broadens an invalid PID to pkill', () => {
    expect(parseUpdateOldPid(undefined)).toBeNull()
    expect(stopRunningAppStrategy('4201')).toEqual({ kind: 'pid', pid: 4201 })
    expect(stopRunningAppStrategy('')).toEqual({ kind: 'all', args: ['-x', 'leetcoder'] })
    expect(() => stopRunningAppStrategy('4201; pkill -x leetcoder')).toThrow(/positive process ID/)
  })

  it('requires one deterministic AppImage candidate', () => {
    expect(appImageCandidateNames(['README', 'z.AppImage', 'a.AppImage'])).toEqual(['a.AppImage', 'z.AppImage'])
    expect(() => selectUniqueAppImageName(['leetcoder_0.1.0_amd64.AppImage', 'old.AppImage']))
      .toThrow(/exactly one AppImage/)
    expect(selectUniqueAppImageName(['leetcoder_0.1.0_amd64.AppImage', 'README'])).toBe(
      'leetcoder_0.1.0_amd64.AppImage',
    )
  })

  it('accepts only regular non-symlink artifacts', () => {
    expect(isRegularNonSymlink({ isFile: () => true, isSymbolicLink: () => false })).toBe(true)
    expect(isRegularNonSymlink({ isFile: () => false, isSymbolicLink: () => true })).toBe(false)
  })

  it('recognizes the existing legacy launchers but not unrelated files', () => {
    expect(isLeetcoderOwnedLegacyLauncher('# Launch the installed leetcoder build\nexec app')).toBe(true)
    expect(isLeetcoderOwnedLegacyLauncher('# Launch another app\nexec app')).toBe(false)
    expect(isLeetcoderOwnedLegacyDesktopEntry('[Desktop Entry]\nName=leetcoder Dev\nExec=/tmp/leetcoder')).toBe(true)
    expect(isLeetcoderOwnedLegacyDesktopEntry('[Desktop Entry]\nName=Another app')).toBe(false)
  })
})

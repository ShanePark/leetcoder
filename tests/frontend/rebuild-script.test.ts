import { describe, expect, it } from 'vitest'

import {
  appBinaryPath,
  appImageCandidateNames,
  createLineSplitter,
  isLeetcoderOwnedLegacyDesktopEntry,
  isLeetcoderOwnedLegacyLauncher,
  isRegularNonSymlink,
  nextBuildStage,
  parseRebuildMode,
  parseUpdateOldPid,
  rebuildPlan,
  requireExpectedCommit,
  selectUniqueAppImageName,
  stopRunningAppStrategy,
  updateStageLine,
  validateStagedManifest,
} from '../../scripts/leetcoder-rebuild.mjs'

describe('leetcoder rebuild platform plan', () => {
  it('uses the macOS app bundle and Dock application path', () => {
    const plan = rebuildPlan('darwin', '/Users/tester')
    expect(plan.bundleKind).toBe('app')
    expect(plan.artifact).toMatch(/src-tauri\/target\/release\/bundle\/macos\/leetcoder\.app$/)
    expect(plan.installedApp).toBe('/Applications/leetcoder.app')
    expect(plan.stagedApp).toBe('/Applications/.leetcoder.app.staged')
    expect(plan.stagedManifest).toBe('/Applications/.leetcoder.app.staged.json')
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
    expect(plan.stagedApp).toBe('/home/tester/.local/lib/leetcoder/.leetcoder.AppImage.staged')
    expect(plan.stagedManifest).toBe('/home/tester/.local/lib/leetcoder/.leetcoder.AppImage.staged.json')
  })

  it('hashes the AppImage itself on Linux and the bundle executable on macOS', () => {
    expect(appBinaryPath('linux', '/apps/.leetcoder.AppImage.staged')).toBe('/apps/.leetcoder.AppImage.staged')
    expect(appBinaryPath('darwin', '/Applications/.leetcoder.app.staged')).toBe(
      '/Applications/.leetcoder.app.staged/Contents/MacOS/leetcoder',
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

describe('leetcoder rebuild modes', () => {
  it('keeps the full flow without arguments and recognizes the staged modes', () => {
    expect(parseRebuildMode([])).toBe('full')
    expect(parseRebuildMode(['--stage-only'])).toBe('stage')
    expect(parseRebuildMode(['--apply-staged'])).toBe('apply')
  })

  it('rejects unknown or combined arguments', () => {
    expect(() => parseRebuildMode(['--stage'])).toThrow(/Unsupported rebuild arguments/)
    expect(() => parseRebuildMode(['--stage-only', '--apply-staged'])).toThrow(/Unsupported rebuild arguments/)
    expect(() => parseRebuildMode(['toString'])).toThrow(/Unsupported rebuild arguments/)
  })

  it('requires the expected commit to apply a staged build', () => {
    expect(requireExpectedCommit(' abc123 \n')).toBe('abc123')
    expect(() => requireExpectedCommit(undefined)).toThrow(/LEETCODER_EXPECTED_COMMIT is required/)
    expect(() => requireExpectedCommit('   ')).toThrow(/LEETCODER_EXPECTED_COMMIT is required/)
  })
})

describe('leetcoder staged manifest validation', () => {
  const sha256 = 'a'.repeat(64)
  const manifest = { commit: 'abc123', sha256, platform: 'linux' }
  const expected = { expectedCommit: 'abc123', platform: 'linux', sha256 }

  it('accepts the staged build the caller expects', () => {
    expect(validateStagedManifest(manifest, expected)).toBe(manifest)
  })

  it('rejects a manifest from another commit or platform', () => {
    expect(() => validateStagedManifest({ ...manifest, commit: 'def456' }, expected)).toThrow(/different commit/)
    expect(() => validateStagedManifest({ ...manifest, commit: undefined }, expected)).toThrow(/different commit/)
    expect(() => validateStagedManifest({ ...manifest, platform: 'darwin' }, expected)).toThrow(/built for darwin/)
  })

  it('rejects a staged artifact whose checksum differs from the manifest', () => {
    expect(() => validateStagedManifest(manifest, { ...expected, sha256: 'b'.repeat(64) }))
      .toThrow(/does not match its manifest/)
    expect(() => validateStagedManifest({ ...manifest, sha256: 'not-a-hash' }, expected)).toThrow(/invalid checksum/)
  })

  it('rejects malformed manifests', () => {
    expect(() => validateStagedManifest(null, expected)).toThrow(/malformed/)
    expect(() => validateStagedManifest([manifest], expected)).toThrow(/malformed/)
  })
})

describe('leetcoder release build stage markers', () => {
  it('advances to compiling on the first crate compile line', () => {
    expect(nextBuildStage('   Compiling leetcoder v0.1.0 (/src-tauri)', 'building')).toBe('compiling')
    expect(nextBuildStage('\u001b[1m\u001b[32m   Compiling\u001b[0m serde v1.0.0', 'building')).toBe('compiling')
    expect(nextBuildStage('   Compiling serde v1.0.0', 'compiling')).toBeNull()
  })

  it('advances to bundling when the compile finishes or bundling begins', () => {
    expect(nextBuildStage('    Finished `release` profile [optimized] target(s) in 1m 12s', 'compiling')).toBe('bundling')
    expect(nextBuildStage('       Built application at: /src-tauri/target/release/leetcoder', 'building')).toBe('bundling')
    expect(nextBuildStage('    Bundling leetcoder_0.1.0_amd64.AppImage (/bundle)', 'compiling')).toBe('bundling')
  })

  it('never moves backwards or reacts to unrelated output', () => {
    expect(nextBuildStage('   Compiling late v1.0.0', 'bundling')).toBeNull()
    expect(nextBuildStage('    Finished 1 bundle at:', 'bundling')).toBeNull()
    expect(nextBuildStage('     Running beforeBuildCommand `npm run build`', 'building')).toBeNull()
    expect(nextBuildStage('vite v7.3.6 building client environment for production...', 'building')).toBeNull()
    expect(nextBuildStage('warning: Compiling is mentioned mid-line', 'building')).toBeNull()
  })

  it('reassembles lines split across output chunks', () => {
    const lines: string[] = []
    const splitter = createLineSplitter((line: string) => lines.push(line))
    splitter.push('   Comp')
    splitter.push('iling a v1\r\n    Finished `release`')
    expect(lines).toEqual(['   Compiling a v1'])
    splitter.push(' profile\nBundling')
    splitter.end()
    expect(lines).toEqual(['   Compiling a v1', '    Finished `release` profile', 'Bundling'])
  })

  it('starts a marker on its own line after a partial output line', () => {
    expect(updateStageLine('compiling', true)).toBe('LEETCODER_UPDATE_STAGE:compiling\n')
    expect(updateStageLine('bundling', false)).toBe('\nLEETCODER_UPDATE_STAGE:bundling\n')
  })
})

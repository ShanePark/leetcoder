import { describe, expect, it, vi } from 'vitest'
import {
  defaultShortcutPlatform,
  isCurrentRepositoryRefresh,
  macShortcutDialogLabel,
  RepositoryPickerCoordinator,
} from '../../../src/app'

describe('shortcut platform tabs', () => {
  it('opens on the platform running the app', () => {
    expect(defaultShortcutPlatform(false)).toBe('linux')
    expect(defaultShortcutPlatform(true)).toBe('macos')
  })

  it('uses readable Apple modifier names with clear separators', () => {
    expect(macShortcutDialogLabel('Shift-Mod-ArrowUp', '⇧⌘ArrowUp')).toBe('Shift + Cmd + Arrow Up')
    expect(macShortcutDialogLabel('Mod-Alt-v', '⌘⌥V')).toBe('Cmd + Opt + V')
    expect(macShortcutDialogLabel('Mod-Backspace', '⌘Backspace')).toBe('Cmd + Backspace')
    expect(macShortcutDialogLabel('Shift-Mod-Enter', '⇧⌘Enter')).toBe('Shift + Cmd + Enter')
    expect(macShortcutDialogLabel('Mod-d', '⌘D')).toBe('Cmd + D')
    expect(macShortcutDialogLabel('Ctrl-Space', '⌃Space')).toBe('Ctrl + Space')
  })
})

describe('repository refresh generations', () => {
  it('rejects a response from a previous request or repository', () => {
    const current = {
      repoPath: '/new-repo',
      projectValid: true,
      repositoryGeneration: 2,
      refreshRequestId: 8,
    }
    expect(isCurrentRepositoryRefresh({
      repoPath: '/old-repo',
      repositoryGeneration: 1,
      requestId: 7,
    }, current)).toBe(false)
    expect(isCurrentRepositoryRefresh({
      repoPath: '/new-repo',
      repositoryGeneration: 2,
      requestId: 8,
    }, current)).toBe(true)
  })
})

describe('RepositoryPickerCoordinator', () => {
  it('allows only one picker request until the active request finishes', async () => {
    let finishPicker: ((path: string | null) => void) | undefined
    const picker = vi.fn(() => new Promise<string | null>((resolve) => {
      finishPicker = resolve
    }))
    const coordinator = new RepositoryPickerCoordinator()

    const first = coordinator.open(picker)
    const duplicate = coordinator.open(picker)

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(coordinator.isOpen).toBe(true)
    expect(picker).toHaveBeenCalledTimes(1)

    finishPicker?.('/repo')
    await expect(first).resolves.toBe('/repo')
    expect(coordinator.isOpen).toBe(false)
  })

  it('can open again after cancellation or failure', async () => {
    const coordinator = new RepositoryPickerCoordinator()

    await expect(coordinator.open(async () => null)).resolves.toBeNull()
    await expect(coordinator.open(async () => {
      throw new Error('picker failed')
    })).rejects.toThrow('picker failed')
    await expect(coordinator.open(async () => '/repo')).resolves.toBe('/repo')
  })
})

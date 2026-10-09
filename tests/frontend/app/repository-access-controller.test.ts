import { describe, expect, it, vi } from 'vitest'
import { isRepositoryAccessError, RepositoryAccessController } from '../../../src/app/repository-access-controller'
import type { ToastAction } from '../../../src/app/toast-controller'

const screenshotError = 'Could not load Ps completions: Gradle could not resolve the main Java compile classpath: shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted. Check the project\'s Gradle configuration and try again.'

function fixture() {
  let path: string | null = '/repo'
  let actions: readonly ToastAction[] = []
  let visible = true
  const dismiss = vi.fn()
  const options = {
    isMacPlatform: () => true,
    getPath: () => path,
    chooseRepository: vi.fn().mockResolvedValue(true),
    retryRepository: vi.fn().mockResolvedValue(true),
    openSettings: vi.fn().mockResolvedValue(undefined),
    showError: vi.fn((_message: string, nextActions: readonly ToastAction[], _detail: string) => {
      actions = nextActions
      visible = true
      return { dismiss, isVisible: () => visible }
    }),
  }
  const controller = new RepositoryAccessController(options)
  return { controller, options, dismiss, action: (index: number) => actions[index].run(), hideToast: () => { visible = false }, setPath: (next: string | null) => { path = next } }
}

describe('repository access recovery', () => {
  it('recognizes filesystem access failures without treating ordinary Gradle/Git failures as folder denial', () => {
    expect(isRepositoryAccessError(screenshotError)).toBe(true)
    expect(isRepositoryAccessError("Unable to resolve projectRoot '/repo': Permission denied (os error 13)")).toBe(true)
    expect(isRepositoryAccessError("Unable to list '/repo/src': Operation not permitted (os error 1)")).toBe(true)
    expect(isRepositoryAccessError('Gradle could not resolve compile classpath: connection timed out')).toBe(false)
    expect(isRepositoryAccessError('Could not launch Gradle: Permission denied (os error 13)')).toBe(false)
    expect(isRepositoryAccessError('Permission denied (publickey).')).toBe(false)
  })

  it('offers actions on macOS, preserves details and suppresses repeated errors', () => {
    const { controller, options } = fixture()
    expect(controller.showFailure(screenshotError)).toBe(true)
    expect(controller.showFailure(screenshotError)).toBe(true)
    expect(options.showError).toHaveBeenCalledOnce()
    expect(options.showError.mock.calls[0][2]).toBe(screenshotError)
    options.isMacPlatform = () => false
    expect(controller.showFailure(screenshotError)).toBe(false)
  })

  it('keeps the error on picker cancellation and failed retries; dismisses only after success', async () => {
    const { controller, options, dismiss, action } = fixture()
    controller.showFailure(screenshotError)
    options.chooseRepository.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    await action(0)
    await action(0)
    expect(dismiss).not.toHaveBeenCalled()
    await action(0)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(controller.handleVisibilityReturn()).toBe(false)
  })

  it('presents the same failure again when its toast was dismissed or replaced', () => {
    const { controller, options, hideToast } = fixture()
    controller.showFailure(screenshotError)
    hideToast()
    controller.showFailure(screenshotError)
    expect(options.showError).toHaveBeenCalledTimes(2)
    controller.showFailure(screenshotError)
    expect(options.showError).toHaveBeenCalledTimes(2)
  })

  it('retries the same repository once on returning from settings, without repeated focus attempts', async () => {
    const { controller, options, dismiss, action } = fixture()
    controller.showFailure(screenshotError)
    expect(controller.handleVisibilityReturn()).toBe(false)
    await action(1)
    expect(options.openSettings).toHaveBeenCalledOnce()
    expect(controller.handleVisibilityReturn()).toBe(true)
    await vi.waitFor(() => { expect(dismiss).toHaveBeenCalledOnce() })
    expect(options.retryRepository).toHaveBeenCalledExactlyOnceWith('/repo')
    expect(controller.handleVisibilityReturn()).toBe(false)
  })

  it('does not retry another repository or announce success when access fails again', async () => {
    const { controller, options, dismiss, action, setPath } = fixture()
    controller.showFailure(screenshotError)
    await action(1)
    setPath('/other')
    expect(controller.handleVisibilityReturn()).toBe(false)
    expect(options.retryRepository).not.toHaveBeenCalled()
    setPath('/repo')
    options.retryRepository.mockImplementation(async () => {
      controller.showFailure(screenshotError)
      return false
    })
    await action(1)
    controller.handleVisibilityReturn()
    await vi.waitFor(() => { expect(options.retryRepository).toHaveBeenCalledOnce() })
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('handles settings failures and ignores actions after disposal', async () => {
    const { controller, options, action } = fixture()
    controller.showFailure(screenshotError)
    options.openSettings.mockRejectedValue(new Error('open failed'))
    await action(1)
    expect(options.showError.mock.calls.at(-1)?.[0]).toContain('Could not open permission settings')
    expect(options.showError.mock.calls.at(-1)?.[2]).toBe('open failed')
    expect(controller.handleVisibilityReturn()).toBe(false)
    controller.dispose()
    await action(0)
    expect(options.chooseRepository).not.toHaveBeenCalled()
  })
})

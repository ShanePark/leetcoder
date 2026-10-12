import { errorMessage } from '../backend'
import type { ToastAction, ToastHandle } from './toast-controller'

interface RepositoryAccessOptions {
  isMacPlatform: () => boolean
  getPath: () => string | null
  chooseRepository: () => Promise<boolean>
  retryRepository: (path: string) => Promise<boolean>
  openSettings: () => Promise<void>
  showError: (message: string, actions: readonly ToastAction[], detail: string) => ToastHandle
}

/** Filesystem failures can also be Unix permissions; avoid claiming a known privacy denial. */
export function isRepositoryAccessError(message: string): boolean {
  return /(?:operation not permitted|permission denied|os error (?:1|13)\b)/i.test(message)
    && /(?:getcwd|cannot access parent directories|unable to (?:list|read|write|save|inspect|resolve|create a temporary file)|package directory .* unavailable|(?:folder|directory) access)/i.test(message)
}

/** Offer explicit folder recovery, retrying once on return from permission settings. */
export class RepositoryAccessController {
  private failurePath: string | null = null
  private failureDetail: string | null = null
  private failureVersion = 0
  private errorToast: ToastHandle | null = null
  private settingsPath: string | null = null
  private running = false
  private disposed = false

  constructor(private readonly options: RepositoryAccessOptions) {}

  showFailure(message: string): boolean {
    const path = this.options.getPath()
    if (this.disposed || !this.options.isMacPlatform() || !path || !isRepositoryAccessError(message)) {
      return false
    }
    this.failureVersion += 1
    if (this.failurePath === path && this.failureDetail === message && this.errorToast?.isVisible()) return true
    this.failurePath = path
    this.failureDetail = message
    this.present(message)
    return true
  }

  handleVisibilityReturn(): boolean {
    if (this.disposed || !this.settingsPath) return false
    if (this.running) return true
    const path = this.settingsPath
    this.settingsPath = null
    if (path !== this.options.getPath()) return false
    void this.recover(() => this.options.retryRepository(path))
    return true
  }

  dispose(): void {
    this.disposed = true
    this.settingsPath = null
    this.errorToast?.dismiss()
    this.errorToast = null
  }

  private present(detail: string, message = 'Could not access the project folder. macOS may have blocked access. Choose the folder again, or enable access in System Settings → Privacy & Security → Files and Folders.'): void {
    this.errorToast = this.options.showError(message, [
      { label: 'Choose folder again', run: () => this.recover(() => this.options.chooseRepository()) },
      { label: 'Open permission settings', run: () => this.openSettings() },
    ], detail)
  }

  private async openSettings(): Promise<void> {
    if (this.running || this.disposed) return
    const path = this.options.getPath()
    if (!path) return
    this.running = true
    try {
      await this.options.openSettings()
      if (!this.disposed && path === this.options.getPath()) this.settingsPath = path
    } catch (error) {
      if (!this.disposed) {
        this.present(errorMessage(error), 'Could not open permission settings. Open System Settings → Privacy & Security → Files and Folders, enable folder access, then choose the folder again.')
      }
    } finally {
      this.running = false
    }
  }

  private async recover(operation: () => Promise<boolean>): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    const version = this.failureVersion
    try {
      const recovered = await operation()
      if (recovered && !this.disposed && version === this.failureVersion) {
        this.errorToast?.dismiss()
        this.errorToast = null
        this.failurePath = null
        this.failureDetail = null
        this.settingsPath = null
      }
    } catch (error) {
      if (!this.disposed) this.present(errorMessage(error), 'Could not restore folder access. Choose the folder again, or enable access in permission settings.')
    } finally {
      this.running = false
    }
  }
}

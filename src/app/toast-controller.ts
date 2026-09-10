import { iconFor } from '../icons'

export const TOAST_DISMISS_MS = 3000
export const MAX_VISIBLE_TOASTS = 3

export type ToastTone = 'info' | 'success' | 'error'

type ToastTimer = ReturnType<typeof setTimeout>

interface CloseHandler {
  button: HTMLButtonElement
  listener: () => void
}

/** Owns toast DOM, dismissal timers, and accessible error replacement. */
export class ToastController {
  private readonly timers = new Map<HTMLElement, ToastTimer>()
  private readonly closeHandlers = new Map<HTMLElement, CloseHandler>()
  private readonly toasts = new Set<HTMLElement>()
  private errorToastElement: HTMLElement | null = null
  private disposed = false

  constructor(private readonly stack: HTMLElement) {}

  show(message: string, tone: ToastTone): void {
    if (this.disposed) {
      return
    }
    if (tone === 'error' && this.errorToastElement) {
      // A newer error replaces the previous one instead of stacking.
      this.dismissToast(this.errorToastElement)
    }

    const toast = document.createElement('div')
    toast.className = `toast toast-${tone}`
    toast.append(iconFor(tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'info', 'toast-icon'))

    const copy = document.createElement('span')
    copy.className = 'toast-copy'
    const firstLine = message.split(/\r?\n/, 1)[0]
    copy.textContent = tone === 'error' ? firstLine : message
    if (tone === 'error' && firstLine !== message) {
      toast.title = message
    }
    toast.append(copy)

    if (tone === 'error') {
      toast.setAttribute('role', 'alert')
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'toast-close'
      close.setAttribute('aria-label', 'Dismiss')
      close.append(iconFor('close', 'toast-close-icon'))
      const listener = (): void => {
        this.dismissToast(toast)
      }
      close.addEventListener('click', listener)
      this.closeHandlers.set(toast, { button: close, listener })
      this.errorToastElement = toast
      toast.append(close)
    }

    this.toasts.add(toast)
    this.stack.append(toast)
    while (this.stack.children.length > MAX_VISIBLE_TOASTS) {
      const oldest = this.stack.firstElementChild
      if (!oldest) {
        break
      }
      this.dismissToast(oldest as HTMLElement)
    }

    if (tone !== 'error') {
      const timer = setTimeout(() => {
        this.dismissToast(toast)
      }, TOAST_DISMISS_MS)
      this.timers.set(toast, timer)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const toast of [...this.toasts]) {
      this.dismissToast(toast)
    }
    this.timers.clear()
    this.closeHandlers.clear()
    this.toasts.clear()
    this.errorToastElement = null
  }

  private dismissToast(toast: HTMLElement): void {
    const timer = this.timers.get(toast)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(toast)
    }

    const closeHandler = this.closeHandlers.get(toast)
    if (closeHandler) {
      closeHandler.button.removeEventListener('click', closeHandler.listener)
      this.closeHandlers.delete(toast)
    }

    this.toasts.delete(toast)
    if (this.errorToastElement === toast) {
      this.errorToastElement = null
    }
    toast.remove()
  }
}

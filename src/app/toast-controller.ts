import { iconFor } from '../icons'

export const TOAST_DISMISS_MS = 3000
export const MAX_VISIBLE_TOASTS = 3

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  run: () => Promise<void> | void
}

export interface ToastHandle {
  dismiss: () => void
  isVisible: () => boolean
}

type ToastTimer = ReturnType<typeof setTimeout>

interface CloseHandler {
  button: HTMLButtonElement
  listener: () => void
}

/** Owns toast DOM, dismissal timers, and accessible error replacement. */
export class ToastController {
  private readonly timers = new Map<HTMLElement, ToastTimer>()
  private readonly closeHandlers = new Map<HTMLElement, CloseHandler[]>()
  private readonly toasts = new Set<HTMLElement>()
  private errorToastElement: HTMLElement | null = null
  private disposed = false

  constructor(private readonly stack: HTMLElement) {}

  show(message: string, tone: ToastTone, actions: readonly ToastAction[] = [], detail?: string): ToastHandle {
    if (this.disposed) {
      return { dismiss: () => {}, isVisible: () => false }
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
    const content = document.createElement('div')
    content.className = 'toast-content'
    content.append(copy)
    toast.append(content)
    if (detail) toast.title = detail
    const handlers: CloseHandler[] = []
    if (actions.length > 0) {
      const actionRow = document.createElement('div')
      actionRow.className = 'toast-actions'
      const buttons: HTMLButtonElement[] = []
      for (const action of actions) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'toast-action'
        button.textContent = action.label
        const listener = (): void => {
          if (buttons.some((entry) => entry.disabled)) return
          buttons.forEach((entry) => { entry.disabled = true })
          void Promise.resolve().then(action.run).finally(() => {
            buttons.forEach((entry) => { entry.disabled = false })
          })
        }
        button.addEventListener('click', listener)
        handlers.push({ button, listener })
        buttons.push(button)
        actionRow.append(button)
      }
      content.append(actionRow)
    }

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
      handlers.push({ button: close, listener })
      this.errorToastElement = toast
      toast.append(close)
    }

    this.closeHandlers.set(toast, handlers)

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
    return { dismiss: () => this.dismissToast(toast), isVisible: () => this.toasts.has(toast) }
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

    const closeHandlers = this.closeHandlers.get(toast)
    if (closeHandlers) {
      for (const handler of closeHandlers) {
        handler.button.removeEventListener('click', handler.listener)
      }
      this.closeHandlers.delete(toast)
    }

    this.toasts.delete(toast)
    if (this.errorToastElement === toast) {
      this.errorToastElement = null
    }
    toast.remove()
  }
}

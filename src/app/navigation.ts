import type { ProblemFileEntry } from '../backend'
import type { RepositoryRefreshRequest, RepositoryRefreshState } from './types'

/**
 * Return the only group allowed to stay open in the file explorer accordion.
 * Keeping this transition pure makes the one-open-group rule easy to reuse
 * when the UI is rendered after a file open or refresh.
 */
export function accordionGroupKeys(
  group: ProblemFileEntry['packageSegment'],
  expanded: boolean,
): ProblemFileEntry['packageSegment'][] {
  return expanded ? [group] : []
}

/**
 * Pick the tab that should replace a closed tab. The index is from the tab
 * list before removal; after removal that index points at the tab on the
 * right, or the final remaining tab on the left when the closed tab was last.
 */
export function replacementTabIndex(remainingCount: number, closedIndex: number): number | null {
  if (remainingCount <= 0 || closedIndex < 0 || closedIndex > remainingCount) {
    return null
  }
  return closedIndex < remainingCount ? closedIndex : remainingCount - 1
}

/** The keyboard fields needed to recognize the platform-specific tab-close shortcut. */
export interface TabCloseShortcutEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/**
 * Match only Cmd+W on Apple platforms and Alt+W everywhere else. Keeping the
 * platform and event data as arguments makes the shortcut behavior testable
 * without depending on the host browser's navigator or KeyboardEvent.
 */
export function isCloseTabShortcut(
  event: TabCloseShortcutEvent,
  macPlatform: boolean,
): boolean {
  if (event.key.toLowerCase() !== 'w' || event.shiftKey) {
    return false
  }
  return macPlatform
    ? event.metaKey && !event.altKey && !event.ctrlKey
    : event.altKey && !event.metaKey && !event.ctrlKey
}

/** Match the platform-specific close-all-tabs shortcut without reading browser globals. */
export function isCloseAllTabsShortcut(
  event: TabCloseShortcutEvent,
  macPlatform: boolean,
): boolean {
  if (event.key.toLowerCase() !== 'w' || !event.shiftKey) {
    return false
  }
  return macPlatform
    ? event.metaKey && !event.altKey && !event.ctrlKey
    : event.altKey && !event.metaKey && !event.ctrlKey
}

/** Whether a wheel event should move the open-file tab strip horizontally. */
export function isFileTabsShiftWheel(
  event: Pick<WheelEvent, 'deltaY' | 'shiftKey'>,
): boolean {
  return event.shiftKey && event.deltaY !== 0
}

export function isCurrentRepositoryRefresh(
  request: RepositoryRefreshRequest,
  state: RepositoryRefreshState,
): boolean {
  return state.projectValid
    && state.repoPath === request.repoPath
    && state.repositoryGeneration === request.repositoryGeneration
    && state.refreshRequestId === request.requestId
}

export type DirectoryPicker = () => Promise<string | null>

/**
 * Allows only one native repository picker at a time. Native pickers can be
 * hidden by another window on some Linux desktops, so repeated clicks must
 * not create an unbounded stack of dialogs while the first request is open.
 */
export class RepositoryPickerCoordinator {
  private pending = false

  get isOpen(): boolean {
    return this.pending
  }

  open(picker: DirectoryPicker): Promise<string | null> | null {
    if (this.pending) {
      return null
    }
    this.pending = true
    return (async (): Promise<string | null> => {
      try {
        return await picker()
      } finally {
        this.pending = false
      }
    })()
  }
}

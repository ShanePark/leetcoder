import { clearProgressOverlay, syncProgressOverlay, type ProgressOverlayState } from './progress-overlay'

/**
 * The visible stages of a Commit & Push operation. Git does not expose a
 * byte-level progress value, so the operation is represented by the five
 * user meaningful phases already reported by GitController.
 */
export const GIT_PROGRESS_STAGES = [
  { label: 'Prepare changes', detail: 'Saving the current file before committing' },
  { label: 'Pull latest changes', detail: 'Updating the branch from the remote repository' },
  { label: 'Create commit', detail: 'Writing the selected changes to Git' },
  { label: 'Push changes', detail: 'Sending the commit to the remote repository' },
  { label: 'Refresh status', detail: 'Loading the latest repository status' },
] as const

const GIT_PROGRESS_LABELS = [
  'Preparing commit and push…',
  'Pulling latest changes…',
  'Committing changes…',
  'Pushing changes…',
  'Refreshing Git status…',
] as const

export function gitProgressStageIndex(label: string | null | undefined): number {
  const index = GIT_PROGRESS_LABELS.indexOf(label as typeof GIT_PROGRESS_LABELS[number])
  return index >= 0 ? index : 0
}

export function gitProgressOverlayState(label: string): ProgressOverlayState {
  return {
    kicker: 'Commit & Push',
    title: 'Publishing changes',
    stages: GIT_PROGRESS_STAGES,
    current: gitProgressStageIndex(label),
    detail: label,
    footnote: 'Keep this window open while the changes are published.',
  }
}

/** Roots whose overlay Git mounted, so an idle Git render never removes another feature's overlay. */
const gitOverlayRoots = new WeakSet<HTMLElement>()

export function syncGitProgressOverlay(
  root: HTMLElement,
  active: boolean,
  label: string | null | undefined,
): void {
  if (active && label) {
    gitOverlayRoots.add(root)
    syncProgressOverlay(root, gitProgressOverlayState(label))
  } else if (gitOverlayRoots.delete(root)) {
    syncProgressOverlay(root, null)
  }
}

/** Remove any progress modal when the application is torn down. */
export function clearGitProgressOverlay(root: HTMLElement): void {
  gitOverlayRoots.delete(root)
  clearProgressOverlay(root)
}

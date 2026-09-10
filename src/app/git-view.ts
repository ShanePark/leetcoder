import type { GitChangedFile, GitState } from './types'
import { iconFor } from '../icons'
import {
  defaultGitCommitMessage,
  gitFileName,
  gitStatusGlyph,
  normalizeGitStatusLabel,
  parseUnifiedDiffLines,
} from './git-helpers'
import { gitDirectoryPath } from './path-helpers'

export interface GitPanelViewModel {
  bottomPanelTab: 'tests' | 'git'
  busy: boolean
  git: Readonly<GitState>
  /** Human-readable progress for a Git mutation, when one is in flight. */
  operationLabel?: string | null
}

export interface GitPanelViewCallbacks {
  onToggleFile: (path: string, selected: boolean) => void
  onSelectFile: (path: string) => void
  onContextMenu: (file: GitChangedFile, x: number, y: number) => void
}

export function selectedGitFiles(
  files: readonly GitChangedFile[],
  selectedPaths: ReadonlySet<string>,
): GitChangedFile[] {
  return files.filter((file) => selectedPaths.has(file.path))
}

export function renderGitPanel(
  root: HTMLElement,
  model: GitPanelViewModel,
  callbacks: GitPanelViewCallbacks,
): void {
  const panel = requiredElement<HTMLElement>(root, '#git-panel')
  panel.hidden = model.bottomPanelTab !== 'git'
  const { busy, git } = model
  panel.setAttribute('aria-busy', String(git.busy))
  requiredElement<HTMLElement>(root, '#git-branch').textContent = git.branch ?? ''
  const count = requiredElement<HTMLElement>(root, '#git-file-count')
  count.textContent = git.files.length > 0 ? String(git.files.length) : ''
  count.hidden = git.files.length === 0
  const status = requiredElement<HTMLElement>(root, '#git-status')
  status.className = 'git-status'
  status.removeAttribute('aria-busy')
  if (git.error) {
    status.hidden = false
    status.textContent = git.error
  } else {
    const operationLabel = model.operationLabel ?? (git.busy ? 'Working…' : null)
    status.hidden = operationLabel === null
    status.textContent = ''
    if (operationLabel !== null) {
      status.classList.add('is-progress')
      status.setAttribute('aria-busy', 'true')
      status.append(iconFor('loader', 'git-status-icon is-spinning'))
      status.append(document.createTextNode(operationLabel))
    }
  }

  const selectedPaths = new Set(git.selectedPaths)
  const list = requiredElement<HTMLElement>(root, '#git-file-list')
  list.innerHTML = ''
  if (git.loading && git.files.length === 0) {
    const loading = document.createElement('div')
    loading.className = 'git-empty git-loading'
    loading.textContent = 'Loading…'
    list.append(loading)
  } else if (git.files.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'git-empty'
    empty.textContent = 'No changes'
    list.append(empty)
  } else {
    for (const file of git.files) {
      const row = document.createElement('div')
      row.className = 'git-file-row'
      row.classList.toggle('is-active', file.path === git.activePath)
      row.classList.toggle('is-selected', selectedPaths.has(file.path))
      row.title = file.path
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'git-file-checkbox'
      checkbox.checked = selectedPaths.has(file.path)
      checkbox.setAttribute('aria-label', `Select ${file.path} for commit`)
      checkbox.disabled = busy || git.busy || git.loading
      checkbox.addEventListener('change', () => {
        callbacks.onToggleFile(file.path, checkbox.checked)
      })
      const fileButton = document.createElement('button')
      fileButton.type = 'button'
      fileButton.className = 'git-file-button'
      fileButton.disabled = busy || git.busy
      fileButton.addEventListener('click', () => callbacks.onSelectFile(file.path))
      const statusBadge = document.createElement('span')
      statusBadge.className = `git-file-status git-file-status-${normalizeGitStatusLabel(file.status)}`
      statusBadge.textContent = gitStatusGlyph(file.status)
      statusBadge.setAttribute('aria-label', file.status)
      const fileName = document.createElement('span')
      fileName.className = 'git-file-name'
      fileName.textContent = gitFileName(file.path)
      fileButton.append(statusBadge, fileName)
      const dirPath = gitDirectoryPath(file.path)
      if (dirPath) {
        const filePath = document.createElement('span')
        filePath.className = 'git-file-path'
        // The LRM guards keep punctuation from flipping when direction:rtl
        // is used to ellipsize the head of the path instead of the tail.
        filePath.textContent = `‎${dirPath}‎`
        filePath.title = dirPath
        fileButton.append(filePath)
      }
      const stats = document.createElement('span')
      stats.className = 'git-file-stats'
      if (file.additions !== null) {
        const additions = document.createElement('span')
        additions.className = 'git-additions'
        additions.textContent = `+${file.additions}`
        stats.append(additions)
      }
      if (file.deletions !== null) {
        const deletions = document.createElement('span')
        deletions.className = 'git-deletions'
        deletions.textContent = `−${file.deletions}`
        stats.append(deletions)
      }
      fileButton.append(stats)
      row.append(checkbox, fileButton)
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        callbacks.onContextMenu(file, event.clientX, event.clientY)
      })
      list.append(row)
    }
  }

  const activeFile = git.files.find((file) => file.path === git.activePath)
  const diffFile = requiredElement<HTMLElement>(root, '#git-diff-file')
  diffFile.textContent = activeFile ? gitFileName(activeFile.path) : 'Select a file'
  if (activeFile) {
    diffFile.title = activeFile.path
  } else {
    diffFile.removeAttribute('title')
  }
  const diffState = requiredElement<HTMLElement>(root, '#git-diff-state')
  diffState.textContent = activeFile ? normalizeGitStatusLabel(activeFile.status) : ''
  diffState.hidden = !activeFile
  const diff = requiredElement<HTMLElement>(root, '#git-diff')
  diff.innerHTML = ''
  if (git.diffLoading && activeFile && !git.diffByPath[activeFile.path]) {
    const loading = document.createElement('div')
    loading.className = 'git-empty git-loading'
    loading.textContent = 'Loading…'
    diff.append(loading)
  } else if (activeFile) {
    const text = git.diffByPath[activeFile.path] ?? ''
    if (text) {
      diff.append(renderUnifiedDiff(text))
    } else {
      const empty = document.createElement('div')
      empty.className = 'git-empty'
      empty.textContent = 'No diff available'
      diff.append(empty)
    }
  } else {
    const empty = document.createElement('div')
    empty.className = 'git-empty'
    empty.textContent = git.files.length === 0 ? 'No changes' : 'Select a file'
    diff.append(empty)
  }

  const input = requiredElement<HTMLInputElement>(root, '#git-commit-message')
  if (input.value !== git.commitMessage) {
    input.value = git.commitMessage
  }
  updateGitCommitControls(root, model, selectedPaths)
}

/** Update commit controls without rebuilding the file list or diff. */
export function updateGitCommitControls(
  root: HTMLElement,
  model: GitPanelViewModel,
  selectedPaths = new Set(model.git.selectedPaths),
): void {
  const { busy, git } = model
  const selectedFiles = selectedGitFiles(git.files, selectedPaths)
  const input = requiredElement<HTMLInputElement>(root, '#git-commit-message')
  input.placeholder = defaultGitCommitMessage(selectedFiles)
  input.disabled = busy || git.busy || git.files.length === 0
  const commitDisabled = busy || git.busy || git.loading || git.selectedPaths.length === 0
  requiredElement<HTMLButtonElement>(root, '#git-commit').disabled = commitDisabled
  requiredElement<HTMLButtonElement>(root, '#git-commit-push').disabled = commitDisabled
  requiredElement<HTMLButtonElement>(root, '#git-select-all').disabled = busy || git.busy || git.loading || git.files.length === 0
  requiredElement<HTMLButtonElement>(root, '#git-select-none').disabled = busy || git.busy || git.loading || git.selectedPaths.length === 0
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing editor element: ${selector}`)
  }
  return element
}

function renderUnifiedDiff(diff: string): HTMLElement {
  const fragment = document.createDocumentFragment()
  for (const parsedLine of parseUnifiedDiffLines(diff)) {
    const row = document.createElement('div')
    row.className = `git-diff-line is-${parsedLine.kind}`
    const oldNumber = document.createElement('span')
    oldNumber.className = 'git-diff-line-number git-diff-old-line'
    const newNumber = document.createElement('span')
    newNumber.className = 'git-diff-line-number git-diff-new-line'
    const marker = document.createElement('span')
    marker.className = 'git-diff-line-marker'
    marker.textContent = parsedLine.marker
    marker.setAttribute('aria-hidden', 'true')
    const content = document.createElement('code')
    content.className = 'git-diff-line-content'
    // textContent is deliberate: source text must never be interpreted as
    // markup, and an empty code node still reserves the row's line height.
    content.textContent = parsedLine.content
    if (parsedLine.oldLine !== null) {
      oldNumber.textContent = String(parsedLine.oldLine)
    }
    if (parsedLine.newLine !== null) {
      newNumber.textContent = String(parsedLine.newLine)
    }
    row.append(oldNumber, newNumber, marker, content)
    fragment.append(row)
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'git-diff-lines'
  wrapper.append(fragment)
  return wrapper
}

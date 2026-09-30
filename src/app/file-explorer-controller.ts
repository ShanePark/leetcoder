import type { ProblemFileEntry, ProjectSearchMatch } from '../backend'
import type { AppState } from './types'
import type { DocumentController } from './document-controller'
import type { FileDialogController } from './file-dialog-controller'
import type { ProjectContentSearchController } from './project-search-controller'
import { accordionGroupKeys } from './navigation'
import { sameFilePath } from './path-helpers'
import { findProjectSearchLocation } from './project-search-location'
import { FILE_GROUPS, OTHER_GROUP, getFilenameMatchedPaths, renderFilesView } from './files-view'
import { iconFor } from '../icons'

interface FileExplorerControllerOptions {
  root: HTMLElement
  state: AppState
  document: Pick<DocumentController, 'openTabForPath' | 'openFile'>
  dialogs: Pick<FileDialogController, 'openFileContextMenu' | 'renderContextMenu'>
  search: Pick<ProjectContentSearchController, 'update'>
  repositoryGeneration: () => number
  isActive: () => boolean
  revealLine: (line: number, column: number) => void
}

/** Keep explorer expansion, file presentation and search navigation in one owner. */
export class FileExplorerController {
  private readonly root: HTMLElement
  private readonly state: AppState
  private readonly expandedGroups = new Set<ProblemFileEntry['packageSegment']>(
    accordionGroupKeys('easy', true),
  )

  constructor(private readonly options: FileExplorerControllerOptions) {
    this.root = options.root
    this.state = options.state
  }

  setExpandedGroup(
    group: ProblemFileEntry['packageSegment'],
    expanded: boolean,
  ): void {
    this.expandedGroups.clear()
    for (const key of accordionGroupKeys(group, expanded)) {
      this.expandedGroups.add(key)
    }
  }

  /** Focus the file explorer search field for the global navigation shortcut. */
  focusFileSearch(): void {
    this.element<HTMLInputElement>('#file-search').focus()
  }

  canNavigateProjectSearchMatch(match: ProjectSearchMatch): boolean {
    return this.state.projectValid
      && this.state.files.some((file) => sameFilePath(file.path, match.path))
  }

  async navigateToProjectSearchMatch(match: ProjectSearchMatch, query: string): Promise<void> {
    const repoPath = this.state.repoPath
    const repositoryGeneration = this.options.repositoryGeneration()
    const file = this.state.files.find((entry) => sameFilePath(entry.path, match.path))
    if (!repoPath || !this.state.projectValid || !file) {
      throw new Error('This search result is no longer available.')
    }

    await this.options.document.openFile(file)
    if (!this.options.isActive()) {
      return
    }
    if (this.state.repoPath !== repoPath || this.options.repositoryGeneration() !== repositoryGeneration) {
      return
    }
    if (this.state.fileSearch.trim() !== query) {
      return
    }
    if (!this.state.projectValid || !sameFilePath(this.state.selectedPath ?? '', file.path)) {
      throw new Error(`Could not open ${file.name}.`)
    }

    const location = findProjectSearchLocation(this.state.selectedSource, query)
    if (!location) {
      throw new Error('Matching text changed; search again.')
    }
    this.options.revealLine(location.line, location.column)
  }

  /** Update active/open explorer state without rebuilding the file list. */
  updateFileExplorerState(): void {
    for (const { key } of [...FILE_GROUPS, OTHER_GROUP]) {
      const groupList = this.root.querySelector<HTMLElement>(`#file-group-${key}`)
      const section = groupList?.closest<HTMLElement>('.file-group')
      if (!groupList || !section) {
        continue
      }
      const expanded = this.expandedGroups.has(key)
      const expansionChanged = section.dataset.expanded !== String(expanded)
      section.dataset.expanded = String(expanded)
      groupList.hidden = !expanded
      const toggle = section.querySelector<HTMLButtonElement>('.file-group-toggle')
      if (!toggle) {
        continue
      }
      toggle.setAttribute('aria-expanded', String(expanded))
      const icon = toggle.querySelector<SVGElement>('.group-toggle-icon')
      if (icon && expansionChanged) {
        icon.replaceWith(iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'))
      }
    }
    const selectedPath = this.state.selectedPath ?? ''
    this.root.querySelectorAll<HTMLButtonElement>('.file-item').forEach((button) => {
      const path = button.dataset.path ?? ''
      const active = sameFilePath(path, selectedPath)
      button.classList.toggle('is-active', active)
      button.classList.toggle('is-open', this.options.document.openTabForPath(path) !== null)
      if (active) {
        button.setAttribute('aria-current', 'page')
      } else {
        button.removeAttribute('aria-current')
      }
    })
    this.scrollActiveFileIntoView()
  }

  renderFiles(): void {
    const list = this.element<HTMLElement>('#file-list')
    renderFilesView(
      {
        list,
        searchInput: this.element<HTMLInputElement>('#file-search'),
        totalCount: this.element<HTMLElement>('#file-count'),
      },
      {
        projectValid: this.state.projectValid,
        files: this.state.files,
        selectedPath: this.state.selectedPath,
        fileSearch: this.state.fileSearch,
        expandedGroups: this.expandedGroups,
        busy: this.state.busy,
        isFileOpen: (path) => this.options.document.openTabForPath(path) !== null,
      },
      {
        onFileSelect: (file) => {
          void this.options.document.openFile(file)
        },
        onGroupToggle: (group, expanded) => {
          this.setExpandedGroup(group, expanded)
          this.renderFiles()
        },
        onFileContextMenu: (file, position) => {
          this.options.dialogs.openFileContextMenu(file, position.x, position.y)
        },
        onRendered: () => this.scrollActiveFileIntoView(),
      },
    )
    const titleMatchedPaths = getFilenameMatchedPaths(list)
    this.options.search.update(this.state.fileSearch, titleMatchedPaths)
    this.element<HTMLElement>('#file-results-viewport')
      .classList.toggle('is-searching', this.state.fileSearch.trim().length > 0)
    if (this.state.contextMenu && !this.state.files.some((file) => file.path === this.state.contextMenu?.file.path)) {
      this.state.contextMenu = null
    }
    this.options.dialogs.renderContextMenu()
  }

  scrollActiveFileIntoView(): void {
    if (!this.state.selectedPath) {
      return
    }
    const active = Array.from(this.root.querySelectorAll<HTMLElement>('.file-item'))
      .find((item) => item.dataset.path === this.state.selectedPath)
    const groupList = active?.closest<HTMLElement>('.file-group-list')
    if (!active || active.hidden || groupList?.hidden) {
      return
    }
    const scroll = (): void => {
      // Only the expanded group's list scrolls. Centering keeps a file opened
      // from Today or another action in context while the browser naturally
      // clamps the first and last rows to the list bounds.
      active.scrollIntoView?.({ block: 'center' })
    }
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scroll)
    } else {
      queueMicrotask(scroll)
    }
  }

  revealSelectedFileInExplorer(): void {
    const selected = this.state.files.find((file) => sameFilePath(file.path, this.state.selectedPath ?? ''))
    if (!selected) {
      return
    }
    const groupIsOnlyExpanded = this.expandedGroups.size === 1
      && this.expandedGroups.has(selected.packageSegment)
    if (!groupIsOnlyExpanded) {
      this.setExpandedGroup(selected.packageSegment, true)
      this.renderFiles()
      return
    }
    this.scrollActiveFileIntoView()
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing editor element: ${selector}`)
    return element
  }
}

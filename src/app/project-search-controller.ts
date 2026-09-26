import type { BackendClient, ProjectSearchMatch, ProjectSearchResult } from '../backend'
import { normalizeSourcePath, sourceBasename } from './path-helpers'

export const PROJECT_CONTENT_SEARCH_DEBOUNCE_MS = 450

export interface ProjectContentSearchControllerOptions {
  readonly host: HTMLElement
  readonly backend: Pick<BackendClient, 'searchProject'>
  readonly getRepositoryPath: () => string | null
  readonly beforeSearch?: () => Promise<boolean>
  readonly canNavigate: (match: ProjectSearchMatch) => boolean
  readonly onNavigate: (match: ProjectSearchMatch, query: string) => Promise<void>
}

interface SearchRequest {
  readonly id: number
  readonly query: string
  readonly repoPath: string
  readonly titleMatchedPaths: string[]
  readonly titlePathKeys: string[]
}

/** Debounce project-content scans and append their file hits after filename matches. */
export class ProjectContentSearchController {
  private readonly host: HTMLElement
  private readonly backend: ProjectContentSearchControllerOptions['backend']
  private readonly getRepositoryPath: ProjectContentSearchControllerOptions['getRepositoryPath']
  private readonly beforeSearch: ProjectContentSearchControllerOptions['beforeSearch']
  private readonly canNavigate: ProjectContentSearchControllerOptions['canNavigate']
  private readonly onNavigate: ProjectContentSearchControllerOptions['onNavigate']
  private readonly section: HTMLElement
  private readonly status: HTMLElement
  private readonly notices: HTMLElement
  private readonly results: HTMLElement
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestRequest: SearchRequest | null = null
  private readyRequestId: number | null = null
  private inFlightRequest: SearchRequest | null = null
  private requestSequence = 0
  private handledRequestId: number | null = null
  private disposed = false

  constructor(options: ProjectContentSearchControllerOptions) {
    this.host = options.host
    this.backend = options.backend
    this.getRepositoryPath = options.getRepositoryPath
    this.beforeSearch = options.beforeSearch
    this.canNavigate = options.canNavigate
    this.onNavigate = options.onNavigate

    const document = this.host.ownerDocument
    this.section = document.createElement('section')
    this.section.className = 'project-content-search'
    this.section.hidden = true

    const heading = document.createElement('h3')
    heading.className = 'project-content-search-heading'
    heading.textContent = 'Content matches'
    this.status = document.createElement('p')
    this.status.className = 'project-content-search-status'
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.notices = document.createElement('div')
    this.notices.className = 'project-content-search-notices'
    this.results = document.createElement('div')
    this.results.className = 'project-content-search-list'
    this.results.setAttribute('role', 'list')
    this.results.setAttribute('aria-label', 'Content matches')
    this.section.append(heading, this.status, this.notices, this.results)
    this.host.append(this.section)
  }

  /** Schedule a literal, case-insensitive scan after the user pauses typing. */
  update(query: string, titleMatchedPaths: readonly string[]): void {
    if (this.disposed) {
      return
    }
    const searchText = query.trim()
    const repoPath = this.getRepositoryPath()
    if (!searchText || !repoPath) {
      this.reset()
      return
    }

    const paths = [...new Set(titleMatchedPaths)]
    const titlePathKeys = [...new Set(paths.map(normalizeSourcePath).filter(Boolean))].sort()
    const previous = this.latestRequest
    if (previous
      && previous.query === searchText
      && previous.repoPath === repoPath
      && sameStrings(previous.titlePathKeys, titlePathKeys)
      && (this.timer !== null
        || this.inFlightRequest === previous
        || this.readyRequestId === previous.id
        || this.handledRequestId === previous.id)) {
      return
    }

    this.clearTimer()
    const request: SearchRequest = {
      id: ++this.requestSequence,
      query: searchText,
      repoPath,
      titleMatchedPaths: paths,
      titlePathKeys,
    }
    this.latestRequest = request
    this.readyRequestId = null
    this.handledRequestId = null
    this.clearResults()
    this.section.hidden = false
    this.status.textContent = this.inFlightRequest
      ? 'Waiting for the current content search…'
      : 'Waiting for typing to pause…'

    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.isCurrentRequest(request)) {
        if (this.latestRequest === request && this.getRepositoryPath() !== request.repoPath) {
          this.reset()
        }
        return
      }
      this.readyRequestId = request.id
      if (this.inFlightRequest) {
        this.status.textContent = 'Waiting for the current content search…'
        return
      }
      void this.runSearch(request)
    }, PROJECT_CONTENT_SEARCH_DEBOUNCE_MS)
  }

  /** Cancel queued work and hide results, such as when the repository changes. */
  reset(): void {
    if (this.disposed) {
      return
    }
    this.clearTimer()
    this.requestSequence += 1
    this.latestRequest = null
    this.readyRequestId = null
    this.handledRequestId = null
    this.clearResults()
    this.section.hidden = true
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearTimer()
    this.requestSequence += 1
    this.latestRequest = null
    this.readyRequestId = null
    this.handledRequestId = null
    this.section.remove()
  }

  private async runSearch(request: SearchRequest): Promise<void> {
    if (this.disposed
      || this.inFlightRequest
      || this.readyRequestId !== request.id
      || !this.isCurrentRequest(request)) {
      return
    }
    this.readyRequestId = null
    this.inFlightRequest = request
    this.status.textContent = 'Searching file contents…'
    let completed = false
    try {
      if (this.beforeSearch) {
        const saved = await this.beforeSearch()
        if (!this.isCurrentRequest(request)) {
          return
        }
        if (!saved) {
          this.status.textContent = 'Save pending changes before searching.'
          completed = true
          return
        }
      }
      if (!this.isCurrentRequest(request)) {
        return
      }
      const result = await this.backend.searchProject(
        request.repoPath,
        request.query,
        false,
        request.titleMatchedPaths,
      )
      if (!this.isCurrentRequest(request)) {
        return
      }
      this.renderResult(result, request)
      completed = true
    } catch (error) {
      if (this.isCurrentRequest(request)) {
        this.status.textContent = `Content search failed: ${errorText(error)}`
        completed = true
      }
    } finally {
      if (this.inFlightRequest === request) {
        this.inFlightRequest = null
      }
      if (completed && this.isCurrentRequest(request)) {
        this.handledRequestId = request.id
      }
      const latest = this.latestRequest
      if (latest && this.readyRequestId === latest.id) {
        void this.runSearch(latest)
      }
    }
  }

  private renderResult(result: ProjectSearchResult, request: SearchRequest): void {
    const excludedPaths = new Set(request.titlePathKeys)
    const seenPaths = new Set<string>()
    const matches: ProjectSearchMatch[] = []
    for (const match of result.matches) {
      const pathKey = normalizeSourcePath(match.path)
      if (!pathKey || excludedPaths.has(pathKey) || seenPaths.has(pathKey)) {
        continue
      }
      seenPaths.add(pathKey)
      matches.push(match)
    }

    this.results.replaceChildren()
    for (const match of matches) {
      this.results.append(this.renderMatch(match, request))
    }
    this.results.hidden = matches.length === 0
    this.status.textContent = matches.length === 0
      ? 'No content matches.'
      : `${matches.length} content result${matches.length === 1 ? '' : 's'}.`

    this.notices.replaceChildren()
    if (result.truncated) {
      this.appendNotice('Search results were capped. Some matching files may not be shown.')
    }
    if (result.skippedFiles > 0) {
      this.appendNotice(`Skipped ${result.skippedFiles} file${result.skippedFiles === 1 ? '' : 's'} that could not be searched.`)
    }
    this.notices.hidden = this.notices.childElementCount === 0
  }

  private renderMatch(match: ProjectSearchMatch, request: SearchRequest): HTMLElement {
    const navigable = this.canNavigate(match)
    const row = this.host.ownerDocument.createElement('div')
    row.className = 'project-content-search-row'
    row.setAttribute('role', 'listitem')
    const item = this.host.ownerDocument.createElement(navigable ? 'button' : 'article')
    item.className = navigable
      ? 'project-content-search-hit project-content-search-hit-button'
      : 'project-content-search-hit project-content-search-hit-preview'
    if (navigable) {
      const button = item as HTMLButtonElement
      button.type = 'button'
      button.setAttribute('aria-label', `${match.path}, line ${match.line}, column ${match.column}. ${match.preview}`)
      button.addEventListener('click', () => void this.navigate(match, request, button))
    }

    const path = this.host.ownerDocument.createElement('span')
    path.className = 'project-content-search-path'
    path.textContent = `${sourceBasename(match.path)}:${match.line}`
    path.title = match.path
    const preview = this.host.ownerDocument.createElement('code')
    preview.className = 'project-content-search-preview'
    preview.textContent = match.preview
    item.append(path, preview)
    if (!navigable) {
      const label = this.host.ownerDocument.createElement('span')
      label.className = 'project-content-search-preview-only'
      label.textContent = 'Preview only'
      item.append(label)
    }
    row.append(item)
    return row
  }

  private async navigate(
    match: ProjectSearchMatch,
    request: SearchRequest,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!this.isCurrentRequest(request) || !this.canNavigate(match)) {
      return
    }
    button.disabled = true
    try {
      await this.onNavigate(match, request.query)
      if (this.isCurrentRequest(request)) {
        this.status.textContent = `Opened ${match.path}:${match.line}.`
        button.disabled = false
      }
    } catch (error) {
      if (this.isCurrentRequest(request)) {
        this.status.textContent = `Could not open file: ${errorText(error)}`
        button.disabled = false
      }
    }
  }

  private appendNotice(message: string): void {
    const notice = this.host.ownerDocument.createElement('p')
    notice.textContent = message
    this.notices.append(notice)
  }

  private clearResults(): void {
    this.status.textContent = ''
    this.notices.replaceChildren()
    this.notices.hidden = true
    this.results.replaceChildren()
    this.results.hidden = true
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private isCurrentRequest(request: SearchRequest): boolean {
    return !this.disposed
      && this.latestRequest === request
      && this.getRepositoryPath() === request.repoPath
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

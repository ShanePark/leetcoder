// Renderer from 87dab17:src/app/files-view.ts, with local benchmark imports,
// a renamed entry point, and type/comment/formatting adjustments only.
import type { ProblemFileEntry } from '../../../src/backend'
import { iconFor } from '../../../src/icons'
import { sameFilePath } from '../../../src/app/path-helpers'

type FileGroupKey = ProblemFileEntry['packageSegment']

interface FileGroupDefinition {
  readonly key: FileGroupKey
  readonly label: string
}

const FILE_GROUPS: readonly FileGroupDefinition[] = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'xhard', label: 'Hard' },
]

const OTHER_GROUP: FileGroupDefinition = { key: 'other', label: 'Other' }

interface FilesViewElements {
  readonly list: HTMLElement
  readonly searchInput: HTMLInputElement
  readonly totalCount: HTMLElement
}

interface FilesViewModel {
  readonly projectValid: boolean
  readonly files: readonly ProblemFileEntry[]
  readonly selectedPath: string | null
  readonly fileSearch: string
  readonly expandedGroups: ReadonlySet<FileGroupKey>
  readonly busy: boolean
  readonly isFileOpen?: (path: string) => boolean
}

interface FilesViewCallbacks {
  readonly onFileSelect: (file: ProblemFileEntry) => void
  readonly onGroupToggle: (group: FileGroupKey, expanded: boolean) => void
  readonly onFileContextMenu: (
    file: ProblemFileEntry,
    position: { x: number; y: number },
  ) => void
  readonly onRendered?: () => void
}

/** Exact pre-optimization renderer retained only for reproducible benchmarks. */
export function renderFilesViewBaseline(
  elements: FilesViewElements,
  model: FilesViewModel,
  callbacks: FilesViewCallbacks,
): void {
  const { list, searchInput, totalCount } = elements
  list.innerHTML = ''
  if (searchInput.value !== model.fileSearch) {
    searchInput.value = model.fileSearch
  }

  if (!model.projectValid) {
    totalCount.textContent = ''
    const empty = document.createElement('p')
    empty.className = 'muted-copy sidebar-empty'
    empty.textContent = 'Choose a repository to see problems'
    list.append(empty)
    return
  }

  const javaFiles = model.files.filter((file) => /\.java$/i.test(file.path))
  totalCount.textContent = javaFiles.length > 0 ? String(javaFiles.length) : ''

  const searchTerm = model.fileSearch.trim()
  const filteredFiles = filterFiles(javaFiles, searchTerm)
  if (searchTerm && filteredFiles.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted-copy sidebar-empty'
    empty.textContent = 'No matches'
    list.append(empty)
    return
  }

  const grouped = groupFiles(filteredFiles)
  const anyFiles = grouped.some((entry) => entry.files.length > 0)
  for (const { group, files } of grouped) {
    if (files.length === 0 && (anyFiles || group.key === 'other')) {
      continue
    }
    list.append(renderGroup(group, files, model, callbacks))
  }

  callbacks.onRendered?.()
}

interface GroupedFiles {
  readonly group: FileGroupDefinition
  readonly files: ProblemFileEntry[]
}

function filterFiles(files: readonly ProblemFileEntry[], query: string): ProblemFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return [...files]
  return files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
}

function groupFiles(files: readonly ProblemFileEntry[]): GroupedFiles[] {
  const groups = [...FILE_GROUPS, OTHER_GROUP]
  const filesByGroup = new Map<FileGroupKey, ProblemFileEntry[]>()
  for (const group of groups) filesByGroup.set(group.key, [])
  for (const file of files) filesByGroup.get(file.packageSegment)?.push(file)
  return groups.map((group) => ({
    group,
    files: filesByGroup.get(group.key) ?? [],
  }))
}

function renderGroup(
  group: FileGroupDefinition,
  files: readonly ProblemFileEntry[],
  model: FilesViewModel,
  callbacks: FilesViewCallbacks,
): HTMLElement {
  const section = document.createElement('section')
  section.className = 'file-group'
  const expanded = model.expandedGroups.has(group.key)
  section.dataset.expanded = String(expanded)

  const headingButton = document.createElement('button')
  headingButton.type = 'button'
  headingButton.className = 'file-group-toggle'
  headingButton.setAttribute('aria-expanded', String(expanded))
  headingButton.setAttribute('aria-controls', `file-group-${group.key}`)

  const groupLabel = document.createElement('span')
  groupLabel.className = 'file-group-label'
  groupLabel.append(
    iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon'),
    createGroupDot(group.key),
    document.createTextNode(group.label),
  )
  const count = document.createElement('span')
  count.className = 'file-count'
  count.textContent = String(files.length)
  headingButton.append(groupLabel, count)
  headingButton.addEventListener('click', () => {
    callbacks.onGroupToggle(group.key, !model.expandedGroups.has(group.key))
  })
  section.append(headingButton)

  const groupList = document.createElement('div')
  groupList.className = 'file-group-list'
  groupList.id = `file-group-${group.key}`
  groupList.hidden = !expanded
  for (const file of files) groupList.append(renderFile(file, model, callbacks))
  if (files.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'group-empty'
    empty.textContent = 'No files yet'
    groupList.append(empty)
  }
  section.append(groupList)
  return section
}

function renderFile(
  file: ProblemFileEntry,
  model: FilesViewModel,
  callbacks: FilesViewCallbacks,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'file-item'
  const active = sameFilePath(file.path, model.selectedPath ?? '')
  button.classList.toggle('is-active', active)
  button.classList.toggle('is-open', model.isFileOpen?.(file.path) ?? false)
  if (active) button.setAttribute('aria-current', 'page')
  button.disabled = model.busy
  button.setAttribute('aria-haspopup', 'menu')
  button.dataset.path = file.path
  button.title = file.path

  const fileName = document.createElement('span')
  fileName.className = 'file-item-name'
  fileName.textContent = file.name.replace(/\.java$/i, '')
  button.append(fileName)
  button.addEventListener('click', () => callbacks.onFileSelect(file))
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    callbacks.onFileContextMenu(file, { x: event.clientX, y: event.clientY })
  })
  return button
}

function createGroupDot(groupKey: FileGroupKey): HTMLElement {
  const dot = document.createElement('span')
  dot.className = `group-dot group-dot-${groupKey}`
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

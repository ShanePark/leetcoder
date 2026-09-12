import type { ProblemFileEntry } from '../backend'
import { iconFor } from '../icons'
import { sameFilePath } from './path-helpers'

export type FileGroupKey = ProblemFileEntry['packageSegment']

export interface FileGroupDefinition {
  readonly key: FileGroupKey
  readonly label: string
}

/** The sidebar groups, in the order in which they are presented. */
export const FILE_GROUPS: readonly FileGroupDefinition[] = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'xhard', label: 'Hard' },
]

/** Files outside the difficulty packages are shown only when the group is non-empty. */
export const OTHER_GROUP: FileGroupDefinition = {
  key: 'other',
  label: 'Other',
}

export interface FilesViewElements {
  readonly list: HTMLElement
  readonly searchInput: HTMLInputElement
  readonly totalCount: HTMLElement
}

/**
 * The data needed to render the file explorer. Keeping this separate from
 * app state lets the renderer stay unaware of repository services and DOM
 * ownership outside the sidebar.
 */
export interface FilesViewModel {
  readonly projectValid: boolean
  readonly files: readonly ProblemFileEntry[]
  readonly selectedPath: string | null
  readonly fileSearch: string
  readonly expandedGroups: ReadonlySet<FileGroupKey>
  readonly busy: boolean
  readonly isFileOpen?: (path: string) => boolean
}

export interface FilesViewContextMenuPosition {
  readonly x: number
  readonly y: number
}

export interface FilesViewCallbacks {
  /** Open the selected problem file. */
  readonly onFileSelect: (file: ProblemFileEntry) => void
  /** Apply the accordion transition and rerender the sidebar. */
  readonly onGroupToggle: (group: FileGroupKey, expanded: boolean) => void
  /** Open the app-owned context menu at the pointer's client coordinates. */
  readonly onFileContextMenu: (
    file: ProblemFileEntry,
    position: FilesViewContextMenuPosition,
  ) => void
  /** Preserve the app-owned active-row reveal behavior after a full render. */
  readonly onRendered?: () => void
}

interface FileGroupDom {
  readonly section: HTMLElement
  readonly headingButton: HTMLButtonElement
  readonly groupList: HTMLElement
  toggleIcon: SVGElement | null
}

interface FilesViewRenderState {
  callbacks: FilesViewCallbacks
  structureKey: string | null
  structureVersion: number
  expandedGroups: ReadonlySet<FileGroupKey>
  filesReference: readonly ProblemFileEntry[] | null
  fileSnapshot: readonly FileSnapshot[]
  javaFiles: readonly ProblemFileEntry[]
  searchTerm: string
  filteredFiles: readonly ProblemFileEntry[]
  grouped: readonly GroupedFiles[]
  anyFiles: boolean
  fileEntries: Map<string, ProblemFileEntry>
  fileButtons: Map<string, HTMLButtonElement[]>
  groups: Map<FileGroupKey, FileGroupDom>
}

/**
 * Keep one small renderer state per sidebar element. The app owns the model,
 * so this cache is deliberately DOM-scoped and is discarded with the list.
 * It lets unrelated app renders update row state without rebuilding every
 * file button and its event listeners.
 */
const renderStates = new WeakMap<HTMLElement, FilesViewRenderState>()

/**
 * Render the problem-file sidebar into its existing shell elements.
 *
 * Search matching is performed once, then the matched array is partitioned
 * into groups in one pass. This keeps the visible order and locale-aware,
 * case-insensitive matching of the original renderer without rescanning all
 * Java files once per group.
 */
export function renderFilesView(
  elements: FilesViewElements,
  model: FilesViewModel,
  callbacks: FilesViewCallbacks,
): void {
  const { list, searchInput, totalCount } = elements
  let state = renderStates.get(list)
  if (!state) {
    state = {
      callbacks,
      structureKey: null,
      structureVersion: 0,
      expandedGroups: model.expandedGroups,
      filesReference: null,
      fileSnapshot: [],
      javaFiles: [],
      searchTerm: '',
      filteredFiles: [],
      grouped: [],
      anyFiles: false,
      fileEntries: new Map(),
      fileButtons: new Map(),
      groups: new Map(),
    }
    renderStates.set(list, state)
  } else {
    // Event handlers read the current callbacks from this object. The app
    // creates callback closures during each render, but the rows stay live.
    state.callbacks = callbacks
  }

  if (searchInput.value !== model.fileSearch) {
    searchInput.value = model.fileSearch
  }

  if (!model.projectValid) {
    const structureKey = 'invalid-project'
    if (state.structureKey !== structureKey) {
      renderEmptyState(list, state, structureKey, 'Choose a repository to see problems')
    }
    totalCount.textContent = ''
    return
  }

  const fileArrayChanged = state.filesReference !== model.files
  const filesChanged = fileArrayChanged || !sameFileSnapshot(state.fileSnapshot, model.files)
  const javaFiles = fileArrayChanged || filesChanged
    ? model.files.filter((file) => /\.java$/i.test(file.path))
    : state.javaFiles
  if (filesChanged) {
    state.fileSnapshot = model.files.map((file) => ({
      entry: file,
      path: file.path,
      name: file.name,
      packageSegment: file.packageSegment,
    }))
  }
  if (fileArrayChanged || filesChanged) {
    state.filesReference = model.files
    state.javaFiles = javaFiles
  }
  totalCount.textContent = javaFiles.length > 0 ? String(javaFiles.length) : ''

  const searchTerm = model.fileSearch.trim().toLocaleLowerCase()
  const structureDataChanged = filesChanged || state.searchTerm !== searchTerm
  if (structureDataChanged) {
    state.structureVersion += 1
    state.searchTerm = searchTerm
    const filteredFiles = filterFiles(javaFiles, searchTerm)
    state.filteredFiles = filteredFiles
    state.grouped = groupFiles(filteredFiles)
    state.anyFiles = state.grouped.some((entry) => entry.files.length > 0)
  }
  const grouped = state.grouped
  const anyFiles = state.anyFiles
  if (searchTerm && state.filteredFiles.length === 0) {
    const structureKey = `no-matches\u0000${searchTerm}\u0000${state.structureVersion}`
    if (state.structureKey !== structureKey) {
      renderEmptyState(list, state, structureKey, 'No matches')
    }
    return
  }

  const structureKey = `groups\u0000${searchTerm}\u0000${state.structureVersion}\u0000${visibleGroupKeys(grouped, anyFiles)}`
  const structureChanged = state.structureKey !== structureKey
  state.expandedGroups = model.expandedGroups

  if (structureChanged) {
    renderGroups(list, state, structureKey, grouped, anyFiles, model)
  }

  const currentFileByPath = fileArrayChanged || filesChanged
    ? new Map(model.files.map((file) => [file.path, file]))
    : undefined
  const rowsChanged = updateRows(state, grouped, anyFiles, model, currentFileByPath)
  if (structureChanged || rowsChanged) {
    // Rebuilds need the same post-render reveal that the previous renderer
    // provided, even when the initial row state already matches the model.
    callbacks.onRendered?.()
  }
}

function renderEmptyState(
  list: HTMLElement,
  state: FilesViewRenderState,
  structureKey: string,
  message: string,
): void {
  list.innerHTML = ''
  state.structureKey = structureKey
  state.fileEntries.clear()
  state.fileButtons.clear()
  state.groups.clear()
  const empty = document.createElement('p')
  empty.className = 'muted-copy sidebar-empty'
  empty.textContent = message
  list.append(empty)
}

function renderGroups(
  list: HTMLElement,
  state: FilesViewRenderState,
  structureKey: string,
  grouped: readonly GroupedFiles[],
  anyFiles: boolean,
  model: FilesViewModel,
): void {
  list.innerHTML = ''
  state.structureKey = structureKey
  state.fileEntries.clear()
  state.fileButtons.clear()
  state.groups.clear()

  for (const { group, files } of grouped) {
    // Hide empty groups once files exist, while retaining the empty difficulty
    // skeleton when a valid repository has no Java files yet. The Other group
    // is only useful when it contains a matching file.
    if (files.length === 0 && (anyFiles || group.key === 'other')) {
      continue
    }
    for (const file of files) {
      state.fileEntries.set(file.path, file)
    }
    const groupDom = renderGroup(group, files, model, state)
    state.groups.set(group.key, groupDom)
    list.append(groupDom.section)
  }
}

function visibleGroupKeys(grouped: readonly GroupedFiles[], anyFiles: boolean): string {
  return grouped
    .filter(({ group, files }) => files.length > 0 || (!anyFiles && group.key !== 'other'))
    .map(({ group }) => group.key)
    .join(',')
}

interface FileSnapshot {
  readonly entry: ProblemFileEntry
  readonly path: string
  readonly name: string
  readonly packageSegment: FileGroupKey
}

function sameFileSnapshot(
  snapshot: readonly FileSnapshot[],
  files: readonly ProblemFileEntry[],
): boolean {
  if (snapshot.length !== files.length) {
    return false
  }
  for (let index = 0; index < files.length; index += 1) {
    const previous = snapshot[index]
    const current = files[index]
    if (!previous
      || previous.entry !== current
      || previous.path !== current.path
      || previous.name !== current.name
      || previous.packageSegment !== current.packageSegment) {
      return false
    }
  }
  return true
}

function updateRows(
  state: FilesViewRenderState,
  grouped: readonly GroupedFiles[],
  anyFiles: boolean,
  model: FilesViewModel,
  currentFileByPath?: ReadonlyMap<string, ProblemFileEntry>,
): boolean {
  let changed = false
  state.fileEntries.clear()

  for (const { group, files } of grouped) {
    if (files.length === 0 && (anyFiles || group.key === 'other')) {
      continue
    }
    for (const file of files) {
      const currentFile = currentFileByPath?.get(file.path) ?? file
      state.fileEntries.set(currentFile.path, currentFile)
    }
    const groupDom = state.groups.get(group.key)
    if (!groupDom) {
      continue
    }
    const expanded = model.expandedGroups.has(group.key)
    const expandedValue = String(expanded)
    const wasExpanded = groupDom.section.dataset.expanded === 'true'
    if (groupDom.section.dataset.expanded !== expandedValue) {
      groupDom.section.dataset.expanded = expandedValue
      changed = true
    }
    if (groupDom.groupList.hidden !== !expanded) {
      groupDom.groupList.hidden = !expanded
      changed = true
    }
    if (groupDom.headingButton.getAttribute('aria-expanded') !== expandedValue) {
      groupDom.headingButton.setAttribute('aria-expanded', expandedValue)
      changed = true
    }
    const liveToggleIcon = groupDom.headingButton.querySelector<SVGElement>('.group-toggle-icon')
    if (liveToggleIcon) {
      groupDom.toggleIcon = liveToggleIcon
    }
    const toggleIcon = liveToggleIcon ?? groupDom.toggleIcon
    if (toggleIcon && wasExpanded !== expanded) {
      const next = iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon')
      toggleIcon.replaceWith(next)
      groupDom.toggleIcon = next as SVGElement
      changed = true
    }

    for (const file of files) {
      const buttons = state.fileButtons.get(file.path) ?? []
      const currentFile = currentFileByPath?.get(file.path) ?? file
      const active = sameFilePath(currentFile.path, model.selectedPath ?? '')
      const open = model.isFileOpen?.(currentFile.path) ?? false
      for (const button of buttons) {
        const hadActive = button.classList.contains('is-active')
        const hadOpen = button.classList.contains('is-open')
        const hadCurrent = button.getAttribute('aria-current') === 'page'
        if (hadActive !== active) {
          button.classList.toggle('is-active', active)
          changed = true
        }
        if (hadOpen !== open) {
          button.classList.toggle('is-open', open)
          changed = true
        }
        if (button.disabled !== model.busy) {
          button.disabled = model.busy
          changed = true
        }
        if (active !== hadCurrent) {
          if (active) button.setAttribute('aria-current', 'page')
          else button.removeAttribute('aria-current')
          changed = true
        }
      }
    }
  }

  return changed
}

interface GroupedFiles {
  readonly group: FileGroupDefinition
  readonly files: ProblemFileEntry[]
}

function filterFiles(
  files: readonly ProblemFileEntry[],
  query: string,
): ProblemFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return [...files]
  }
  return files.filter((file) => file.name.toLocaleLowerCase().includes(normalizedQuery))
}

function groupFiles(files: readonly ProblemFileEntry[]): GroupedFiles[] {
  const groups = [...FILE_GROUPS, OTHER_GROUP]
  const filesByGroup = new Map<FileGroupKey, ProblemFileEntry[]>()
  for (const group of groups) {
    filesByGroup.set(group.key, [])
  }
  for (const file of files) {
    filesByGroup.get(file.packageSegment)?.push(file)
  }
  return groups.map((group) => ({
    group,
    files: filesByGroup.get(group.key) ?? [],
  }))
}

function renderGroup(
  group: FileGroupDefinition,
  files: readonly ProblemFileEntry[],
  model: FilesViewModel,
  state: FilesViewRenderState,
): FileGroupDom {
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
  const toggleIcon = iconFor(expanded ? 'chevronDown' : 'chevronRight', 'group-toggle-icon') as SVGElement
  groupLabel.append(toggleIcon, createGroupDot(group.key), document.createTextNode(group.label))
  const count = document.createElement('span')
  count.className = 'file-count'
  count.textContent = String(files.length)
  headingButton.append(groupLabel, count)
  headingButton.addEventListener('click', () => {
    state.callbacks.onGroupToggle(group.key, !state.expandedGroups.has(group.key))
  })
  section.append(headingButton)

  const groupList = document.createElement('div')
  groupList.className = 'file-group-list'
  groupList.id = `file-group-${group.key}`
  groupList.hidden = !expanded
  for (const file of files) {
    const button = renderFile(file, model, state)
    const buttons = state.fileButtons.get(file.path) ?? []
    buttons.push(button)
    state.fileButtons.set(file.path, buttons)
    groupList.append(button)
  }
  if (files.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'group-empty'
    empty.textContent = 'No files yet'
    groupList.append(empty)
  }
  section.append(groupList)
  return { section, headingButton, groupList, toggleIcon }
}

function renderFile(
  file: ProblemFileEntry,
  model: FilesViewModel,
  state: FilesViewRenderState,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'file-item'
  const active = sameFilePath(file.path, model.selectedPath ?? '')
  button.classList.toggle('is-active', active)
  button.classList.toggle('is-open', model.isFileOpen?.(file.path) ?? false)
  if (active) {
    button.setAttribute('aria-current', 'page')
  }
  button.disabled = model.busy
  button.setAttribute('aria-haspopup', 'menu')
  button.dataset.path = file.path
  button.title = file.path

  const fileName = document.createElement('span')
  fileName.className = 'file-item-name'
  fileName.textContent = file.name.replace(/\.java$/i, '')
  button.append(fileName)
  button.addEventListener('click', () => {
    const currentFile = state.fileEntries.get(file.path)
    if (currentFile) {
      state.callbacks.onFileSelect(currentFile)
    }
  })
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const currentFile = state.fileEntries.get(file.path)
    if (currentFile) {
      state.callbacks.onFileContextMenu(currentFile, { x: event.clientX, y: event.clientY })
    }
  })
  return button
}

/** The 6px colored difficulty dot in a sidebar group heading. */
function createGroupDot(groupKey: FileGroupKey): HTMLElement {
  const dot = document.createElement('span')
  dot.className = `group-dot group-dot-${groupKey}`
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

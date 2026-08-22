import {
  Calendar,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  FilePlus2,
  FolderOpen,
  LocateFixed,
  Play,
  RefreshCw,
  Search,
  Terminal,
  createElement,
  type IconNode,
} from 'lucide'

/**
 * Small, tree-shakable icon surface for the editor UI. Keeping icon creation
 * here makes it harder for a rerender to accidentally produce inconsistent
 * size, stroke, or accessibility attributes.
 */
export const appIcons = {
  calendar: Calendar,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  externalLink: ExternalLink,
  fileCode: FileCode,
  filePlus: FilePlus2,
  folderOpen: FolderOpen,
  locate: LocateFixed,
  play: Play,
  refresh: RefreshCw,
  search: Search,
  terminal: Terminal,
} as const

export type AppIcon = keyof typeof appIcons

export function createAppIcon(
  icon: IconNode,
  className = 'app-icon',
): SVGElement {
  return createElement(icon, {
    class: className,
    width: 16,
    height: 16,
    'stroke-width': 1.8,
    'aria-hidden': 'true',
    focusable: 'false',
  })
}

export function iconFor(name: AppIcon, className?: string): SVGElement {
  return createAppIcon(appIcons[name], className)
}

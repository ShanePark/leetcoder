import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileCode,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Info,
  Keyboard,
  LoaderCircle,
  LocateFixed,
  Menu,
  Monitor,
  Moon,
  Play,
  Power,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Terminal,
  X,
  createElement,
  type IconNode,
} from 'lucide'

/**
 * Small, tree-shakable icon surface for the editor UI. Keeping icon creation
 * here makes it harder for a rerender to accidentally produce inconsistent
 * size, stroke, or accessibility attributes.
 */
export const appIcons = {
  alert: CircleAlert,
  bookOpen: BookOpen,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  close: X,
  externalLink: ExternalLink,
  fileCode: FileCode,
  filePlus: FilePlus2,
  folderOpen: FolderOpen,
  gitBranch: GitBranch,
  info: Info,
  keyboard: Keyboard,
  loader: LoaderCircle,
  locate: LocateFixed,
  menu: Menu,
  monitor: Monitor,
  moon: Moon,
  play: Play,
  power: Power,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  sun: Sun,
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

import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Info,
  Keyboard,
  LoaderCircle,
  LocateFixed,
  Menu,
  MessageSquareCode,
  Minus,
  Monitor,
  Moon,
  PanelLeft,
  Play,
  Power,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Terminal,
  X,
  createElement,
  type IconNode,
} from 'lucide'

/**
 * PanelLeft with a fill behind its left pane; CSS shows the fill while the
 * pane it stands for is open.
 */
const PanelLeftToggle: IconNode = [
  ['path', { d: 'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z', class: 'panel-left-fill' }],
  ...PanelLeft,
]

/**
 * Small, tree-shakable icon surface for the editor UI. Keeping icon creation
 * here makes it harder for a rerender to accidentally produce inconsistent
 * size, stroke, or accessibility attributes.
 */
export const appIcons = {
  alert: CircleAlert,
  arrowRight: ArrowRight,
  bookOpen: BookOpen,
  calendarDays: CalendarDays,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  circlePlus: CirclePlus,
  close: X,
  download: Download,
  externalLink: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
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
  panelLeft: PanelLeftToggle,
  play: Play,
  power: Power,
  refresh: RefreshCw,
  review: MessageSquareCode,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  sun: Sun,
  terminal: Terminal,
  windowMaximize: Square,
  windowMinimize: Minus,
  windowRestore: Copy,
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

import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  EditorView,
  keymap,
  showTooltip,
  type EditorView as EditorViewType,
  type TooltipView,
} from '@codemirror/view'
import { javaIntentionsAt } from './planner'
import type { JavaIntentionsMenuState, JavaMethodCreationPlan } from './types'

/** Apply a planned create-method edit if its source snapshot is still current. */
export function applyJavaMethodCreation(view: EditorViewType, plan: JavaMethodCreationPlan): boolean {
  if (view.state.doc.toString() !== plan.source || view.state.readOnly) {
    view.dispatch({ effects: closeJavaIntentions.of(null) })
    return true
  }
  view.dispatch({
    changes: plan.change,
    selection: { anchor: plan.selection.from, head: plan.selection.to },
    scrollIntoView: true,
    userEvent: 'input.createMethod',
  })
  return true
}

export const setJavaIntentions = StateEffect.define<JavaIntentionsMenuState>()
export const closeJavaIntentions = StateEffect.define<null>()

function tooltipForMenu(menu: JavaIntentionsMenuState): { pos: number; above: boolean; arrow: boolean; create: (view: EditorView) => TooltipView } {
  return {
    pos: menu.anchor,
    above: false,
    arrow: true,
    create: (view) => new JavaIntentionsTooltip(view, menu),
  }
}

/** State backing the editor-only CodeMirror intentions tooltip. */
export const javaIntentionsState = StateField.define<JavaIntentionsMenuState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(closeJavaIntentions)) return null
      if (effect.is(setJavaIntentions)) return effect.value
    }
    if (value && (transaction.docChanged || transaction.selection !== undefined)) {
      return null
    }
    return value
  },
  provide: (field) => showTooltip.from(field, (value) => value ? tooltipForMenu(value) : null),
})

class JavaIntentionsTooltip implements TooltipView {
  readonly dom: HTMLElement

  constructor(private readonly view: EditorView, menu: JavaIntentionsMenuState) {
    const element = document.createElement('div')
    element.className = 'cm-intention-menu'
    element.setAttribute('role', 'menu')
    element.setAttribute('aria-label', 'Code actions')
    for (const [index, intention] of menu.intentions.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-intention-item'
      button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-selected', String(index === menu.selectedIndex))
      if (index === menu.selectedIndex) button.classList.add('is-selected')
      const label = document.createElement('span')
      label.className = 'cm-intention-label'
      label.textContent = intention.label
      const detail = document.createElement('span')
      detail.className = 'cm-intention-detail'
      detail.textContent = intention.detail
      button.append(label, detail)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        applyJavaMethodCreation(this.view, intention.plan)
        this.view.focus()
      })
      element.append(button)
    }
    this.dom = element
  }
}

const javaIntentionsTheme = EditorView.baseTheme({
  '.cm-intention-menu': {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '280px',
    padding: '4px',
    gap: '2px',
  },
  '.cm-intention-item': {
    display: 'flex',
    alignItems: 'baseline',
    width: '100%',
    padding: '6px 8px',
    border: '0',
    borderRadius: '4px',
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '13px',
    textAlign: 'left',
  },
  '.cm-intention-item:hover, .cm-intention-item.is-selected': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-intention-label': {
    fontWeight: '600',
  },
  '.cm-intention-detail': {
    marginLeft: '16px',
    color: 'var(--text-dim)',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  },
})

/** Open the intentions menu at the current cursor, if a safe action exists. */
export function showJavaIntentions(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (view.state.selection.ranges.length !== 1 || !selection.empty) return false
  const source = view.state.doc.toString()
  const intentions = javaIntentionsAt(source, selection.head)
  if (intentions.length === 0) return false
  view.dispatch({
    effects: setJavaIntentions.of({
      source,
      anchor: intentions[0]!.plan.callFrom,
      selectedIndex: 0,
      intentions,
    }),
  })
  return true
}

/** Apply the preselected action when Enter is pressed while the menu is open. */
export function applySelectedJavaIntention(view: EditorView): boolean {
  const menu = view.state.field(javaIntentionsState, false)
  if (!menu || menu.intentions.length === 0) return false
  const selected = menu.intentions[Math.max(0, Math.min(menu.selectedIndex, menu.intentions.length - 1))]
  return selected ? applyJavaMethodCreation(view, selected.plan) : false
}

/** Dismiss an open intentions menu without changing the document. */
export function dismissJavaIntentions(view: EditorView): boolean {
  if (!view.state.field(javaIntentionsState, false)) return false
  view.dispatch({ effects: closeJavaIntentions.of(null) })
  return true
}

/** CodeMirror wiring for the menu's Enter and Escape behavior. */
export const javaIntentionsExtension: Extension = [
  javaIntentionsState,
  javaIntentionsTheme,
  Prec.highest(keymap.of([
    { key: 'Enter', run: applySelectedJavaIntention },
    { key: 'Escape', run: dismissJavaIntentions },
  ])),
]

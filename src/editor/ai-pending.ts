import { javaLanguage } from '@codemirror/lang-java'
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { AI_TESTS_USER_EVENT, findAiCaseTestSlot } from './ai-tests'
import { findBareJavaTest, findJavaTestBlock } from './test-markers'

/** Which AI test request is waiting: a fill of `test()`, or a new method for a case. */
export type AiPendingKind = 'examples' | 'case'

/** What the inline status says about a waiting request. */
export interface AiPendingStatus {
  /** What the request does, e.g. "Generating tests". */
  title: string
  /** The step in progress. */
  label: string
  /** A detail of the step, such as the model's name. */
  detail: string | null
  /** 0-based index of the step in progress. */
  step: number
  total: number
}

/**
 * The lines a waiting request locks and where its status shows. `from` is the
 * start of the first locked line and `to` the end of the last one; `anchor`
 * is the end of the line the status sits on.
 */
export interface AiPendingRegion {
  from: number
  to: number
  anchor: number
}

interface AiPendingState extends AiPendingRegion {
  status: AiPendingStatus
}

function lineStart(source: string, position: number): number {
  return source.lastIndexOf('\n', position - 1) + 1
}

function lineEnd(source: string, position: number): number {
  const end = source.indexOf('\n', position)
  return end < 0 ? source.length : end
}

/**
 * The region a request of `kind` locks in `source`, or null when the request
 * could not apply to it.
 *
 * A fill locks the whole bare `test()` method, annotation to closing brace,
 * since editing its name or body is what would make the fill impossible. The
 * status takes the place of the body: the first line after `{`, which holds
 * `assertThat()` or nothing, or the `{` line itself when the braces share a
 * line or are on adjacent lines.
 *
 * A case goes right after the last @Test method, so that method is locked:
 * removing or renaming it is what would move the new method elsewhere. The
 * status sits at the end of its closing line, where the method will appear.
 * Without a @Test method only the line the method would follow is locked.
 */
export function aiPendingRegion(source: string, kind: AiPendingKind): AiPendingRegion | null {
  if (kind === 'case') {
    const slot = findAiCaseTestSlot(source)
    if (!slot) return null
    const to = lineEnd(source, slot.at)
    return { from: lineStart(source, slot.anchorFrom), to, anchor: to }
  }
  if (findBareJavaTest(source).status !== 'bare') return null
  const block = findJavaTestBlock(source, javaLanguage.parser.parse(source).topNode)
  const method = block?.parent
  if (!block || !method) return null
  const openLineEnd = lineEnd(source, block.from)
  const closeLineStart = lineStart(source, block.to - 1)
  return {
    from: lineStart(source, method.from),
    to: lineEnd(source, block.to - 1),
    anchor: openLineEnd + 1 < closeLineStart ? lineEnd(source, openLineEnd + 1) : openLineEnd,
  }
}

/** Show (with a region) or remove (with null) the waiting request. */
export const setAiPending = StateEffect.define<AiPendingState | null>({
  map: (value, mapping) => value && {
    ...value,
    from: mapping.mapPos(value.from, 1),
    to: mapping.mapPos(value.to, -1),
    anchor: mapping.mapPos(value.anchor, -1),
  },
})

/** Move a shown request to its next step. */
export const updateAiPendingStatus = StateEffect.define<AiPendingStatus>()

/**
 * A change touching the locked lines is refused. Whole lines may still be
 * added right before or after them, so Enter at the end of the closing brace
 * line or at the end of the line above keeps working, but nothing may join a
 * locked line or add text to it.
 */
function touchesRegion(region: AiPendingRegion, fromA: number, toA: number, inserted: string): boolean {
  const { from, to } = region
  if (fromA < to && toA > from) return true
  if (toA === from && fromA < from) return true
  if (fromA === to && toA > to) return true
  if (inserted.length === 0 || fromA !== toA) return false
  if (fromA === from && !inserted.endsWith('\n')) return true
  return fromA === to && !inserted.startsWith('\n')
}

const pendingField = StateField.define<AiPendingState | null>({
  create: () => null,
  update(value, transaction) {
    // The fill is the request's result, so it ends the wait in the same step.
    if (transaction.isUserEvent(AI_TESTS_USER_EVENT)) return null
    let next = value && transaction.docChanged
      ? {
        ...value,
        from: transaction.changes.mapPos(value.from, 1),
        to: transaction.changes.mapPos(value.to, -1),
        anchor: transaction.changes.mapPos(value.anchor, -1),
      }
      : value
    for (const effect of transaction.effects) {
      if (effect.is(setAiPending)) next = effect.value
      else if (effect.is(updateAiPendingStatus) && next) next = { ...next, status: effect.value }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field, pendingDecorations),
})

const lockFilter = EditorState.changeFilter.of((transaction: Transaction) => {
  const pending = transaction.startState.field(pendingField, false)
  if (!pending
    || transaction.isUserEvent(AI_TESTS_USER_EVENT)
    || transaction.effects.some((effect) => effect.is(setAiPending))) {
    return true
  }
  let allowed = true
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (allowed && touchesRegion(pending, fromA, toA, inserted.toString())) allowed = false
  })
  return allowed
})

const lockedLine = Decoration.line({ class: 'cm-ai-pending-line' })
const anchorLine = Decoration.line({ class: 'cm-ai-pending-line cm-ai-pending-anchor-line' })
const lockedText = Decoration.mark({ class: 'cm-ai-pending-text' })

/**
 * Locked text is dimmed. The status widget sits at the end of its line,
 * outside the dimmed text so it keeps full contrast.
 */
function pendingDecorations(pending: AiPendingState | null): DecorationSet {
  if (!pending) return Decoration.none
  const { from, to, anchor, status } = pending
  const ranges = []
  if (anchor > from) ranges.push(lockedText.range(from, anchor))
  ranges.push(Decoration.widget({ widget: new AiPendingWidget(status), side: 1 }).range(anchor))
  // `anchor` ends a line, so the rest of the locked text starts after its break.
  if (anchor + 1 < to) ranges.push(lockedText.range(anchor + 1, to))
  return Decoration.set(ranges)
}

/** Locked lines are tinted, as line decorations built from the document's lines. */
const pendingLines = EditorView.decorations.compute([pendingField], (state) => {
  const pending = state.field(pendingField)
  if (!pending) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  const first = state.doc.lineAt(pending.from).number
  const last = state.doc.lineAt(pending.to).number
  const anchor = state.doc.lineAt(pending.anchor).number
  for (let number = first; number <= last; number += 1) {
    const line = state.doc.line(number)
    builder.add(line.from, line.from, number === anchor ? anchorLine : lockedLine)
  }
  return builder.finish()
})

/**
 * The status shown in the test body's place. It is an inline box no taller
 * than a line (see `.cm-ai-pending-chip`), so showing and removing it never
 * moves the code around it.
 */
class AiPendingWidget extends WidgetType {
  constructor(readonly status: AiPendingStatus) {
    super()
  }

  eq(other: AiPendingWidget): boolean {
    const a = this.status
    const b = other.status
    return a.title === b.title && a.label === b.label && a.detail === b.detail
      && a.step === b.step && a.total === b.total
  }

  toDOM(view: EditorView): HTMLElement {
    const documentRef = view.dom.ownerDocument
    const chip = documentRef.createElement('span')
    chip.className = 'cm-ai-pending-chip'
    chip.setAttribute('role', 'status')
    chip.setAttribute('aria-live', 'polite')
    const spinner = documentRef.createElement('span')
    spinner.className = 'cm-ai-pending-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    const label = documentRef.createElement('span')
    label.className = 'cm-ai-pending-label'
    const detail = documentRef.createElement('span')
    detail.className = 'cm-ai-pending-detail'
    const steps = documentRef.createElement('span')
    steps.className = 'cm-ai-pending-steps'
    steps.setAttribute('aria-hidden', 'true')
    chip.append(spinner, label, detail, steps)
    this.render(chip)
    return chip
  }

  updateDOM(dom: HTMLElement): boolean {
    this.render(dom)
    return true
  }

  private render(chip: HTMLElement): void {
    const { title, label, detail, step, total } = this.status
    const [, labelNode, detailNode, stepsNode] = Array.from(chip.children) as HTMLElement[]
    const stepText = `Step ${step + 1} of ${total}`
    chip.setAttribute('aria-label', `${title}: ${label}${detail ? `, ${detail}` : ''}. ${stepText}`)
    chip.title = `${title} · ${stepText}`
    labelNode.textContent = label
    detailNode.textContent = detail ?? ''
    detailNode.hidden = !detail
    const documentRef = chip.ownerDocument
    while (stepsNode.children.length < total) stepsNode.append(documentRef.createElement('span'))
    while (stepsNode.children.length > total) stepsNode.lastElementChild?.remove()
    Array.from(stepsNode.children).forEach((dot, index) => {
      ;(dot as HTMLElement).dataset.state = index < step ? 'complete' : index === step ? 'current' : 'pending'
    })
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Briefly mark the lines a fill just added. */
const markAiInsertion = StateEffect.define<{ from: number; to: number }>({
  map: (value, mapping) => ({ from: mapping.mapPos(value.from, 1), to: mapping.mapPos(value.to, -1) }),
})
const clearAiInsertion = StateEffect.define<null>()
const insertedLine = Decoration.line({ class: 'cm-ai-inserted-line' })

/** The lines a fill added, for `markAiInsertion`. */
export function aiInsertionEffect(from: number, to: number): StateEffect<{ from: number; to: number }> {
  return markAiInsertion.of({ from, to })
}

const insertionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(clearAiInsertion)) next = Decoration.none
      if (!effect.is(markAiInsertion)) continue
      const { doc } = transaction.state
      const { from, to } = effect.value
      if (to <= from) continue
      const builder = new RangeSetBuilder<Decoration>()
      // The inserted text also holds line breaks and indentation of the lines
      // around it, so only lines that gained visible text are marked.
      for (let number = doc.lineAt(from).number; number <= doc.lineAt(to).number; number += 1) {
        const line = doc.line(number)
        if (doc.sliceString(Math.max(line.from, from), Math.min(line.to, to)).trim() === '') continue
        builder.add(line.from, line.from, insertedLine)
      }
      next = builder.finish()
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** How long the added lines stay marked; the fade itself is CSS. */
const INSERTION_MARK_MS = 1600

const insertionTimer = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(markAiInsertion)))) {
      return
    }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.view.dispatch({ effects: clearAiInsertion.of(null) })
    }, INSERTION_MARK_MS)
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer)
  }
})

/** The region of the waiting request, or null when none is shown. */
export function readAiPending(state: EditorState): AiPendingRegion | null {
  const pending = state.field(pendingField, false)
  return pending ? { from: pending.from, to: pending.to, anchor: pending.anchor } : null
}

/** The status of the waiting request, or null when none is shown. */
export function readAiPendingStatus(state: EditorState): AiPendingStatus | null {
  return state.field(pendingField, false)?.status ?? null
}

/** The lines highlighted after the last fill, as 1-based numbers. */
export function readAiInsertedLines(state: EditorState): number[] {
  const lines: number[] = []
  const field = state.field(insertionField, false)
  field?.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number)
  })
  return lines
}

/**
 * The effect that shows `status` for a request of `kind` in `state`'s
 * document: a new lock when none is shown, else the next step of the shown
 * one. Null when the request could not apply to the document, so nothing is
 * locked.
 */
export function aiPendingEffect(
  state: EditorState,
  kind: AiPendingKind,
  status: AiPendingStatus,
): StateEffect<unknown> | null {
  if (state.field(pendingField, false)) return updateAiPendingStatus.of(status)
  const region = aiPendingRegion(state.doc.toString(), kind)
  return region ? setAiPending.of({ ...region, status }) : null
}

export const clearAiPendingEffect = setAiPending.of(null)

/** The lock and inline status of a waiting AI test request, and the mark after a fill. */
export const aiPendingExtension: Extension = [
  pendingField,
  pendingLines,
  lockFilter,
  insertionField,
  insertionTimer,
]

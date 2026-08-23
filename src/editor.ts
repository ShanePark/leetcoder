import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { java } from '@codemirror/lang-java'
import { indentOnInput, indentUnit } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { javaCompletions } from './completions'

export interface EditorCallbacks {
  onChange?: (source: string) => void
  onSave?: () => boolean | void
  onRun?: () => boolean | void
}

/** A deliberately small CodeMirror wrapper used by the single editor pane. */
export class JavaEditor {
  readonly view: EditorView

  constructor(parent: HTMLElement, callbacks: EditorCallbacks = {}) {
    const save = () => callbacks.onSave?.() !== false
    const run = () => callbacks.onRun?.() !== false

    const state = EditorState.create({
      doc: '',
      extensions: [
        oneDark,
        java(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        closeBrackets(),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        indentOnInput(),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        Prec.high(keymap.of([
          { key: 'Mod-s', run: save },
          { key: 'Mod-r', run },
          { key: 'Ctrl-Space', run: startCompletion },
          { key: 'Cmd-Space', run: startCompletion },
        ])),
        autocompletion({
          override: [javaCompletions],
          activateOnTyping: true,
          maxRenderedOptions: 24,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.onChange?.(update.state.doc.toString())
          }
        }),
      ],
    })

    this.view = new EditorView({ state, parent })
  }

  getValue(): string {
    return this.view.state.doc.toString()
  }

  setValue(source: string): void {
    const current = this.getValue()
    if (source === current) {
      return
    }
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: source },
      selection: { anchor: 0 },
    })
  }

  focus(): void {
    this.view.focus()
  }

  /** Move the cursor to a 1-based source line and bring it into view. */
  revealLine(line: number): void {
    const target = Math.max(1, Math.min(Math.trunc(line) || 1, this.view.state.doc.lines))
    const lineInfo = this.view.state.doc.line(target)
    this.view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
    })
    this.view.focus()
  }

  destroy(): void {
    this.view.destroy()
  }
}

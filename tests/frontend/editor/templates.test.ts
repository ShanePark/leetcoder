import {
  autocompletion,
  clearSnippet,
  completionStatus,
  hasNextSnippetField,
  hasPrevSnippetField,
  startCompletion,
  CompletionContext,
} from '@codemirror/autocomplete'
import { defaultKeymap, history } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { indentUnit } from '@codemirror/language'
import { EditorState, Prec, type TransactionSpec } from '@codemirror/state'
import { keymap, runScopeHandlers, type EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

const acceptCompletionMock = vi.hoisted(() => vi.fn())
vi.mock('@codemirror/autocomplete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/autocomplete')>()
  acceptCompletionMock.mockImplementation((view: EditorView) => actual.acceptCompletion(view))
  return { ...actual, acceptCompletion: acceptCompletionMock }
})

import { expandJavaTemplateOnTab } from '../../../src/editor'
import {
  finishJavaIterTemplate,
  finishJavaTemplate,
  javaCompletions,
  javaIterTemplateExtension,
  isJavaIterVariableNameField,
} from '../../../src/completions'
import { javaIterCompletion } from '../../../src/completions/templates'
import { runEditorCommand, mutableEditorView, javaState, applyUndo } from './helpers'

describe('Java template Tab command', () => {
  it('expands test at a class declaration', () => {
    const source = `class S {
    test
}`
    const cursor = source.indexOf('test') + 'test'.length
    const state = runEditorCommand(
      EditorState.create({
        doc: source,
        extensions: [java(), indentUnit.of('    '), EditorState.allowMultipleSelections.of(true)],
        selection: { anchor: cursor },
      }),
      expandJavaTemplateOnTab,
    )

    expect(state.doc.toString()).toBe(`import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class S {
    @Test
    public void () {
        assertThat()
    }
}`)
  })

  it('leaves test unchanged inside a method body', () => {
    const source = `class S {
    void helper() {
        test
    }
}`
    const cursor = source.indexOf('test') + 'test'.length
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
    )

    expect(expandJavaTemplateOnTab(harness.view)).toBe(false)
    expect(harness.state().doc.toString()).toBe(source)
  })

  it('moves from the test name field to the assertion field on Tab', () => {
    const source = `class S {
    test
}`
    const cursor = source.indexOf('test') + 'test'.length
    const harness = mutableEditorView(EditorState.create({
      doc: source,
      extensions: [java(), indentUnit.of('    '), EditorState.allowMultipleSelections.of(true)],
      selection: { anchor: cursor },
    }))

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    const expanded = harness.state().doc.toString()
    expect(harness.state().selection.main.head).toBe(expanded.indexOf('()'))
    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().selection.main.head).toBe(expanded.indexOf('assertThat()') + 'assertThat('.length)
  })

  it('expands sout at the cursor', () => {
    const source = `class S {
    void f() {
        sout
    }
}`
    const cursor = source.indexOf('sout') + 'sout'.length
    const state = runEditorCommand(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
      expandJavaTemplateOnTab,
    )

    expect(state.doc.toString()).toBe(`class S {
    void f() {
        System.out.println();
    }
}`)
  })

  it('finishes a linked print field on Enter without mirroring a newline', () => {
    const source = `class S {
    void f(int n) {
        serrv
    }
}`
    const cursor = source.indexOf('serrv') + 'serrv'.length
    let state = EditorState.create({
      doc: source,
      extensions: [
        java(),
        keymap.of(defaultKeymap),
        Prec.high(keymap.of([{ key: 'Enter', run: finishJavaTemplate }])),
        EditorState.allowMultipleSelections.of(true),
      ],
      selection: { anchor: cursor },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    const expandedSource = state.doc.toString()
    const templateEnd = expandedSource.indexOf(';', expandedSource.indexOf('System.err.println')) + 1
    const enter = () => runScopeHandlers(view, {
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')

    expect(enter()).toBe(true)
    expect(state.doc.toString()).toBe(expandedSource)
    expect(state.selection.ranges).toHaveLength(1)
    expect(state.selection.main.head).toBe(templateEnd)
    expect(hasNextSnippetField(state) || hasPrevSnippetField(state)).toBe(false)

    // Once the linked field is finished, a later Enter creates one ordinary
    // newline at the final cursor instead of mirroring it into the print call.
    expect(enter()).toBe(true)
    expect(state.selection.ranges).toHaveLength(1)
    expect(state.doc.lines).toBe(expandedSource.split('\n').length + 1)
  })

  it('runs template finish before an active completion Enter binding', () => {
    const source = `class S {
    void f(int n) {
        serrv
    }
}`
    const cursor = source.indexOf('serrv') + 'serrv'.length
    const calls: string[] = []
    let state = EditorState.create({
      doc: source,
      extensions: [
        java(),
        EditorState.allowMultipleSelections.of(true),
        // This mirrors the production order: the template binding is
        // Prec.highest and autocompletion contributes its own highest Enter
        // binding later in the extension list.
        Prec.highest(keymap.of([{
          key: 'Enter',
          run: (view: EditorView) => {
            calls.push('template')
            return finishJavaTemplate(view)
          },
        }])),
        autocompletion({ override: [javaCompletions] }),
        // A selected completion makes CodeMirror's Enter handler return true.
        // Keep a synthetic binding here so this test remains DOM-free while
        // still proving the precedence required by the real popup path.
        Prec.highest(keymap.of([{
          key: 'Enter',
          run: () => {
            calls.push('completion')
            return true
          },
        }])),
        keymap.of(defaultKeymap),
      ],
      selection: { anchor: cursor },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    const expanded = state.doc.toString()
    expect(runScopeHandlers(view, {
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')).toBe(true)
    expect(calls).toEqual(['template'])
    expect(state.doc.toString()).toBe(expanded)
    expect(state.selection.ranges).toHaveLength(1)
  })

  it('expands mod at the cursor', () => {
    const source = `class S {
    void f() {
        mod
    }
}`
    const cursor = source.indexOf('mod') + 'mod'.length
    const state = runEditorCommand(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
      expandJavaTemplateOnTab,
    )

    expect(state.doc.toString()).toBe(`class S {
    void f() {
        final int MOD = (int) 1e9 + 7;
    }
}`)
  })

  it('expands iter with the visible collection target on Tab', () => {
    const source = `class S {
    void f(List<Integer> nums) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const state = runEditorCommand(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
      expandJavaTemplateOnTab,
    )

    expect(state.doc.toString()).toBe([
      'class S {',
      '    void f(List<Integer> nums) {',
      '        for (Integer num : nums) {',
      ' '.repeat(12),
      '        }',
      '    }',
      '}',
    ].join('\n'))
  })

  it('expands a multi-target iter immediately on Tab', () => {
    const source = `class S {
    void f(List<Integer> nums, String[] names) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const initial = EditorState.create({
      doc: source,
      extensions: [java(), autocompletion({ override: [javaCompletions] })],
      selection: { anchor: cursor },
    })
    const harness = mutableEditorView(initial)

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('for (String name : names)')
  })

  it('expands the first iter target when Tab arrives while choices are still pending', () => {
    const source = `class S {
    void f(List<Integer> nums, String[] names) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const initial = EditorState.create({
      doc: source,
      extensions: [
        java(),
        javaIterTemplateExtension,
        autocompletion({ override: [javaCompletions] }),
      ],
      selection: { anchor: cursor },
    })
    const harness = mutableEditorView(initial)

    expect(startCompletion(harness.view)).toBe(true)
    expect(completionStatus(harness.state())).toBe('pending')
    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('for (String name : names)')
  })

  it('suppresses target completions and finishes an iter variable field on Enter', () => {
    const source = `class S {
    void f(int[] digits) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const harness = mutableEditorView(EditorState.create({
      doc: source,
      extensions: [
        java(),
        javaIterTemplateExtension,
        autocompletion({ override: [javaCompletions] }),
      ],
      selection: { anchor: cursor },
    }))
    const completion = javaIterCompletion({ name: 'digits', elementType: 'int', variableName: 'item' })
    if (typeof completion.apply !== 'function') throw new Error('iter completion must expand as a snippet')
    completion.apply(harness.view, completion, cursor - 'iter'.length, cursor)

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    const variable = harness.state().selection.main
    harness.view.dispatch({
      changes: { from: variable.from, to: variable.to, insert: 'digit' },
      selection: { anchor: variable.from + 'digit'.length },
      userEvent: 'input.type',
    })
    const state = harness.state()
    expect(isJavaIterVariableNameField(state)).toBe(true)
    expect(javaCompletions(new CompletionContext(state, state.selection.main.head, false))).toBeNull()

    acceptCompletionMock.mockClear()
    expect(finishJavaTemplate(harness.view)).toBe(true)
    expect(acceptCompletionMock).not.toHaveBeenCalled()
    expect(harness.state().doc.toString()).toContain('for (int digit : digits)')
  })

  it('moves to an editable item after changing an inferred iter target and accepting completion', () => {
    const source = `class S {
    void f(boolean[] appear, int[] digits) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
    )
    const completion = javaIterCompletion({ name: 'appear', elementType: 'boolean', variableName: 'item' })

    expect(typeof completion.apply).toBe('function')
    if (typeof completion.apply !== 'function') throw new Error('iter completion must expand as a snippet')
    completion.apply(harness.view, completion, cursor - 'iter'.length, cursor)
    expect(harness.state().doc.toString()).toContain('for (boolean item : appear)')

    const target = harness.state().selection.main
    harness.view.dispatch({
      changes: { from: target.from, to: target.to, insert: 'digits' },
      selection: { anchor: target.from + 'digits'.length },
      userEvent: 'input.type',
    })
    expect(harness.state().doc.toString()).toContain('for (int item : digits)')

    acceptCompletionMock.mockImplementationOnce((view: EditorView) => {
      const targetFrom = view.state.doc.toString().indexOf('digits', view.state.doc.toString().indexOf('for ('))
      view.dispatch({
        changes: { from: targetFrom, to: targetFrom + 'digits'.length, insert: 'digits' },
        selection: { anchor: targetFrom + 'digits'.length },
        userEvent: 'input.complete',
      })
      return true
    })

    expect(finishJavaTemplate(harness.view)).toBe(true)
    const moved = harness.state()
    expect(moved.sliceDoc(moved.selection.main.from, moved.selection.main.to)).toBe('item')

    const item = moved.selection.main
    harness.view.dispatch({
      changes: { from: item.from, to: item.to, insert: 'digit' },
      selection: { anchor: item.from + 'digit'.length },
      userEvent: 'input.type',
    })
    expect(finishJavaIterTemplate(harness.view)).toBe(true)
    const finished = harness.state()
    const loopFrom = finished.doc.toString().indexOf('for (int digit : digits)')
    const bodyPosition = finished.doc.toString().indexOf('\n', loopFrom) + 1 + 12
    expect(finished.selection.main.from).toBe(bodyPosition)
    harness.view.dispatch(finished.replaceSelection('return;'))
    expect(harness.state().doc.toString()).toContain('            return;')
  })

  it('keeps iter snippet fields editable as Tab advances through them', () => {
    const source = `class S {
    void f() {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
    )

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('for (var item : items)')
    expect(harness.state().sliceDoc(harness.state().selection.main.from, harness.state().selection.main.to)).toBe('items')

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().sliceDoc(harness.state().selection.main.from, harness.state().selection.main.to)).toBe('var')
    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    expect(harness.state().sliceDoc(harness.state().selection.main.from, harness.state().selection.main.to)).toBe('item')
  })

  it('finishes iter on Enter at the body placeholder without adding a newline', () => {
    const source = `class S {
    void f(List<Integer> list) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    let state = EditorState.create({
      doc: source,
      extensions: [
        java(),
        history(),
        javaIterTemplateExtension,
        keymap.of(defaultKeymap),
        Prec.high(keymap.of([{ key: 'Enter', run: finishJavaIterTemplate }])),
      ],
      selection: { anchor: cursor },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    const expandedSource = state.doc.toString()
    const loopFrom = expandedSource.indexOf('for (')
    const bodyPosition = expandedSource.indexOf('\n', loopFrom) + 1 + 12
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('list')
    expect(hasNextSnippetField(state) || hasPrevSnippetField(state)).toBe(true)

    const enter = () => runScopeHandlers(view, {
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')

    expect(enter()).toBe(true)
    expect(state.doc.toString()).toBe(expandedSource)
    expect(state.selection.main.from).toBe(bodyPosition)
    expect(hasNextSnippetField(state) || hasPrevSnippetField(state)).toBe(false)

    // Once the template is finished, Enter is ordinary editor input again.
    expect(enter()).toBe(true)
    expect(state.doc.toString()).not.toBe(expandedSource)
    expect(state.doc.lines).toBe(expandedSource.split('\n').length + 1)
  })

  it('finishes edited iter fields and stops target-to-type updates afterward', () => {
    const source = `class S {
    void f(String s, List<Integer> list) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    let state = EditorState.create({
      doc: source,
      extensions: [
        java(),
        javaIterTemplateExtension,
        keymap.of(defaultKeymap),
        Prec.high(keymap.of([{ key: 'Enter', run: finishJavaIterTemplate }])),
      ],
      selection: { anchor: cursor },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    const target = state.selection.main
    state = state.update({
      changes: { from: target.from, to: target.to, insert: 's.toCharArray()' },
      selection: { anchor: target.from + 's.toCharArray()'.length },
      userEvent: 'input.paste',
    }).state
    expect(state.doc.toString()).toContain('for (char integer : s.toCharArray())')

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('char')
    expect(expandJavaTemplateOnTab(view)).toBe(true)
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('integer')
    state = state.update(state.replaceSelection('ch')).state

    expect(finishJavaIterTemplate(view)).toBe(true)
    const finished = state.doc.toString()
    expect(finished).toContain('for (char ch : s.toCharArray())')
    const targetFrom = finished.indexOf('s.toCharArray()')
    state = state.update({
      changes: { from: targetFrom, to: targetFrom + 's.toCharArray()'.length, insert: 'list' },
      selection: { anchor: targetFrom + 'list'.length },
      userEvent: 'input.type',
    }).state
    expect(state.doc.toString()).toContain('for (char ch : list)')
  })

  it('does not finish an iter after Escape has cancelled its snippet fields', () => {
    const source = `class S {
    void f(List<Integer> list) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    let state = EditorState.create({
      doc: source,
      extensions: [
        java(),
        javaIterTemplateExtension,
        keymap.of(defaultKeymap),
        Prec.high(keymap.of([{ key: 'Enter', run: finishJavaIterTemplate }])),
      ],
      selection: { anchor: cursor },
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (spec: TransactionSpec) => {
        state = state.update(spec).state
      },
    } as unknown as EditorView

    expect(expandJavaTemplateOnTab(view)).toBe(true)
    const bodyPosition = state.doc.toString().indexOf('\n', state.doc.toString().indexOf('for (')) + 1 + 12
    expect(clearSnippet(view)).toBe(true)
    expect(hasNextSnippetField(state) || hasPrevSnippetField(state)).toBe(false)

    const beforeEnter = state.doc.toString()
    const handled = runScopeHandlers(view, {
      key: 'Enter',
      keyCode: 13,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')

    expect(handled).toBe(true)
    expect(state.selection.main.from).not.toBe(bodyPosition)
    expect(state.doc.toString()).not.toBe(beforeEnter)
  })

  it('restores iter type linkage after undoing a target replacement', () => {
    const source = `class S {
    void f(String s, List<Integer> list) {
        iter
    }
}`
    const cursor = source.indexOf('iter') + 'iter'.length
    const initial = EditorState.create({
      doc: source,
      extensions: [java(), history(), javaIterTemplateExtension],
      selection: { anchor: cursor },
    })
    const expanded = mutableEditorView(initial)
    expect(expandJavaTemplateOnTab(expanded.view)).toBe(true)
    const afterExpansion = expanded.state()
    const target = afterExpansion.selection.main
    const replaced = afterExpansion.update({
      changes: { from: target.from, to: target.to, insert: 's.toCharArray()' },
      selection: { anchor: target.from + 's.toCharArray()'.length },
      userEvent: 'input.paste',
    }).state
    expect(replaced.doc.toString()).toContain('for (char integer : s.toCharArray())')

    const undone = applyUndo(replaced)
    expect(undone.handled).toBe(true)
    expect(undone.state.doc.toString()).toContain('for (Integer integer : list)')
    const targetAfterUndo = undone.state.selection.main
    const reapplied = undone.state.update({
      changes: { from: targetAfterUndo.from, to: targetAfterUndo.to, insert: 's.toCharArray()' },
      selection: { anchor: targetAfterUndo.from + 's.toCharArray()'.length },
      userEvent: 'input.paste',
    }).state
    expect(reapplied.doc.toString()).toContain('for (char integer : s.toCharArray())')
  })

  it('moves to the next snippet field before trying another expansion', () => {
    const source = `class S {
    void f(int[] nums) {
        soutv
    }
}`
    const cursor = source.indexOf('soutv') + 'soutv'.length
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: cursor } }).state,
    )

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    const expanded = harness.state()
    expect(expanded.doc.toString()).toContain('System.out.println("nums = " + nums);')
    expect(expanded.selection.ranges).toHaveLength(2)

    expect(expandJavaTemplateOnTab(harness.view)).toBe(true)
    const moved = harness.state()
    expect(moved.doc.toString()).toBe(expanded.doc.toString())
    expect(moved.selection.ranges).toHaveLength(1)
    expect(moved.selection.main.empty).toBe(true)
  })

  it('returns false so ordinary Tab handling can continue', () => {
    const source = `class S {
    void f() {
        value
    }
}`
    const cursor = source.indexOf('value') + 'value'.length
    const harness = mutableEditorView(
      javaState(source).update({ selection: { anchor: cursor } }).state,
    )

    expect(expandJavaTemplateOnTab(harness.view)).toBe(false)
    expect(harness.state().doc.toString()).toBe(source)
  })
})

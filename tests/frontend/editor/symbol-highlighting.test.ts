import { java } from '@codemirror/lang-java'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { javaSymbolHighlights } from '../../../src/editor/symbol-highlighting'
import { planJavaVariableRename } from '../../../src/editor/variable-rename'

function stateAt(source: string, position: number): EditorState {
  return EditorState.create({
    doc: source,
    selection: { anchor: position },
    extensions: [java(), javaSymbolHighlights, EditorState.allowMultipleSelections.of(true)],
  })
}

function marked(state: EditorState): number[] {
  const positions: number[] = []
  state.field(javaSymbolHighlights).decorations.between(0, state.doc.length, (from, to, value) => {
    expect(value.spec.class).toBe('cm-symbolHighlight')
    expect(state.doc.sliceString(from, to)).toMatch(/^[\w$]+$/)
    positions.push(from)
  })
  return positions
}

describe('Java cursor symbol highlighting', () => {
  it('leaves an empty method-name placeholder unmarked and resumes highlighting after typing', () => {
    const source = 'class A { public void () { assertThat(); } }'
    const position = source.indexOf('()')
    const state = stateAt(source, position)
    expect(marked(state)).toEqual([])
    expect(state.field(javaSymbolHighlights).ranges).toEqual([])

    const named = state.update({
      changes: { from: position, insert: 'example' },
      selection: { anchor: position + 'example'.length },
    }).state
    expect(marked(named)).toEqual([position])
  })

  it('marks the array declaration and argument from either occurrence', () => {
    const source = 'class A { void test() { int[] arr = {1, 2, 3}; targetIndices(arr, 2); } }'
    const declaration = source.indexOf('arr =')
    const argument = source.indexOf('arr,')
    for (const position of [declaration, declaration + 2, argument + 1, argument + 3]) {
      expect(marked(stateAt(source, position))).toEqual([declaration, argument])
    }
  })

  it('resolves parameter scopes and excludes fields, members, comments, strings and other methods', () => {
    const source = 'class A { int value; void f(int value) { this.value = value; obj.value = value; value.toString(); String s = "value"; /* value */ } void g(int value) { value++; } }'
    const declaration = source.indexOf('int value)') + 4
    expect(marked(stateAt(source, declaration + 2))).toEqual([
      declaration,
      source.indexOf('= value;') + 2,
      source.indexOf('= value;', source.indexOf('= value;') + 1) + 2,
      source.indexOf('value.toString'),
    ])
    for (const position of [source.indexOf('obj.value') + 6, source.indexOf('"value"') + 3, source.indexOf('/* value') + 5]) {
      expect(marked(stateAt(source, position))).toEqual([])
    }
  })

  it('links fields and this-qualified uses separately from shadowing locals', () => {
    const source = 'class A { int value; void f(int value) { this.value = value; } void g() { value++; this.value++; } }'
    const declaration = source.indexOf('int value;') + 4
    const firstThis = source.indexOf('this.value') + 5
    const unqualified = source.indexOf('value++')
    const lastThis = source.lastIndexOf('this.value') + 5
    for (const position of [declaration + 1, firstThis + 1, unqualified + 1, lastThis + 1]) {
      expect(marked(stateAt(source, position))).toEqual([declaration, firstThis, unqualified, lastThis])
    }
    const parameter = source.indexOf('int value)') + 4
    expect(marked(stateAt(source, parameter + 1))).toEqual([parameter, source.indexOf('= value') + 2])
    expect(planJavaVariableRename(source, declaration + 1)).toHaveProperty('reason')
    expect(planJavaVariableRename(source, firstThis + 1)).toHaveProperty('reason')
  })

  it('does not guess inherited fields or qualified receivers inside nested and anonymous classes', () => {
    const source = 'class A { int value; void f(A other) { value++; other.value++; Runnable r = new Base() { void run() { value++; this.value++; } }; } class B extends Base { void f() { value++; this.value++; A.this.value++; } } }'
    const declaration = source.indexOf('int value;') + 4
    const unqualified = source.indexOf('value++')
    expect(marked(stateAt(source, declaration + 1))).toEqual([declaration, unqualified])
    for (const position of [
      source.indexOf('other.value') + 7,
      source.indexOf('value++', unqualified + 1) + 1,
      source.indexOf('this.value') + 6,
      source.lastIndexOf('A.this.value') + 8,
    ]) {
      expect(marked(stateAt(source, position))).toEqual([])
    }
  })

  it('resolves a nested class own field without linking the outer field', () => {
    const source = 'class A { int value; class B { int value; void f() { value++; this.value++; } } }'
    const declaration = source.lastIndexOf('int value') + 4
    expect(marked(stateAt(source, declaration + 1))).toEqual([
      declaration, source.indexOf('value++'), source.lastIndexOf('this.value') + 5,
    ])
  })

  it('does not mistake inherited fields for captured parameters or locals', () => {
    const source = 'class Base { int value; int count; } class A { void f(int value) { int count = 0; new Base() { void g() { value++; count++; } }; value++; count++; } }'
    const parameter = source.indexOf('int value)') + 4
    const local = source.indexOf('int count =') + 4
    expect(marked(stateAt(source, parameter + 1))).toEqual([parameter, source.lastIndexOf('value++')])
    expect(marked(stateAt(source, local + 1))).toEqual([local, source.lastIndexOf('count++')])
    expect(marked(stateAt(source, source.indexOf('value++') + 1))).toEqual([])
    expect(marked(stateAt(source, source.indexOf('count++') + 1))).toEqual([])
  })

  it('keeps shadowed lambda variables separate from captured references', () => {
    const source = 'class A { void f(int value) { var capture = () -> value; var shadow = (value) -> value; value++; } }'
    const declaration = source.indexOf('int value') + 4
    expect(marked(stateAt(source, declaration + 1))).toEqual([
      declaration, source.indexOf('-> value') + 3, source.lastIndexOf('value'),
    ])
    const lambda = source.indexOf('(value)') + 1
    expect(marked(stateAt(source, lambda + 1))).toEqual([lambda, source.lastIndexOf('-> value') + 3])
  })

  it('marks only the resolvable overload and its same-file calls', () => {
    const source = 'class A { void run() {} void run(int n) {} void test() { run(); this.run(1); } }'
    const declaration = source.indexOf('run(int')
    const call = source.indexOf('run(1)')
    expect(marked(stateAt(source, call + 1))).toEqual([declaration, call])
    expect(marked(stateAt(source, declaration + 1))).toEqual([declaration, call])
    expect(marked(stateAt(source, source.indexOf('void') + 2))).toEqual([])
  })

  it('does not guess method references with ambiguous overloads or unknown receivers', () => {
    const ambiguous = 'class A { void run(int n) {} void run(String s) {} void test() { run(1); } }'
    expect(marked(stateAt(ambiguous, ambiguous.lastIndexOf('run') + 1))).toEqual([])
    const unknown = 'class A { void run() {} void test(A other) { other.run(); } }'
    expect(marked(stateAt(unknown, unknown.lastIndexOf('run') + 1))).toEqual([])
  })

  it('reuses marks within a symbol and clears them when the cursor leaves or a selection starts', () => {
    const source = 'class A { void f(int value) { value++; } }'
    let state = stateAt(source, source.indexOf('value') + 1)
    const initial = state.field(javaSymbolHighlights)
    state = state.update({ selection: { anchor: source.lastIndexOf('value') + 2 } }).state
    expect(state.field(javaSymbolHighlights)).toBe(initial)
    state = state.update({ selection: { anchor: source.indexOf('void') + 1 } }).state
    expect(marked(state)).toEqual([])
    state = state.update({ selection: { anchor: source.indexOf('value'), head: source.indexOf('value') + 5 } }).state
    expect(marked(state)).toEqual([])
    state = state.update({ selection: EditorSelection.create([
      EditorSelection.cursor(source.indexOf('value') + 1),
      EditorSelection.cursor(source.lastIndexOf('value') + 1),
    ]) }).state
    expect(marked(state)).toEqual([])
  })

  it('recomputes references after document edits instead of retaining cached ranges', () => {
    const source = 'class A { void f(int value) { value++; } }'
    let state = stateAt(source, source.indexOf('value') + 1)
    const oldHighlights = state.field(javaSymbolHighlights)
    const reference = source.lastIndexOf('value')
    state = state.update({ changes: { from: reference, to: reference + 5, insert: 'other' } }).state
    expect(state.field(javaSymbolHighlights)).not.toBe(oldHighlights)
    expect(marked(state)).toEqual([source.indexOf('value')])
    state = state.update({ changes: { from: 0, insert: '// header\n' } }).state
    expect(marked(state)).toEqual([source.indexOf('value') + '// header\n'.length])
  })
})

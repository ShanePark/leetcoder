import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { planJavaVariableRename, renameJavaSymbol } from '../../../src/editor/rename'
import { mutableEditorView } from './helpers'

function renamed(source: string, position: number): string {
  const result = planJavaVariableRename(source, position)
  expect(result).not.toHaveProperty('reason')
  if ('reason' in result) throw new Error(result.reason)
  let output = source
  for (const range of [...result.ranges].reverse()) {
    expect(source.slice(range.from, range.to)).toBe(result.name)
    output = output.slice(0, range.from) + 'renamed' + output.slice(range.to)
  }
  return output
}

describe('Java variable rename', () => {
  it('handles constructor parameters and locals', () => {
    const source = `class A { A(int value) { int local = value; value = local; } }`
    expect(renamed(source, source.indexOf('local =') + 2)).toBe(
      `class A { A(int value) { int renamed = value; value = renamed; } }`,
    )
    expect(renamed(source, source.indexOf('int value') + 5)).toBe(
      `class A { A(int renamed) { int local = renamed; renamed = local; } }`,
    )
  })

  it('links local declarations and references while excluding comments, strings and member names', () => {
    const source = `class A { void f() { int value = 1; value++; obj.value = value; value.toString(); String text = "value"; /* value */ } }`
    expect(renamed(source, source.indexOf('value =') + 2)).toBe(
      `class A { void f() { int renamed = 1; renamed++; obj.value = renamed; renamed.toString(); String text = "value"; /* value */ } }`,
    )
  })

  it('starts from a parameter reference and preserves fields and other methods', () => {
    const source = `class A { int value; int f(int value) { this.value = value; return value; } int g(int value) { return value; } }`
    expect(renamed(source, source.indexOf('return value') + 9)).toBe(
      `class A { int value; int f(int renamed) { this.value = renamed; return renamed; } int g(int value) { return value; } }`,
    )
  })

  it('keeps sibling blocks and loop body declarations in their own scopes', () => {
    const source = `class A { void f() { { int value = 1; value++; } for(int i=0;i<2;i++) { int value = i; value++; } { int value = 2; value++; } } }`
    expect(renamed(source, source.indexOf('value = i') + 2)).toBe(
      `class A { void f() { { int value = 1; value++; } for(int i=0;i<2;i++) { int renamed = i; renamed++; } { int value = 2; value++; } } }`,
    )
  })

  it('keeps an enhanced-for iterable outside the loop variable scope', () => {
    const source = `class A { void f(int[] value) { for(int value: value) { value++; } value.clone(); } }`
    expect(renamed(source, source.indexOf('value:') + 2)).toBe(
      `class A { void f(int[] value) { for(int renamed: value) { renamed++; } value.clone(); } }`,
    )
    expect(renamed(source, source.indexOf('value)') + 2)).toBe(
      `class A { void f(int[] renamed) { for(int value: renamed) { value++; } renamed.clone(); } }`,
    )
  })

  it('separates captured variables from lambda parameters and nested-class fields', () => {
    const source = `class A { void f(int value) { var capture = () -> value; var shadow = (value) -> value; Runnable r = new Runnable() { int value; public void run() { value++; } }; value++; } }`
    expect(renamed(source, source.indexOf('int value') + 5)).toBe(
      `class A { void f(int renamed) { var capture = () -> renamed; var shadow = (value) -> value; Runnable r = new Runnable() { int value; public void run() { value++; } }; renamed++; } }`,
    )
  })

  it('recognizes multiple declarations, array and dollar-sign identifiers', () => {
    const source = `class A { void f() { int first = 1, $value[] = {first}; $value[0]++; } }`
    expect(renamed(source, source.lastIndexOf('$value') + 2)).toBe(
      `class A { void f() { int first = 1, renamed[] = {first}; renamed[0]++; } }`,
    )
  })

  it('renames receiver variables without renaming members, labels or other classes', () => {
    const source = `class A { void f(A item) { item.field++; item.method(); var ref = item::method; item: while(true) { break item; } } } class B { void f(A item) { item.method(); } }`
    expect(renamed(source, source.indexOf('item)') + 2)).toBe(
      `class A { void f(A renamed) { renamed.field++; renamed.method(); var ref = renamed::method; item: while(true) { break item; } } } class B { void f(A item) { item.method(); } }`,
    )
  })

  it('limits resources to the try body and catches to their own block', () => {
    const source = `class A { void f() { try(var value = open(); var second = value.copy()) { value.close(); } catch(Exception value) { value.printStackTrace(); } } }`
    expect(renamed(source, source.indexOf('value =') + 2)).toBe(
      `class A { void f() { try(var renamed = open(); var second = renamed.copy()) { renamed.close(); } catch(Exception value) { value.printStackTrace(); } } }`,
    )
  })

  it('does not treat method names, types, literals or comments as variables', () => {
    const source = `class A { void f(int value) { value(); String text = "value"; /* value */ } }`
    for (const position of [source.indexOf('value()') + 2, source.indexOf('String') + 2, source.indexOf('"value"') + 3, source.indexOf('/* value') + 5]) {
      expect(planJavaVariableRename(source, position)).toHaveProperty('reason')
    }
  })

  it('linked selection does not change source, keeps the initiating reference primary and supports undo', () => {
    const source = `class A { int f(int value) { return value + value; } }`
    const position = source.lastIndexOf('value') + 2
    const state = EditorState.create({ doc: source, extensions: [java(), history(), EditorState.allowMultipleSelections.of(true)] })
    const harness = mutableEditorView(state.update({ selection: { anchor: position } }).state)
    expect(renameJavaSymbol(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toBe(source)
    expect(harness.state().selection.main.from).toBe(source.lastIndexOf('value'))
    expect(harness.state().selection.ranges).toHaveLength(3)
    harness.view.dispatch(harness.state().replaceSelection('renamed'))
    expect(harness.state().doc.toString()).toBe(`class A { int f(int renamed) { return renamed + renamed; } }`)
    expect(undo(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toBe(source)
  })
})

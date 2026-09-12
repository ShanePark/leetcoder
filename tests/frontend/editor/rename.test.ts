import { describe, expect, it } from 'vitest'
import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'

import {
  planJavaMethodRename,
  renameJavaMethod,
} from '../../../src/editor'
import { javaState, mutableEditorView } from './helpers'

describe('Java method rename', () => {
  it('selects the declaration and unqualified or this-qualified calls in its class', () => {
    const source = `class Solution {
    int solve(int value) {
        return helper(value) + this.helper(value);
    }
    int helper(int value) {
        return value;
    }
}`
    const declaration = source.indexOf('helper(int')
    const result = planJavaMethodRename(source, declaration + 2)

    expect(result).toEqual({
      name: 'helper',
      ranges: [
        { from: source.indexOf('helper(value)'), to: source.indexOf('helper(value)') + 'helper'.length },
        { from: source.indexOf('this.helper(value)') + 'this.'.length, to: source.indexOf('this.helper(value)') + 'this.'.length + 'helper'.length },
        { from: declaration, to: declaration + 'helper'.length },
      ].sort((left, right) => left.from - right.from),
    })
  })

  it('renames only the overload selected by an unambiguous argument count', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int helper(int value) { return value; }
    int solve() { return helper(); }
}`
    const call = source.lastIndexOf('helper()')
    const result = planJavaMethodRename(source, call + 2)

    expect(result).toEqual({
      name: 'helper',
      ranges: [
        { from: source.indexOf('helper()'), to: source.indexOf('helper()') + 'helper'.length },
        { from: call, to: call + 'helper'.length },
      ],
    })
  })

  it('rejects ambiguous overload calls instead of partially renaming them', () => {
    const source = `class Solution {
    int helper(int value) { return value; }
    int helper(String value) { return value.length(); }
    int solve() { return helper(value); }
}`
    const call = source.lastIndexOf('helper(value)')
    const result = planJavaMethodRename(source, call + 2)

    expect(result).toEqual({
      reason: 'The method call is ambiguous; rename was cancelled.',
    })
  })

  it('ignores comments and other classes, and rejects unknown receivers', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() {
        String text = "helper()";
        // helper()
        return helper() + this.helper() + other.helper();
    }
}
class Other {
    int helper() { return 2; }
    int use() { return helper(); }
}`
    const declaration = source.indexOf('helper()')
    const result = planJavaMethodRename(source, declaration + 2)

    expect(result).toEqual({
      reason: 'Could not resolve every method call safely.',
    })
    expect(planJavaMethodRename(source, source.indexOf('other.helper') + 'other.'.length + 2))
      .toEqual({ reason: 'Could not resolve every method call safely.' })
  })

  it('publishes the complete syntax tree before resolving calls after the initial viewport', () => {
    const filler = Array.from({ length: 220 }, (_, index) => `    int filler${index}() { return ${index}; }`).join('\n')
    const source = `class Solution {
    int helper() { return 1; }
${filler}
    int solve() { return helper(); }
}`
    const declaration = source.indexOf('helper()')
    const call = source.lastIndexOf('helper()')

    expect(source.length).toBeGreaterThan(3000)
    expect(planJavaMethodRename(source, declaration + 2)).toEqual({
      name: 'helper',
      ranges: [
        { from: declaration, to: declaration + 'helper'.length },
        { from: call, to: call + 'helper'.length },
      ],
    })
  })

  it('turns a successful rename into linked editor selections', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() { return helper(); }
}`
    const call = source.lastIndexOf('helper()')
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: call + 2 } }).state,
    )

    expect(renameJavaMethod(harness.view)).toBe(true)
    expect(harness.state().selection.ranges.map((range) => harness.state().sliceDoc(range.from, range.to)))
      .toEqual(['helper', 'helper'])
  })

  it('keeps the invocation as the main linked selection', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() { return helper(); }
}`
    const call = source.lastIndexOf('helper()')
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: call + 2 } }).state,
    )

    renameJavaMethod(harness.view)

    expect(harness.state().selection.main.from).toBe(call)
    expect(harness.state().selection.main.to).toBe(call + 'helper'.length)
  })

  it('renames dollar-sign method identifiers and method references', () => {
    const source = `class Solution {
    static int $helper() { return 1; }
    int solve() { return $helper() + Solution.$helper() + new Solution().$helper(); }
    java.util.function.IntSupplier ref() { return this::$helper; }
}`
    const declaration = source.indexOf('$helper()')
    const result = planJavaMethodRename(source, declaration + 2)

    expect(result).toEqual({
      name: '$helper',
      ranges: [
        { from: source.indexOf('$helper()'), to: source.indexOf('$helper()') + '$helper'.length },
        { from: source.indexOf('Solution.$helper') + 'Solution.'.length, to: source.indexOf('Solution.$helper') + 'Solution.'.length + '$helper'.length },
        { from: source.indexOf('new Solution().$helper') + 'new Solution().'.length, to: source.indexOf('new Solution().$helper') + 'new Solution().'.length + '$helper'.length },
        { from: source.indexOf('return $helper') + 'return '.length, to: source.indexOf('return $helper') + 'return '.length + '$helper'.length },
        { from: source.indexOf('this::$helper') + 'this::'.length, to: source.indexOf('this::$helper') + 'this::'.length + '$helper'.length },
      ].sort((left, right) => left.from - right.from),
    })
  })

  it('keeps anonymous-class methods separate from the enclosing class', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() {
        Runnable task = new Runnable() {
            public void helper() { }
            public void run() { helper(); }
        };
        return helper();
    }
}`
    const declaration = source.indexOf('int helper')
    const result = planJavaMethodRename(source, declaration + 4)

    expect(result).toEqual({
      name: 'helper',
      ranges: [
        { from: source.indexOf('int helper') + 'int '.length, to: source.indexOf('int helper') + 'int '.length + 'helper'.length },
        { from: source.lastIndexOf('return helper') + 'return '.length, to: source.lastIndexOf('return helper') + 'return '.length + 'helper'.length },
      ],
    })
  })

  it('rejects a nested unqualified call that could refer to the outer method', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() {
        Runnable task = new Runnable() {
            public void run() { helper(); }
        };
        return helper();
    }
}`
    const declaration = source.indexOf('int helper') + 'int '.length

    expect(planJavaMethodRename(source, declaration + 2)).toEqual({
      reason: 'Could not resolve every method call safely.',
    })
  })

  it('updates a known static call from a sibling class', () => {
    const source = `class Solution {
    static int helper() { return 1; }
}
class Other {
    int solve() { return Solution.helper(); }
}`
    const declaration = source.indexOf('helper()')
    const result = planJavaMethodRename(source, declaration + 2)

    expect(result).toEqual({
      name: 'helper',
      ranges: [
        { from: declaration, to: declaration + 'helper'.length },
        { from: source.lastIndexOf('Solution.helper') + 'Solution.'.length, to: source.lastIndexOf('Solution.helper') + 'Solution.'.length + 'helper'.length },
      ],
    })
  })

  it('rejects an unresolved receiver in another class instead of partially renaming', () => {
    const source = `class Solution {
    static int helper() { return 1; }
}
class Other {
    int solve() { return object.helper(); }
}`
    const declaration = source.indexOf('helper()')

    expect(planJavaMethodRename(source, declaration + 2)).toEqual({
      reason: 'Could not resolve every method call safely.',
    })
  })

  it('uses syntax-tree argument boundaries for varargs, generics, and comparisons', () => {
    const source = `class Solution {
    static int helper(int... values) { return values.length; }
    int solve() {
        return helper(foo(1, 2), new java.util.ArrayList<String>(), left < right ? left : right);
    }
}`
    const declaration = source.indexOf('helper(int')
    const result = planJavaMethodRename(source, declaration + 2)

    expect(result).toEqual({
      name: 'helper',
      ranges: [
        { from: source.indexOf('helper(int'), to: source.indexOf('helper(int') + 'helper'.length },
        { from: source.indexOf('return helper') + 'return '.length, to: source.indexOf('return helper') + 'return '.length + 'helper'.length },
      ],
    })
  })

  it('refuses a declaration rename when an overload call has the same arity', () => {
    const source = `class Solution {
    int helper(int value) { return value; }
    int helper(String value) { return value.length(); }
    int solve() { return helper(value); }
}`
    const declaration = source.indexOf('helper(int')

    expect(planJavaMethodRename(source, declaration + 2)).toEqual({
      reason: 'The method call is ambiguous; rename was cancelled.',
    })
  })

  it('replaces linked selections as one edit and lets undo restore the source', () => {
    const source = `class Solution {
    int helper() { return 1; }
    int solve() { return helper(); }
}`
    const call = source.lastIndexOf('helper()')
    const initial = EditorState.create({
      doc: source,
      extensions: [java(), history(), EditorState.allowMultipleSelections.of(true)],
    })
    const harness = mutableEditorView(initial.update({ selection: { anchor: call + 2 } }).state)

    renameJavaMethod(harness.view)
    const replacement = harness.state().replaceSelection('renamed')
    harness.view.dispatch(replacement)

    expect(harness.state().doc.toString()).toContain('renamed()')
    expect(harness.state().doc.toString()).not.toContain('helper()')
    expect(undo(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toBe(source)
  })
})

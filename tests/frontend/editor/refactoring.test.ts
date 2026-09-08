import { describe, expect, it } from 'vitest'
import {
  extractJavaMethod,
  introduceJavaVariable,
  isIntroduceVariableShortcut,
  planJavaVariableInsertion,
} from '../../../src/editor'
import { runEditorCommand, mutableEditorView, javaState } from './helpers'

describe('Introduce Variable', () => {
  it('inserts a var declaration before the containing line and selects its name', () => {
    const source = 'class S {\n    void f() {\n        return compute();\n    }\n}'
    const from = source.indexOf('compute()')
    const to = from + 'compute()'.length
    const plan = planJavaVariableInsertion(source, from, to)

    expect(plan?.name).toBe('compute')
    expect(plan?.insert).toBe('        var compute = compute();\n')

    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: from, head: to } }).state,
      introduceJavaVariable,
    )
    expect(state.doc.toString()).toBe(
      'class S {\n    void f() {\n        var compute = compute();\n        return compute;\n    }\n}',
    )
    const declarationName = state.doc.toString().indexOf('var compute') + 4
    expect(state.selection.main.from).toBe(declarationName)
    expect(state.selection.main.to).toBe(declarationName + 'compute'.length)
  })

  it('keeps indentation when the selection starts at the first code character', () => {
    const source = 'class S {\n    void f() {\n        compute();\n    }\n}'
    const selected = 'compute()'
    const from = source.indexOf(selected)
    const to = from + selected.length
    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: from, head: to } }).state,
      introduceJavaVariable,
    )
    const expected = 'class S {\n    void f() {\n        var compute = compute();\n    }\n}'

    expect(state.doc.toString()).toBe(expected)
    const declarationName = expected.indexOf('var compute') + 4
    expect(state.selection.main.from).toBe(declarationName)
    expect(state.selection.main.to).toBe(declarationName + 'compute'.length)
  })

  it('introduces one variable for an array expression selected with or without its semicolon', () => {
    const expression = 'nums[nums.length - 1]'
    const source = `class S {\n    void f(int[] nums) {\n        ${expression};\n    }\n}`
    const expected = `class S {\n    void f(int[] nums) {\n        var value = ${expression};\n    }\n}`

    for (const suffix of ['', ';']) {
      const from = source.indexOf(expression)
      const to = from + expression.length + suffix.length
      const state = runEditorCommand(
        javaState(source).update({ selection: { anchor: from, head: to } }).state,
        introduceJavaVariable,
      )

      expect(state.doc.toString()).toBe(expected)
      expect(state.doc.toString().match(/var value =/g)).toHaveLength(1)
      expect(state.doc.toString()).not.toContain('\n        value;')
    }
  })

  it('keeps declaration and replacement linked for multiple-selection renaming', () => {
    const source = 'class S {\n    void f() {\n        return compute();\n    }\n}'
    const from = source.indexOf('compute()')
    const to = from + 'compute()'.length
    const state = runEditorCommand(
      javaState(source, true).update({ selection: { anchor: from, head: to } }).state,
      introduceJavaVariable,
    )

    expect(state.selection.ranges).toHaveLength(2)
    expect(state.selection.ranges.map((range) => state.sliceDoc(range.from, range.to)))
      .toEqual(['compute', 'compute'])

    const renamed = state.update({
      changes: state.selection.ranges.map((range) => ({ from: range.from, to: range.to, insert: 'result' })),
    }).state
    expect(renamed.doc.toString()).toBe(
      'class S {\n    void f() {\n        var result = compute();\n        return result;\n    }\n}',
    )
  })

  it('uses a value fallback and avoids an existing name', () => {
    const source = 'class S {\n    void f() {\n        int value = 0;\n        return left + right;\n    }\n}'
    const from = source.indexOf('left + right')
    const to = from + 'left + right'.length
    expect(planJavaVariableInsertion(source, from, to)?.name).toBe('value2')
  })

  it('introduces a variable for nested arguments and array initializers', () => {
    const source = [
      'import static org.assertj.core.api.Assertions.assertThat;',
      'class S {',
      '    void f() {',
      '        assertThat(uniformArray(new int[]{2, 3})).isTrue();',
      '    }',
      '}',
    ].join('\n')
    const selected = 'uniformArray(new int[]{2, 3})'
    const from = source.indexOf(selected)
    const to = from + selected.length
    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: from, head: to } }).state,
      introduceJavaVariable,
    )
    const expected = [
      'import static org.assertj.core.api.Assertions.assertThat;',
      'class S {',
      '    void f() {',
      '        var uniformArray = uniformArray(new int[]{2, 3});',
      '        assertThat(uniformArray).isTrue();',
      '    }',
      '}',
    ].join('\n')

    expect(state.doc.toString()).toBe(expected)
    const declarationName = expected.indexOf('var uniformArray') + 4
    expect(state.selection.main.from).toBe(declarationName)
    expect(state.selection.main.to).toBe(declarationName + 'uniformArray'.length)
  })

  it('rejects empty, multiline, and non-expression selections', () => {
    const source = 'class S {\n    void f() {\n        return compute();\n    }\n}'
    const expression = source.indexOf('compute()')
    expect(planJavaVariableInsertion(source, expression, expression)).toBeNull()
    expect(planJavaVariableInsertion(source, expression, source.indexOf('}', expression))).toBeNull()
    const declarationName = source.indexOf('f()')
    expect(planJavaVariableInsertion(source, declarationName, declarationName + 1)).toBeNull()

    const bareIdentifier = 'class S {\n    void f() {\n        return foo;\n    }\n}'
    const bareFrom = bareIdentifier.indexOf('foo')
    expect(planJavaVariableInsertion(bareIdentifier, bareFrom, bareFrom + 'foo'.length)).toBeNull()
  })

  it('matches only Ctrl/Command+Option+V', () => {
    const base = { code: 'KeyV', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false }
    expect(isIntroduceVariableShortcut({ ...base, ctrlKey: true })).toBe(true)
    expect(isIntroduceVariableShortcut({ ...base, metaKey: true })).toBe(true)
    expect(isIntroduceVariableShortcut(base)).toBe(false)
    expect(isIntroduceVariableShortcut({ ...base, ctrlKey: true, metaKey: true })).toBe(false)
    expect(isIntroduceVariableShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isIntroduceVariableShortcut({ ...base, ctrlKey: true, code: 'KeyC' })).toBe(false)
  })
})

describe('Extract Method command', () => {
  it('extracts a selected array expression and reports no error', () => {
    const source = `class S {
    int f(int[] nums) {
        return nums[nums.length - 1];
    }
}`
    const expression = 'nums[nums.length - 1]'
    const from = source.indexOf(expression)
    const to = from + expression.length
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: from, head: to } }).state,
    )
    const errors: string[] = []

    expect(extractJavaMethod(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([])
    expect(harness.state().doc.toString()).toBe(`class S {
    int f(int[] nums) {
        return extractedMethod(nums);
    }
    private int extractedMethod(int[] nums) {
        return nums[nums.length - 1];
    }
}`)
    expect(harness.state().selection.ranges).toHaveLength(2)
  })

  it('reports an invalid no-cursor selection without changing the document', () => {
    const source = 'class S {\n    void f() { }\n}'
    const harness = mutableEditorView(
      javaState(source, true).update({ selection: { anchor: source.indexOf('{', source.indexOf('f')) + 1 } }).state,
    )
    const errors: string[] = []

    expect(extractJavaMethod(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual(['Select an expression or complete statements to extract a method.'])
    expect(harness.state().doc.toString()).toBe(source)
  })
})

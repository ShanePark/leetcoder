import { history } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  extractJavaMethod,
  inlineJavaField,
  introduceJavaVariable,
  isIntroduceVariableShortcut,
  planJavaVariableInsertion,
} from '../../../src/editor'
import { runEditorCommand, mutableEditorView, javaState, applyUndo } from './helpers'

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

  it('infers a call at the caret after its closing parenthesis or semicolon', () => {
    const expression = 'Math.max(0, 1)'
    const source = `class S {
    void f() {
        ${expression};${' '.repeat(3)}
    }
}`
    const expressionFrom = source.indexOf(expression)
    const positions = [
      expressionFrom + expression.length,
      expressionFrom + expression.length + 1,
      expressionFrom + expression.length + 4,
    ]

    for (const position of positions) {
      const state = runEditorCommand(
        javaState(source).update({ selection: { anchor: position } }).state,
        introduceJavaVariable,
      )
      expect(state.doc.toString()).toBe(`class S {
    void f() {
        var max = ${expression};
    }
}`)
    }
  })

  it('keeps an enclosing call together when the caret follows it', () => {
    const expression = 'consume(Math.max(0, 1))'
    const source = `class S {
    void f() {
        ${expression};
    }
}`
    const position = source.indexOf(expression) + expression.length
    const state = runEditorCommand(
      javaState(source).update({ selection: { anchor: position } }).state,
      introduceJavaVariable,
    )

    expect(state.doc.toString()).toBe(`class S {
    void f() {
        var consume = ${expression};
    }
}`)
  })

  it('does nothing for a caret inside a comment or unsupported bare expression', () => {
    const commented = 'class S { void f() { // Math.max(0, 1);\n } }'
    const commentPosition = commented.indexOf('Math.max') + 3
    const commentHarness = mutableEditorView(
      javaState(commented).update({ selection: { anchor: commentPosition } }).state,
    )
    expect(introduceJavaVariable(commentHarness.view)).toBe(false)
    expect(commentHarness.state().doc.toString()).toBe(commented)

    const stringSource = 'class S { void f() { String text = "Math.max(0, 1);"; } }'
    const stringPosition = stringSource.indexOf('Math.max') + 3
    const stringHarness = mutableEditorView(
      javaState(stringSource).update({ selection: { anchor: stringPosition } }).state,
    )
    expect(introduceJavaVariable(stringHarness.view)).toBe(false)
    expect(stringHarness.state().doc.toString()).toBe(stringSource)

    const bare = 'class S { void f() { value; } }'
    const barePosition = bare.indexOf('value') + 'value'.length
    const bareHarness = mutableEditorView(
      javaState(bare).update({ selection: { anchor: barePosition } }).state,
    )
    expect(introduceJavaVariable(bareHarness.view)).toBe(false)
    expect(bareHarness.state().doc.toString()).toBe(bare)

    const empty = 'class S { void f() { ; } }'
    const emptyHarness = mutableEditorView(
      javaState(empty).update({ selection: { anchor: empty.indexOf(';') + 1 } }).state,
    )
    expect(extractJavaMethod(emptyHarness.view)).toBe(true)
    expect(emptyHarness.state().doc.toString()).toBe(empty)
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

  it('infers a complete expression statement at the caret after `)` or `;`', () => {
    const expression = 'Math.max(0, 1)'
    const source = `class S {
    void f() {
        ${expression};${' '.repeat(3)}
    }
}`
    const expressionFrom = source.indexOf(expression)
    const positions = [
      expressionFrom + expression.length,
      expressionFrom + expression.length + 1,
      expressionFrom + expression.length + 4,
    ]

    for (const position of positions) {
      const harness = mutableEditorView(
        javaState(source).update({ selection: { anchor: position } }).state,
      )
      const errors: string[] = []

      expect(extractJavaMethod(harness.view, (message) => errors.push(message))).toBe(true)
      expect(errors).toEqual([])
      expect(harness.state().doc.toString()).toContain('extractedMethod();')
      expect(harness.state().doc.toString()).toContain('private int extractedMethod()')
    }
  })

  it('uses the expression inside a return statement when the caret follows the call', () => {
    const expression = 'compute(1)'
    const source = `class S {
    int compute(int value) { return value + 1; }
    int f() {
        return ${expression};
    }
}`
    const position = source.indexOf(expression) + expression.length + 1
    const harness = mutableEditorView(
      javaState(source).update({ selection: { anchor: position } }).state,
    )

    expect(extractJavaMethod(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('return extractedMethod();')
    expect(harness.state().doc.toString()).toContain('private int extractedMethod()')
  })

  it('falls back to the complete statement when an enclosing call has no known return type', () => {
    const expression = 'consume(Math.max(0, 1))'
    const source = `class S {
    void f() {
        ${expression};
    }
}`
    const position = source.indexOf(expression) + expression.length
    const harness = mutableEditorView(
      javaState(source).update({ selection: { anchor: position } }).state,
    )

    expect(extractJavaMethod(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('extractedMethod();')
    expect(harness.state().doc.toString()).toContain('private void extractedMethod()')
    expect(harness.state().doc.toString()).toContain(expression)
  })

  it('does nothing for a caret inside a string or comment', () => {
    const source = 'class S { void f() { String text = "Math.max(0, 1);"; } }'
    const position = source.indexOf('Math.max') + 3
    const harness = mutableEditorView(
      javaState(source).update({ selection: { anchor: position } }).state,
    )
    const errors: string[] = []

    expect(extractJavaMethod(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual(['Select an expression or complete statements to extract a method.'])
    expect(harness.state().doc.toString()).toBe(source)
  })
})

describe('Inline Field command', () => {
  const source = `class S {
    private static final int MOD = 7;
    int f(int value) { return value % MOD + MOD; }
}`

  it('inlines every usage and removes the field in one undoable transaction', () => {
    const position = source.lastIndexOf('MOD')
    const initial = EditorState.create({
      doc: source,
      selection: { anchor: position },
      extensions: [java(), history()],
    })
    const harness = mutableEditorView(initial)
    const errors: string[] = []

    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([])
    const updated = harness.state()
    expect(updated.doc.toString()).not.toContain('MOD')
    expect(updated.doc.toString()).not.toContain('private static final')
    expect(updated.doc.toString()).toContain('return value % (7) + (7);')
    expect(updated.selection.main.head).toBe(updated.doc.toString().lastIndexOf('(7)'))
    const undone = applyUndo(updated)
    expect(undone.handled).toBe(true)
    expect(undone.state.doc.toString()).toBe(source)
    expect(undone.state.selection.main.head).toBe(position)
    expect(applyUndo(undone.state).handled).toBe(false)
  })

  it('accepts an exact field-name selection at its declaration', () => {
    const position = source.indexOf('MOD')
    const harness = mutableEditorView(javaState(source).update({
      selection: { anchor: position, head: position + 3 },
    }).state)
    const errors: string[] = []
    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([])
    expect(harness.state().doc.toString()).not.toContain('MOD')
    expect(harness.state().selection.main.empty).toBe(true)
  })

  it('reports a planner failure without changing the document', () => {
    const harness = mutableEditorView(javaState(source).update({
      selection: { anchor: source.indexOf('value') },
    }).state)
    const errors: string[] = []
    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeTruthy()
    expect(harness.state().doc.toString()).toBe(source)
  })

  it('rejects multiple selections and preserves read-only documents', () => {
    const position = source.indexOf('MOD')
    const multiple = mutableEditorView(javaState(source, true).update({
      selection: EditorSelection.create([EditorSelection.cursor(position), EditorSelection.cursor(source.lastIndexOf('MOD'))]),
    }).state)
    const errors: string[] = []
    expect(inlineJavaField(multiple.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual(['Select one field or local variable to inline.'])
    expect(multiple.state().doc.toString()).toBe(source)

    const readOnly = mutableEditorView(EditorState.create({
      doc: source,
      selection: { anchor: position },
      extensions: [java(), EditorState.readOnly.of(true)],
    }))
    expect(inlineJavaField(readOnly.view, (message) => errors.push(message))).toBe(true)
    expect(readOnly.state().doc.toString()).toBe(source)
    expect(errors).toHaveLength(1)
  })
})

describe('Inline local variable command', () => {
  it.each(['1_000_000_007', '(int) 1e9 + 7'])('inlines local MOD = %s and all usages with one undo', (initializer) => {
    const source = `class S {
    long maxSum(int[] nums) {
        final int MOD = ${initializer};
        long res = 0;
        for (int value : nums) {
            res = (res + value) % MOD;
        }
        return res % MOD;
    }
}`
    for (const position of [source.indexOf('MOD'), source.lastIndexOf('MOD')]) {
      const initial = EditorState.create({
        doc: source,
        selection: { anchor: position },
        extensions: [java(), history()],
      })
      const harness = mutableEditorView(initial)
      const errors: string[] = []

      expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
      expect(errors).toEqual([])
      const updated = harness.state()
      expect(updated.doc.toString()).not.toContain('MOD')
      expect(updated.doc.toString()).not.toContain('final int')
      expect(updated.doc.toString()).toContain(`res = (res + value) % (${initializer});`)
      expect(updated.doc.toString()).toContain(`return res % (${initializer});`)
      const undone = applyUndo(updated)
      expect(undone.handled).toBe(true)
      expect(undone.state.doc.toString()).toBe(source)
      expect(undone.state.selection.main.head).toBe(position)
      expect(applyUndo(undone.state).handled).toBe(false)
    }
  })
})

describe('Inline local variable with a stable field dependency', () => {
  it('inlines every a read while retaining MOD and supports one undo', () => {
    const source = `class S {
    final int MOD=(int)1e9+7;
    int maxSum() {
        int a = MOD + 1;
        int b=a+MOD-1;
        return a;
    }
}`
    for (const position of [source.indexOf('a ='), source.lastIndexOf('a;')]) {
      const harness = mutableEditorView(EditorState.create({
        doc: source,
        selection: { anchor: position },
        extensions: [java(), history()],
      }))
      const errors: string[] = []

      expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
      expect(errors).toEqual([])
      const updated = harness.state()
      expect(updated.doc.toString()).not.toMatch(/\ba\b/)
      expect(updated.doc.toString()).toContain('final int MOD=(int)1e9+7;')
      expect(updated.doc.toString()).toContain('int b=(MOD + 1)+MOD-1;')
      expect(updated.doc.toString()).toContain('return (MOD + 1);')
      expect(updated.doc.toString()).not.toContain('((int) (MOD + 1))')
      const undone = applyUndo(updated)
      expect(undone.handled).toBe(true)
      expect(undone.state.doc.toString()).toBe(source)
      expect(undone.state.selection.main.head).toBe(position)
      expect(applyUndo(undone.state).handled).toBe(false)
    }
  })
})

describe('Inline command with incomplete Java source', () => {
  it('inlines a valid local despite an unrelated incomplete method and preserves undo', () => {
    const malformed = '    void unfinished() { int broken = ; }'
    const source = `class S {
    int f() {
        int a = 7;
        int b = a + 1;
        return a;
    }
${malformed}
}`
    const position = source.indexOf('a =')
    const harness = mutableEditorView(EditorState.create({
      doc: source,
      selection: { anchor: position },
      extensions: [java(), history()],
    }))
    const errors: string[] = []

    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([])
    const updated = harness.state()
    expect(updated.doc.toString()).not.toMatch(/\ba\b/)
    expect(updated.doc.toString()).toContain('int b = (7) + 1;')
    expect(updated.doc.toString()).toContain('return (7);')
    expect(updated.doc.toString().slice(updated.doc.toString().indexOf(malformed))).toBe(`${malformed}\n}`)
    const undone = applyUndo(updated)
    expect(undone.handled).toBe(true)
    expect(undone.state.doc.toString()).toBe(source)
    expect(undone.state.selection.main.head).toBe(position)
    expect(applyUndo(undone.state).handled).toBe(false)
  })

  it('inlines a recognized usage while its surrounding expression is incomplete', () => {
    const source = 'class S { int f() { int a = 7; int b = a + 1; return a + ; } }'
    const harness = mutableEditorView(EditorState.create({
      doc: source,
      selection: { anchor: source.lastIndexOf('a +') },
      extensions: [java(), history()],
    }))
    const errors: string[] = []

    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([])
    expect(harness.state().doc.toString()).not.toMatch(/\ba\b/)
    expect(harness.state().doc.toString()).toContain('int b = (7) + 1; return (7) + ;')
    expect(applyUndo(harness.state()).state.doc.toString()).toBe(source)
  })

  it.each([
    'class S { int f() { int a = 7 + ; return a; } }',
    'class S { int f() { int a 7; return a; } }',
  ])('refuses a malformed declaration or initializer without partially editing: %s', (source) => {
    const position = source.indexOf('int a') + 4
    const initial = EditorState.create({
      doc: source,
      selection: { anchor: position },
      extensions: [java(), history()],
    })
    const harness = mutableEditorView(initial)
    const errors: string[] = []

    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeTruthy()
    expect(harness.state()).toBe(initial)
    expect(harness.state().doc.toString()).toBe(source)
    expect(applyUndo(harness.state()).handled).toBe(false)
  })
})

describe('Inline command with never-written primitive local dependencies', () => {
  it.each([
    { name: 'a', returned: '-1' },
    { name: 'b', returned: 'b' },
  ])('inlines $name with return $returned while keeping unrelated incomplete code', ({ name, returned }) => {
    const malformed = '    void test(){assertThat()}'
    const source = `class S {
    long maxSum() {
        long MOD=1;
        long a=MOD<<40;
        long b=a<<40;
        return ${returned};
    }
${malformed}
}`
    const positions = [source.indexOf(`long ${name}=`) + 5]
    if (name === 'a') positions.push(source.indexOf('a<<40'))
    if (returned === 'b') positions.push(source.indexOf('return b') + 7)
    for (const position of positions) {
      const harness = mutableEditorView(EditorState.create({
        doc: source,
        selection: { anchor: position },
        extensions: [java(), history()],
      }))
      const errors: string[] = []

      expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
      expect(errors).toEqual([])
      const updated = harness.state()
      expect(updated.doc.toString()).not.toMatch(new RegExp(`\\b${name}\\b`))
      expect(updated.doc.toString()).toContain('long MOD=1;')
      if (name === 'a') {
        expect(updated.doc.toString()).toContain('long b=(MOD<<40)<<40;')
      } else {
        expect(updated.doc.toString()).toContain('long a=MOD<<40;')
        expect(updated.doc.toString()).toContain('return (a<<40);')
      }
      expect(updated.doc.toString()).not.toContain('((long)')
      expect(updated.doc.toString().slice(updated.doc.toString().indexOf(malformed))).toBe(`${malformed}\n}`)
      const undone = applyUndo(updated)
      expect(undone.handled).toBe(true)
      expect(undone.state.doc.toString()).toBe(source)
      expect(undone.state.selection.main.head).toBe(position)
      expect(applyUndo(undone.state).handled).toBe(false)
    }
  })
})

describe('Inline command with unused targets', () => {
  it.each([
    {
      source: `class S {
    long maxSum() {
        long MOD=1;
        long a=MOD<<40;
        long b=a<<40;
        return -1;
    }
    void test(){assertThat()}
}`,
      name: 'b',
      reason: 'Variable b is never used.',
    },
    {
      source: 'class S { final int UNUSED = 7; int f() { return 1; } }',
      name: 'UNUSED',
      reason: 'Field UNUSED is never used.',
    },
  ])('keeps unused $name and reports its lack of usages without an undo entry', ({ source, name, reason }) => {
    const position = source.indexOf(name)
    const initial = EditorState.create({
      doc: source,
      selection: { anchor: position, head: position + name.length },
      extensions: [java(), history()],
    })
    const harness = mutableEditorView(initial)
    const errors: string[] = []

    expect(inlineJavaField(harness.view, (message) => errors.push(message))).toBe(true)
    expect(errors).toEqual([reason])
    expect(harness.state()).toBe(initial)
    expect(harness.state().doc.toString()).toBe(source)
    expect(harness.state().selection.main.from).toBe(position)
    expect(harness.state().selection.main.to).toBe(position + name.length)
    expect(applyUndo(harness.state()).handled).toBe(false)
  })
})

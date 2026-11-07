import { completionStatus } from '@codemirror/autocomplete'
import { history } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { syntaxTree } from '@codemirror/language'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { psLibraryExtension, setPsLibraryMetadata } from '../../../src/completions/library'
import { renderJavaProblemSource } from '../../../src/domain/template'
import { JavaEditor, javaAutoImports } from '../../../src/editor'
import {
  applyAiTestStatements,
  checkAiTestCandidate,
  formatAiTestBody,
  listJavaMethodHeaders,
  MAX_AI_TEST_STATEMENT_LENGTH,
  MAX_AI_TEST_STATEMENTS,
  planAiTestInsertion,
  validateAiTestStatements,
} from '../../../src/editor/ai-tests'
import { findBareJavaTest } from '../../../src/editor/test-markers'
import { removeUnusedJavaTypeImports } from '../../../src/java-format'
import { applyUndo, javaState, mutableEditorView } from './helpers'

// JavaEditor is exercised through its real extensions without browser layout.
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof import('@codemirror/view')>()
  class StateOnlyEditorView {
    state: EditorState
    constructor(options: { state: EditorState }) { this.state = options.state }
    dispatch = (spec: TransactionSpec) => { this.state = this.state.update(spec).state }
  }
  Object.setPrototypeOf(StateOnlyEditorView, original.EditorView)
  return { ...original, EditorView: StateOnlyEditorView }
})

const TEMPLATE = renderJavaProblemSource('example', 'Q1Example', 'public int minMoves(int[] nums) {')
const ASSERTION = 'assertThat(minMoves(new int[]{2, 1, 3})).isEqualTo(3);'
const PS_METADATA = {
  fingerprint: 'fixture',
  methods: [{ name: 'intArray', returnType: 'int[][]', parameters: [] }],
}

function createEditor(source: string): JavaEditor {
  const editor = new JavaEditor({ ownerDocument: { body: {} } } as HTMLElement)
  editor.setValue(source)
  return editor
}

function undoIn(editor: JavaEditor): void {
  const undone = applyUndo(editor.view.state)
  expect(undone.handled).toBe(true)
  ;(editor.view as unknown as { state: EditorState }).state = undone.state
}

function rejection(source: string, statements: string[]): string | null {
  const plan = planAiTestInsertion(source, statements)
  return plan.ok ? null : plan.reason
}

describe('AI test statement validation', () => {
  it.each([
    ['a value assertion', ASSERTION],
    ['a boolean assertion', 'assertThat(isOk("a")).isTrue();'],
    ['a 2D helper', 'assertThat(f(Ps.intArray("[[1,2]]"))).isDeepEqualTo(Ps.intArray("[[1,2]]"));'],
    ['a local for a void method', 'int[] arr1 = new int[]{1};'],
    ['a void call', 'rotate(arr1, 2);'],
    ['a qualified within', 'assertThat(f()).isCloseTo(1.5, org.assertj.core.api.Assertions.within(1e-5));'],
    ['brackets and semicolons in a string', 'assertThat(f("}{)(;//")).isEqualTo("/*;");'],
    ['bracket char literals', "assertThat(f('}', '{', ';', '/')).isEqualTo('\\'');"],
    ['an escaped quote in a string', 'assertThat(f("a\\"}")).isEqualTo("\\\\");'],
    ['a division', 'assertThat(f(4 / 2)).isEqualTo(2);'],
    ['trailing spaces', 'assertThat(1).isEqualTo(1);  '],
    ['a trailing tab', 'foo();\t'],
    ['leading spaces', '   foo();'],
    ['a trailing newline', 'foo();\n'],
    ['a trailing carriage return', 'foo();\r\n'],
    ['a leading newline', '\nfoo();'],
  ])('accepts %s', (_label, statement) => {
    expect(validateAiTestStatements([statement])).toBeNull()
  })

  it.each([
    ['a statement closing the method', '}  void evil() {', 'unbalanced-brackets'],
    ['a closing brace before statements', '} void evil() { int y = 2;', 'unbalanced-brackets'],
    ['a trailing brace', 'foo(); }', 'unbalanced-brackets'],
    ['mismatched brackets', 'foo(];', 'unbalanced-brackets'],
    ['an unclosed bracket', 'foo(;', 'unbalanced-brackets'],
    ['a closer before its opener', ')foo(;', 'unbalanced-brackets'],
    ['a missing semicolon', 'assertThat(f()).isTrue()', 'semicolon'],
    ['two statements on a line', 'foo(); bar();', 'semicolon'],
    ['a for header', 'for (int i = 0; i < 1; i++) foo();', 'semicolon'],
    ['text after the semicolon', 'foo(); x', 'semicolon'],
    ['a lone semicolon', ';', 'semicolon'],
    ['an empty string', '', 'semicolon'],
    ['a blank string', '   ', 'semicolon'],
    ['a block', '{ foo(); }', 'semicolon'],
    ['an empty method', 'void evil() {}', 'semicolon'],
    ['a newline', 'foo(\n);', 'not-one-line'],
    ['a carriage return', 'foo(\r);', 'not-one-line'],
    ['a newline between statements', 'foo();\nbar();', 'not-one-line'],
    ['a newline inside and at the end', 'foo(\n);\n', 'not-one-line'],
    ['a newline inside and at the start', '\nfoo(\n);', 'not-one-line'],
    ['a line separator', 'foo(\u2028);', 'not-one-line'],
    ['a line comment', 'foo(); // done', 'comment'],
    ['a block comment', 'foo(/* x */);', 'comment'],
    ['a comment hiding a brace', 'foo(/* } */);', 'comment'],
    ['a unicode escaped brace', 'foo(); \\u007d', 'unicode-escape'],
    ['a unicode escape in a string', 'foo("\\u007d");', 'unicode-escape'],
    ['a repeated unicode marker', 'foo(\\uuuu007d);', 'unicode-escape'],
    ['an unterminated string', 'foo("a);', 'unterminated-literal'],
    ['an unterminated char', "foo('a);", 'unterminated-literal'],
    ['a string escaping its closing quote', 'foo("a\\");', 'unterminated-literal'],
    ['a text block opener', 'String s = """;', 'unterminated-literal'],
  ])('rejects %s', (_label, statement, reason) => {
    expect(validateAiTestStatements([ASSERTION, statement])).toBe(reason)
  })

  it('enforces the named count and length caps', () => {
    expect(validateAiTestStatements([])).toBe('no-statements')
    expect(validateAiTestStatements(Array(MAX_AI_TEST_STATEMENTS).fill('foo();'))).toBeNull()
    expect(validateAiTestStatements(Array(MAX_AI_TEST_STATEMENTS + 1).fill('foo();'))).toBe('too-many-statements')
    const atLimit = `foo("${'a'.repeat(MAX_AI_TEST_STATEMENT_LENGTH - 'foo("");'.length)}");`
    expect(atLimit).toHaveLength(MAX_AI_TEST_STATEMENT_LENGTH)
    expect(validateAiTestStatements([atLimit])).toBeNull()
    expect(validateAiTestStatements([`${atLimit}x`])).toBe('statement-too-long')
    expect(validateAiTestStatements([` ${atLimit} `])).toBeNull()
  })
})

describe('AI test candidate document', () => {
  const bodyOf = (source: string) => {
    const lookup = findBareJavaTest(source)
    if (lookup.status !== 'bare') throw new Error('expected a bare stub')
    return lookup.body
  }

  it('accepts the template, whose unfinished assertThat() is an error the edit removes', () => {
    expect(planAiTestInsertion(TEMPLATE, [ASSERTION]).ok).toBe(true)
  })

  it('accepts statements in a stub that has an empty solution method after it', () => {
    expect(TEMPLATE).toContain('public int minMoves(int[] nums) {\n\n    }')
    const plan = planAiTestInsertion(TEMPLATE, [
      'int[] arr1 = new int[]{1};',
      'rotate(arr1, 2);',
      'assertThat(arr1).containsExactly(1);',
    ])
    expect(plan.ok).toBe(true)
  })

  it('tolerates an unrelated syntax error the user already has elsewhere', () => {
    const source = TEMPLATE.replace('public int minMoves(int[] nums) {\n\n', 'public int minMoves(int[] nums) {\n        return ;+\n')
    expect(findBareJavaTest(source).status).toBe('bare')
    expect(planAiTestInsertion(source, [ASSERTION]).ok).toBe(true)
  })

  it('tolerates an error after the stub whose recovery the stub itself would disturb', () => {
    const source = 'class A {\n    @Test\n    void test() {\n        assertThat()\n    }\n    int a( {\n}\n'
    expect(planAiTestInsertion(source, ['foo();']).ok).toBe(true)
  })

  it.each([
    ['a method added after closing test()', '\n}  void evil() {\n'],
    ['a member added around a statement', '\nfoo();\n}\nint evil = 1;\nvoid evil2() {\n'],
    ['an extra closing brace', '\nfoo();\n}\n'],
  ])('rejects %s even when it reaches the parser', (_label, insert) => {
    expect(checkAiTestCandidate(TEMPLATE, bodyOf(TEMPLATE), insert)).toBe('outside-test-body')
  })

  it('rejects an unclosed body that swallows the members after it', () => {
    expect(checkAiTestCandidate(TEMPLATE, bodyOf(TEMPLATE), '\nif (a) {\n')).not.toBeNull()
  })

  it('rejects syntax errors inside the body', () => {
    expect(rejection(TEMPLATE, ['foo bar baz();'])).toBe('syntax-error')
    expect(rejection(TEMPLATE, ['int = ;'])).toBe('syntax-error')
    expect(rejection(TEMPLATE, ['foo\\bar();'])).toBe('syntax-error')
    expect(rejection(TEMPLATE, ['String s = """a""";'])).toBe('syntax-error')
  })

  it('rejects a line that is not exactly one statement', () => {
    expect(rejection(TEMPLATE, ['class A {} int x = 1;'])).toBe('not-one-statement')
    expect(rejection(TEMPLATE, ['if (a) b();', 'else c();'])).toBe('not-one-statement')
    expect(rejection(TEMPLATE, ['class A {};'])).toBe('not-one-statement')
  })

  it('reports a stub that is gone before looking at the statements', () => {
    expect(rejection('class S {}', [ASSERTION])).toBe('stub-missing')
    expect(rejection(TEMPLATE.replace('assertThat()', 'assertThat(1)'), [ASSERTION])).toBe('stub-filled')
    expect(rejection(TEMPLATE.replace('assertThat()', '// mine'), [ASSERTION])).toBe('stub-filled')
    expect(rejection(TEMPLATE, [])).toBe('no-statements')
  })
})

describe('AI test formatting', () => {
  const fill = (source: string, statements: string[]) => {
    const plan = planAiTestInsertion(source, statements)
    if (!plan.ok) throw new Error(plan.reason)
    return `${source.slice(0, plan.from)}${plan.insert}${source.slice(plan.to)}`
  }

  it('indents statements to match the stub, as in the template', () => {
    expect(fill(TEMPLATE, [ASSERTION, 'foo();'])).toContain(
      `    public void test() {\n        ${ASSERTION}\n        foo();\n    }\n`,
    )
  })

  it('derives the indentation of an empty body from its method', () => {
    expect(fill('class S {\n    @Test void test() {}\n}\n', ['foo();']))
      .toBe('class S {\n    @Test void test() {\n        foo();\n    }\n}\n')
    expect(fill('class S {\n    @Test void test() {\n    }\n}\n', ['foo();']))
      .toBe('class S {\n    @Test void test() {\n        foo();\n    }\n}\n')
    expect(fill('class S {\n\t@Test void test() {\n\t}\n}\n', ['foo();']))
      .toBe('class S {\n\t@Test void test() {\n\t\tfoo();\n\t}\n}\n')
  })

  it('moves a statement sharing the brace line onto its own line', () => {
    expect(fill('class S {\n    @Test void test() { assertThat() }\n}\n', ['foo();']))
      .toBe('class S {\n    @Test void test() {\n        foo();\n    }\n}\n')
  })

  it('keeps the indentation of an unusually indented stub and strips leading spaces', () => {
    const source = 'class S {\n  @Test void test() {\n      assertThat();\n  }\n}\n'
    const lookup = findBareJavaTest(source)
    if (lookup.status !== 'bare') throw new Error('expected a bare stub')
    expect(formatAiTestBody(source, lookup.body, ['   foo();'])).toBe('\n      foo();\n  ')
  })

  it('writes no whitespace from around a statement into the document', () => {
    expect(fill('class S {\n    @Test void test() {}\n}\n', ['  foo();  ', 'bar();\n', '\tbaz();\t\r\n']))
      .toBe('class S {\n    @Test void test() {\n        foo();\n        bar();\n        baz();\n    }\n}\n')
  })
})

describe('AI test method headers', () => {
  it('lists non-test headers from the document without bodies', () => {
    const source = [
      'class S {',
      '    @Test',
      '    public void test() { assertThat(); }',
      '    @org.junit.jupiter.api.Test void test2() {}',
      '    public int minMoves(int[] nums) {',
      '        return secret(nums);',
      '    }',
      '    private static <T> List<T> renamed(',
      '        List<T> values,   // first',
      '        @Deprecated int count /* second */',
      '    ) throws Exception {',
      '        return values;',
      '    }',
      '    @Override',
      '    public String toString() { return "void fake() {}"; }',
      '}',
    ].join('\n')
    expect(listJavaMethodHeaders(source)).toEqual([
      'public int minMoves(int[] nums)',
      'private static <T> List<T> renamed( List<T> values, int count ) throws Exception',
      'public String toString()',
    ])
  })

  it('lists a method without a body and skips methods of classes inside bodies', () => {
    const source = [
      'abstract class S {',
      '    abstract int size();',
      '    int helper() {',
      '        return new Object() { int hidden() { return 1; } }.hidden();',
      '    }',
      '}',
    ].join('\n')
    expect(listJavaMethodHeaders(source)).toEqual(['abstract int size()', 'int helper()'])
  })

  it('returns nothing when the document has only tests', () => {
    expect(listJavaMethodHeaders('class S {\n    @Test void test() {}\n}')).toEqual([])
  })
})

describe('applying AI tests', () => {
  it('replaces the stub in one transaction tagged input.aiTests', () => {
    const { view, state } = mutableEditorView(javaState(TEMPLATE))
    const dispatch = vi.spyOn(view, 'dispatch')
    expect(applyAiTestStatements(view, [ASSERTION]).ok).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0][0]).toMatchObject({ userEvent: 'input.aiTests' })
    expect(state().doc.toString()).toBe(TEMPLATE.replace('assertThat()', ASSERTION))
  })

  it.each([
    ['filled', 'assertThat(1).isEqualTo(1);', 'stub-filled'],
    ['commented', '// mine', 'stub-filled'],
  ])('leaves a document untouched when the stub was %s during the call', (_label, body, reason) => {
    const source = TEMPLATE.replace('assertThat()', body)
    const { view, state } = mutableEditorView(javaState(source))
    expect(applyAiTestStatements(view, [ASSERTION])).toEqual({ ok: false, reason })
    expect(state().doc.toString()).toBe(source)
  })

  it('re-locates the stub in the current document, not an earlier one', () => {
    const { view, state } = mutableEditorView(javaState(TEMPLATE))
    view.dispatch({ changes: { from: TEMPLATE.indexOf('public class'), insert: '// moved\n' } })
    expect(applyAiTestStatements(view, [ASSERTION]).ok).toBe(true)
    expect(state().doc.toString()).toContain(`// moved\npublic class`)
    expect(state().doc.toString()).toContain(`test() {\n        ${ASSERTION}\n    }`)
  })

  it('does not change the document when validation fails', () => {
    const { view, state } = mutableEditorView(javaState(TEMPLATE))
    expect(applyAiTestStatements(view, [ASSERTION, '}  void evil() {'])).toEqual({
      ok: false,
      reason: 'unbalanced-brackets',
    })
    expect(state().doc.toString()).toBe(TEMPLATE)
  })

  it('adds only imports the pruning pass keeps, and pruning drops them once unused', () => {
    const state = EditorState.create({
      doc: TEMPLATE,
      extensions: [java(), javaAutoImports, psLibraryExtension],
    }).update({ effects: setPsLibraryMetadata.of(PS_METADATA) }).state
    const { view, state: current } = mutableEditorView(state)
    expect(applyAiTestStatements(view, ['assertThat(f(TreeNode.of(1), ListNode.of(1))).isTrue();']).ok).toBe(true)
    const filled = current().doc.toString()
    expect(removeUnusedJavaTypeImports(filled)).toBe(filled)
    const withoutReferences = filled.replace('TreeNode.of(1), ListNode.of(1)', '')
    expect(removeUnusedJavaTypeImports(withoutReferences)).not.toContain('io.github.shanepark.leetcode')
  })

  it('imports the tolerance helper the double assertion uses', () => {
    const state = EditorState.create({ doc: TEMPLATE, extensions: [java(), javaAutoImports] })
    const { view, state: current } = mutableEditorView(state)
    expect(applyAiTestStatements(view, ['assertThat(f()).isCloseTo(1.5, Offset.offset(0.00001));']).ok).toBe(true)
    expect(current().doc.toString()).toContain('import org.assertj.core.data.Offset;')
  })

  it.each([
    ['design', [
      'LRUCache lruCache = new LRUCache(2);',
      'lruCache.put(1, 1);',
      'assertThat(lruCache.get(1)).isEqualTo(1);',
      'LRUCache lruCache2 = new LRUCache(1);',
    ]],
    ['graph of a custom class', [
      'Node node1 = new Node(1);',
      'Node node2 = new Node(2);',
      'node1.neighbors.add(node2);',
      'Node clone = cloneGraph(node1);',
      'assertThat(clone.neighbors.get(0).val).isEqualTo(2);',
    ]],
    ['edge list', ['assertThat(countPaths(3, Ps.intArray("[[0,1,5],[1,2,3]]"))).isEqualTo(1);']],
    ['nested any order', ['assertThat(f()).containsExactlyInAnyOrderElementsOf(Ps.intList("[[1],[2]]"));']],
    ['char grid', ['assertThat(numIslands(Ps.charArray("[[\\"1\\",\\"0\\"]]"))).isEqualTo(1);']],
    ['cycle', ['ListNode head = ListNode.of(3, 2, 0);', 'head.next.next.next = head.next;', 'assertThat(hasCycle(head)).isTrue();']],
    ['tree node', ['TreeNode root = TreeNode.of(3, 5, 1);', 'assertThat(lca(root, root.left, root.right)).isEqualTo(root);']],
    ['in place', ['int[] arr = new int[] {2, 0};', 'sortColors(arr);', 'assertThat(arr).containsExactly(0, 2);']],
  ])('accepts the prompt\'s %s statements', (_case, forms) => {
    expect(rejection(TEMPLATE, forms)).toBeNull()
  })

  it('adds imports for a long document whose tree is not finished yet', () => {
    const padding = Array.from({ length: 400 }, (_, index) => `    int field${index} = ${index};`).join('\n')
    const source = TEMPLATE.replace('    @Test', `${padding}\n\n    @Test`)
    const state = EditorState.create({
      doc: source,
      extensions: [java(), javaAutoImports, psLibraryExtension],
    }).update({ effects: setPsLibraryMetadata.of(PS_METADATA) }).state
    const { view, state: current } = mutableEditorView(state)
    expect(applyAiTestStatements(view, ['assertThat(f(TreeNode.of(1))).isTrue();']).ok).toBe(true)
    expect(current().doc.toString()).toContain('import io.github.shanepark.leetcode.TreeNode;')
  })

  it('leaves typed input on the unfinished tree of a long document', () => {
    const padding = Array.from({ length: 400 }, (_, index) => `    int field${index} = ${index};`).join('\n')
    const source = TEMPLATE.replace('    @Test', `${padding}\n\n    @Test`)
    const state = EditorState.create({
      doc: source,
      extensions: [java(), javaAutoImports, psLibraryExtension],
    }).update({ effects: setPsLibraryMetadata.of(PS_METADATA) }).state
    const typed = state.update({
      changes: { from: source.indexOf('assertThat()'), insert: 'TreeNode.of(1);' },
      userEvent: 'input.type',
    }).state
    expect(syntaxTree(typed).length).toBeLessThan(typed.doc.length)
    expect(typed.doc.toString()).not.toContain('import io.github.shanepark.leetcode.TreeNode;')
  })

  it('does not import a helper type over a declaration in the file', () => {
    const source = TEMPLATE.replace('    @Test', '    static class TreeNode {}\n\n    @Test')
    const state = EditorState.create({
      doc: source,
      extensions: [java(), javaAutoImports, psLibraryExtension],
    }).update({ effects: setPsLibraryMetadata.of(PS_METADATA) }).state
    const { view, state: current } = mutableEditorView(state)
    expect(applyAiTestStatements(view, ['assertThat(f(new TreeNode())).isTrue();']).ok).toBe(true)
    expect(current().doc.toString()).not.toContain('import io.github.shanepark.leetcode.TreeNode;')
  })

  describe('in the real editor', () => {
    it('undoes the statements and the imports in one step', () => {
      const editor = createEditor(TEMPLATE)
      editor.setPsLibraryMetadata(PS_METADATA)

      const result = editor.applyAiTests([
        'ListNode head = ListNode.of(1, 2, 3);',
        'assertThat(minMoves(TreeNode.of(1, 2, null, 3), head)).isDeepEqualTo(Ps.intArray("[[1]]"));',
        'List<Integer> values = new ArrayList<>();',
      ])

      expect(result.ok).toBe(true)
      const filled = editor.getValue()
      expect(filled).toContain([
        'import io.github.shanepark.leetcode.ListNode;',
        'import io.github.shanepark.leetcode.TreeNode;',
        'import io.github.shanepark.Ps;',
        'import java.util.ArrayList;',
        'import java.util.List;',
        'import org.junit.jupiter.api.Test;',
      ].join('\n'))
      expect(filled).toContain('    public void test() {\n        ListNode head = ListNode.of(1, 2, 3);\n')
      expect(filled).not.toContain('assertThat()\n')

      undoIn(editor)
      expect(editor.getValue()).toBe(TEMPLATE)
    })

    it('does not join the edit with typing just before it', () => {
      const editor = createEditor(TEMPLATE)
      const head = TEMPLATE.indexOf('public int minMoves')
      editor.view.dispatch({ changes: { from: head, insert: '// x\n    ' }, userEvent: 'input.type' })
      const typed = editor.getValue()

      expect(editor.applyAiTests([ASSERTION]).ok).toBe(true)
      undoIn(editor)
      expect(editor.getValue()).toBe(typed)
    })

    it('leaves helper types unimported without library metadata', () => {
      const editor = createEditor(TEMPLATE)
      expect(editor.applyAiTests(['assertThat(f(TreeNode.of(1))).isTrue();']).ok).toBe(true)
      expect(editor.getValue()).not.toContain('import io.github.shanepark.leetcode.TreeNode;')
    })

    it('does not open the completion popup or reindent, unlike typing', () => {
      const editor = createEditor(TEMPLATE)
      expect(completionStatus(editor.view.state)).toBeNull()

      expect(editor.applyAiTests([ASSERTION]).ok).toBe(true)
      expect(completionStatus(editor.view.state)).toBeNull()
      expect(editor.getValue()).toBe(TEMPLATE.replace('assertThat()', ASSERTION))

      const typed = editor.view.state.update({
        changes: { from: TEMPLATE.indexOf('public class'), insert: 'p' },
        selection: { anchor: TEMPLATE.indexOf('public class') + 1 },
        userEvent: 'input.type',
      }).state
      expect(completionStatus(typed)).toBe('pending')
    })

    it('reports a filled test and leaves the document and history alone', () => {
      const source = TEMPLATE.replace('assertThat()', 'assertThat(1).isEqualTo(1);')
      const editor = createEditor(source)
      expect(editor.applyAiTests([ASSERTION])).toEqual({ ok: false, reason: 'stub-filled' })
      expect(editor.getValue()).toBe(source)
      expect(applyUndo(editor.view.state).handled).toBe(false)
    })

    it('regenerates after an undo restores the stub', () => {
      const editor = createEditor(TEMPLATE)
      expect(editor.applyAiTests([ASSERTION]).ok).toBe(true)
      expect(editor.applyAiTests([ASSERTION])).toEqual({ ok: false, reason: 'stub-filled' })
      undoIn(editor)
      expect(editor.applyAiTests(['foo();']).ok).toBe(true)
      expect(editor.getValue()).toContain('test() {\n        foo();\n    }')
    })
  })

  it('keeps one undo step in a plain history-backed state', () => {
    const state = EditorState.create({
      doc: TEMPLATE,
      extensions: [java(), history(), javaAutoImports],
    })
    const { view, state: current } = mutableEditorView(state)
    expect(applyAiTestStatements(view, ['List<Integer> list = new ArrayList<>();']).ok).toBe(true)
    expect(current().doc.toString()).toContain('import java.util.List;')
    const undone = applyUndo(current())
    expect(undone.state.doc.toString()).toBe(TEMPLATE)
    expect(applyUndo(undone.state).handled).toBe(false)
  })
})

import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { runScopeHandlers, type EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import {
  applySelectedJavaIntention,
  dismissJavaIntentions,
  javaIntentionsExtension,
  javaIntentionsState,
  javaIntentionsAt,
  planJavaMethodCreation,
  showJavaIntentions,
} from '../../../src/editor'

function mutableView(initial: EditorState): { view: EditorView; state: () => EditorState } {
  let state = initial
  const view = {
    get state() {
      return state
    },
    dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => {
      state = state.update(spec).state
    },
    focus: () => undefined,
  } as unknown as EditorView
  return { view, state: () => state }
}

function editorState(source: string, position = source.length): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [java(), history(), javaIntentionsExtension],
    selection: { anchor: position },
  })
}

describe('Java create-method intention planning', () => {
  it('infers the screenshot method from an unresolved call at the line start', () => {
    const source = `class Solution {
    int answer = 0;
    public int averageOfSubtree(TreeNode root) {
        answer = 0;
        int n = dfs(root);
        return answer;
    }
}`
    const lineStart = source.indexOf('        int n')
    const plan = planJavaMethodCreation(source, lineStart)

    expect(plan?.name).toBe('dfs')
    expect(plan?.returnType).toBe('int')
    expect(plan?.parameters).toEqual([{ type: 'TreeNode', name: 'root' }])
    expect(plan?.change.insert).toContain('private int dfs(TreeNode root)')
    expect(plan?.change.insert).toContain('return 0;')
    expect(plan && plan.change.insert.slice(plan.selection.from - plan.change.from, plan.selection.to - plan.change.from)).toBe('0')
  })

  it('infers boolean return and array element parameters in a negated condition', () => {
    const source = `class Solution {
    public boolean isRectangleOverlap(int[] rec1, int[] rec2) {
        if (!isOverval(rec1[0], rec1[2], rec2[0], rec2[2]))
            return false;
        return true;
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('isOverval') + 1)

    expect(plan?.returnType).toBe('boolean')
    expect(plan?.parameters).toEqual([
      { type: 'int', name: 'value' },
      { type: 'int', name: 'value2' },
      { type: 'int', name: 'value3' },
      { type: 'int', name: 'value4' },
    ])
    expect(plan?.change.insert).toContain('private boolean isOverval(int value, int value2, int value3, int value4)')
    expect(plan?.change.insert).toContain('return false;')
  })

  it('does not infer boolean for a call used as a comparison operand', () => {
    const source = `class Solution {
    int solve() {
        if (missing() == 1)
            return 1;
        return 0;
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('missing') + 1)

    expect(plan?.returnType).toBe('int')
    expect(plan?.returnType).not.toBe('boolean')
  })

  it('infers the return and parameter types from a comparison with an array element', () => {
    const source = `class Solution {
    int smallestIndex(int[] nums) {
        for (int i = 0; i < nums.length; i++) {
            if (digitSum(nums[i]) == i) {
                return i;
            }
        }
        return -1;
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('digitSum') + 1)

    expect(plan?.returnType).toBe('int')
    expect(plan?.parameters).toEqual([{ type: 'int', name: 'value' }])
    expect(plan?.change.insert).toContain('private int digitSum(int value)')
    expect(plan?.change.insert).toContain('return 0;')
  })

  it('inserts after the enclosing method instead of inside its body', () => {
    const source = `class Solution {
    int solve(TreeNode root) {
        return dfs(root);
    }

    int later() {
        return 1;
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('dfs') + 1)
    expect(plan).not.toBeNull()
    const updated = source.slice(0, plan!.change.from)
      + plan!.change.insert
      + source.slice(plan!.change.to)
    expect(updated.indexOf('private int dfs')).toBeGreaterThan(updated.indexOf('return dfs(root);'))
    expect(updated.indexOf('private int dfs')).toBeLessThan(updated.indexOf('int later()'))
    expect(updated.slice(updated.indexOf('private int dfs'), updated.indexOf('int later()'))).toContain('\n    }\n')
  })

  it('leaves a blank line before a method created after the enclosing method', () => {
    const source = `class Solution {
    int solve(TreeNode root) {
        return dfs(root);
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('dfs') + 1)
    expect(plan).not.toBeNull()
    const updated = source.slice(0, plan!.change.from)
      + plan!.change.insert
      + source.slice(plan!.change.to)

    expect(updated).toContain('    }\n\n    private int dfs(TreeNode root)')
  })

  it('keeps CRLF line breaks and the return-value selection with the blank line', () => {
    const source = [
      'class Solution {',
      '    int solve(TreeNode root) {',
      '        return dfs(root);',
      '    }',
      '}',
    ].join('\r\n')
    const plan = planJavaMethodCreation(source, source.indexOf('dfs') + 1)
    expect(plan).not.toBeNull()
    const updated = source.slice(0, plan!.change.from)
      + plan!.change.insert
      + source.slice(plan!.change.to)

    expect(updated).toContain('    }\r\n\r\n    private int dfs(TreeNode root)')
    expect(updated.slice(plan!.selection.from, plan!.selection.to)).toBe('0')
  })

  it('inserts before the class close when the call is in a field initializer', () => {
    const source = `class Solution {
    int answer = missing(1);
}`
    const plan = planJavaMethodCreation(source, source.indexOf('missing') + 2)
    expect(plan?.returnType).toBe('int')
    const updated = source.slice(0, plan!.change.from)
      + plan!.change.insert
      + source.slice(plan!.change.to)
    expect(updated).toContain('    private int missing(int value)')
    expect(updated.indexOf('private int missing')).toBeLessThan(updated.lastIndexOf('}'))
  })

  it('infers return expressions and parameter names for common argument forms', () => {
    const source = `class Solution {
    String solve(String text) {
        return missing(text);
    }
}`
    const plan = planJavaMethodCreation(source, source.indexOf('missing') + 1)
    expect(plan?.returnType).toBe('String')
    expect(plan?.parameters).toEqual([{ type: 'String', name: 'text' }])
    expect(plan?.change.insert).toContain('return null;')
  })

  it('does not offer a method for existing, foreign, or trivia calls', () => {
    const source = `class Solution {
    int known(TreeNode root) { return 1; }
    int solve(TreeNode root) {
        known(root);
        other.dfs(root);
        String text = "missing(root)";
        // missing(root)
        return missing(root);
    }
}`
    expect(planJavaMethodCreation(source, source.indexOf('known(root)') + 2)).toBeNull()
    expect(planJavaMethodCreation(source, source.indexOf('other.dfs') + 'other.'.length + 1)).toBeNull()
    expect(planJavaMethodCreation(source, source.indexOf('missing(root)') + 2)).toBeNull()
    const actual = source.lastIndexOf('missing(root)')
    expect(planJavaMethodCreation(source, actual + 2)).not.toBeNull()
  })

  it('creates a method in a same-file class for a call on a typed receiver', () => {
    const source = `public class Solution {
    public int[] findSubtreeSizes(int[] parent, String s) {
        Node[] nodes = new Node[parent.length];
        for (int i = 0; i < parent.length; i++) {
            Node node = new Node();
            nodes[i] = node;
            Node parentNode = nodes[parent[i]];
            parentNode.addChild(node);
        }
        return null;
    }

    class Node {
        List<Node> children = new ArrayList<>();

    }

}`
    const intentions = javaIntentionsAt(source, source.indexOf('addChild') + 2)
    expect(intentions.map((intention) => intention.label)).toEqual(["Create method 'addChild'"])
    const plan = intentions[0]!.plan
    expect(plan.returnType).toBe('void')
    expect(plan.parameters).toEqual([{ type: 'Node', name: 'node' }])
    const updated = source.slice(0, plan.change.from) + plan.change.insert + source.slice(plan.change.to)
    expect(updated).toContain(`    class Node {
        List<Node> children = new ArrayList<>();

        public void addChild(Node node) {
        }
    }

}`)
  })

  it('creates a static method for a call on a same-file class name', () => {
    const source = `class Solution {
    int solve() {
        return Helper.make(3);
    }
}

class Helper {
}`
    const plan = planJavaMethodCreation(source, source.indexOf('make') + 1)
    const updated = source.slice(0, plan!.change.from) + plan!.change.insert + source.slice(plan!.change.to)
    expect(updated).toContain(`class Helper {
    public static int make(int value) {
        return 0;
    }
}`)
  })

  it('ignores qualified calls it cannot resolve to a new method in this file', () => {
    const source = `class Solution {
    void solve(List<Node> list, Node[] array, Node node) {
        list.add(node);
        array.clone();
        node.known();
        Math.max(1, 2);
        list.add(missing(node));
    }

    class Node {
        void known() {}
    }
}`
    expect(planJavaMethodCreation(source, source.indexOf('add(node)') + 1)).toBeNull()
    expect(planJavaMethodCreation(source, source.indexOf('clone') + 1)).toBeNull()
    expect(planJavaMethodCreation(source, source.indexOf('known();') + 1)).toBeNull()
    expect(planJavaMethodCreation(source, source.indexOf('max') + 1)).toBeNull()
    const lastLine = source.indexOf('        list.add(missing')
    expect(planJavaMethodCreation(source, lastLine)?.name).toBe('missing')
  })

  it('creates an overload when the same-named method takes a different number of arguments', () => {
    const source = `public class Solution {
    public int[] findSubtreeSizes(int[] parent, String s) {
        Node node = new Node();
        Node parentNode = node;
        parentNode.addChild(node);
        return null;
    }

    class Node {
        List<Node> children = new ArrayList<>();
        Node parent;
        void addChild(Node node, Node parent) {
            this.children.add(node);
        }

    }

}`
    const intentions = javaIntentionsAt(source, source.indexOf('addChild(node)') + 2)
    expect(intentions.map((intention) => intention.label)).toEqual(["Create method 'addChild'"])
    const plan = intentions[0]!.plan
    const updated = source.slice(0, plan.change.from) + plan.change.insert + source.slice(plan.change.to)
    expect(updated).toContain(`            this.children.add(node);
        }

        public void addChild(Node node) {
        }
    }`)
  })

  it('does not create an overload beside a same-named varargs method', () => {
    const source = `class Solution {
    void solve(Node node) {
        node.add(1, 2);
    }

    class Node {
        void add(int... values) {}
    }
}`
    expect(planJavaMethodCreation(source, source.indexOf('add(1') + 1)).toBeNull()
  })

  it('does not add a parameter to a same-named caller method for a qualified call', () => {
    const source = `class Solution {
    void addChild(Node node) {
        Node other = new Node();
        other.addChild(node, 1);
    }

    class Node {
    }
}`
    const intentions = javaIntentionsAt(source, source.indexOf('other.addChild') + 'other.'.length + 1)
    expect(intentions.map((intention) => intention.id)).toEqual(['create-method'])
    expect(intentions[0]!.plan.change.insert).toContain('public void addChild(Node node, int value)')
  })
})

describe('Java intentions menu state and keyboard actions', () => {
  it('opens with create-method selected and Enter applies it as one undoable edit', () => {
    const source = `class Solution {
    int solve(TreeNode root) { return dfs(root); }
}`
    const cursor = source.indexOf('dfs') + 1
    const harness = mutableView(editorState(source, cursor))

    expect(showJavaIntentions(harness.view)).toBe(true)
    const menu = harness.state().field(javaIntentionsState, false)
    expect(menu?.selectedIndex).toBe(0)
    expect(menu?.intentions[0]?.label).toBe("Create method 'dfs'")
    expect(applySelectedJavaIntention(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toContain('private int dfs(TreeNode root)')
    expect(undo(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toBe(source)
  })

  it('uses Enter and Escape while the menu is open', () => {
    const source = `class Solution {
    int solve(TreeNode root) { return dfs(root); }
}`
    const cursor = source.indexOf('dfs') + 1
    const harness = mutableView(editorState(source, cursor))
    expect(showJavaIntentions(harness.view)).toBe(true)
    expect(runScopeHandlers(harness.view, {
      key: 'Escape',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')).toBe(true)
    expect(harness.state().field(javaIntentionsState, false)).toBeNull()
    expect(showJavaIntentions(harness.view)).toBe(true)
    expect(runScopeHandlers(harness.view, {
      key: 'Enter',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    } as KeyboardEvent, 'editor')).toBe(true)
    expect(harness.state().doc.toString()).toContain('private int dfs(TreeNode root)')
  })

  it('closes a stale menu when the source or selection changes', () => {
    const source = `class Solution {
    int solve(TreeNode root) { return dfs(root); }
}`
    const cursor = source.indexOf('dfs') + 1
    const harness = mutableView(editorState(source, cursor))
    expect(showJavaIntentions(harness.view)).toBe(true)
    harness.view.dispatch({ changes: { from: 0, insert: '//' } })
    expect(harness.state().field(javaIntentionsState, false)).toBeNull()

    const second = mutableView(editorState(source, cursor))
    expect(showJavaIntentions(second.view)).toBe(true)
    second.view.dispatch({ selection: { anchor: 0 } })
    expect(second.state().field(javaIntentionsState, false)).toBeNull()
    expect(dismissJavaIntentions(second.view)).toBe(false)
  })

  it('leaves a read-only document unchanged when applying an open action', () => {
    const source = `class Solution {
    int solve(TreeNode root) { return dfs(root); }
}`
    const cursor = source.indexOf('dfs') + 1
    const state = EditorState.create({
      doc: source,
      extensions: [java(), history(), EditorState.readOnly.of(true), javaIntentionsExtension],
      selection: { anchor: cursor },
    })
    const harness = mutableView(state)
    expect(showJavaIntentions(harness.view)).toBe(true)
    expect(applySelectedJavaIntention(harness.view)).toBe(true)
    expect(harness.state().doc.toString()).toBe(source)
    expect(harness.state().field(javaIntentionsState, false)).toBeNull()
  })

  it('returns no action for an unsupported cursor and exposes only one first action', () => {
    const source = 'class Solution { int solve() { return 1; } }'
    expect(javaIntentionsAt(source, source.indexOf('solve'))).toEqual([])
  })
})

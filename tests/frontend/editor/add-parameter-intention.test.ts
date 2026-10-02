import { history, undo } from '@codemirror/commands'
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  applySelectedJavaIntention,
  javaIntentionsAt,
  javaIntentionsExtension,
  javaIntentionsState,
  showJavaIntentions,
} from '../../../src/editor/intentions'

const screenshot = `class Solution {
    public List<String> generateParenthesis(int n) {
        StringBuilder sb = new StringBuilder();
        List<String> answer = new ArrayList<>();
        dfs(answer, sb, 0, n);
        return answer;
    }

    private void dfs(StringBuilder sb, int openCnt, int n) {
        if (sb.length() == n * 2) {
            answer.add(sb.toString());
            return;
        }
    }
}`

const recursiveScreenshot = screenshot.replace('        }\n    }\n}', `        }
        if (openCnt < n) {
            sb.append('(');
            dfs(answer, sb, openCnt + 1, n);
            sb.deleteCharAt(sb.length() - 1);
        }
        if (openCnt > 0) {
            sb.append(')');
            dfs(answer, sb, openCnt - 1, n);
            sb.deleteCharAt(sb.length() - 1);
        }
    }
}`)

function harness(source = screenshot, readOnly = false) {
  let state = EditorState.create({
    doc: source,
    selection: { anchor: source.indexOf('dfs(answer') + 1 },
    extensions: [java(), history(), javaIntentionsExtension, EditorState.readOnly.of(readOnly)],
  })
  const view = {
    get state() { return state },
    dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => { state = state.update(spec).state },
    focus: () => undefined,
  } as unknown as EditorView
  return { view, state: () => state }
}

function actions(source: string) {
  return javaIntentionsAt(source, source.indexOf('dfs(') + 1)
}

describe('Add method parameter intention', () => {
  it('offers the screenshot signature fix on the call, extra argument, and diagnostic line', () => {
    for (const position of [screenshot.indexOf('dfs(answer') + 1, screenshot.indexOf('answer, sb'), screenshot.indexOf('        dfs')]) {
      const [action] = javaIntentionsAt(screenshot, position)
      expect(action?.id).toBe('add-method-parameter')
      expect(action?.label).toBe("Add 'List<String>' as 1st parameter to method 'dfs()'")
      const plan = action!.plan
      const updated = screenshot.slice(0, plan.change.from) + plan.change.insert + screenshot.slice(plan.change.to)
      expect(updated).toBe(screenshot.replace('private void dfs(', 'private void dfs(List<String> answer, '))
      expect(updated.slice(plan.selection.from, plan.selection.to)).toBe('answer')
    }
  })

  it('applies from the menu as one undoable edit while preserving the method body', () => {
    const editor = harness()
    expect(showJavaIntentions(editor.view)).toBe(true)
    expect(editor.state().field(javaIntentionsState)?.intentions[0]?.id).toBe('add-method-parameter')
    expect(applySelectedJavaIntention(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe(screenshot.replace('private void dfs(', 'private void dfs(List<String> answer, '))
    expect(undo(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe(screenshot)
  })

  it('handles an extra identifier in the middle, at the end, or in an empty signature', () => {
    for (const [call, signature, expected] of [
      ['sb, answer, n', 'StringBuilder sb, int n', 'StringBuilder sb, List<String> answer, int n'],
      ['sb, n, answer', 'StringBuilder sb, int n', 'StringBuilder sb, int n, List<String> answer'],
      ['answer', '', 'List<String> answer'],
    ]) {
      const source = `class Solution { void solve(StringBuilder sb, int n, List<String> answer) { dfs(${call}); } private void dfs(${signature}) {} }`
      const [action] = actions(source)
      expect(action?.id).toBe('add-method-parameter')
      const change = action!.plan.change
      const updated = source.slice(0, change.from) + change.insert + source.slice(change.to)
      expect(updated).toContain(`private void dfs(${expected})`)
      expect(updated.slice(action!.plan.selection.from, action!.plan.selection.to)).toBe('answer')
    }
  })

  it('preserves multiline CRLF signatures', () => {
    const source = screenshot.replace('dfs(StringBuilder sb, int openCnt, int n)', 'dfs(\n        StringBuilder sb,\n        int openCnt,\n        int n\n    )').replace(/\n/g, '\r\n')
    const [action] = actions(source)
    expect(action?.plan.change.insert).toBe('List<String> answer, ')
    const change = action!.plan.change
    const updated = source.slice(0, change.from) + change.insert + source.slice(change.to)
    expect(updated).toContain('dfs(\r\n        List<String> answer, StringBuilder sb,\r\n')
  })

  it('suppresses unknown, ambiguous, mismatched, conflicting, overloaded, and foreign calls', () => {
    const sources = [
      screenshot.replace('List<String> answer =', 'var answer ='),
      screenshot.replace('dfs(answer, sb, 0, n)', 'dfs(missing, sb, 0, n)'),
      'class Solution { void solve(int a, int b) { dfs(a, b); } void dfs(int x) {} }',
      screenshot.replace('dfs(answer, sb, 0, n)', 'dfs(answer, n, 0, n)'),
      screenshot.replace('if (sb.length()', 'List<String> answer = null; if (sb.length()'),
      screenshot.replace('    private void dfs', '    void dfs(String text) {}\n    private void dfs'),
      screenshot.replace('dfs(answer, sb, 0, n)', 'other.dfs(answer, sb, 0, n)'),
      screenshot.replace('dfs(answer, sb, 0, n)', 'dfs(sb, 0, n)'),
    ]
    for (const source of sources) expect(actions(source)).toEqual([])
  })

  it('suppresses edits that would invalidate old-arity or incompatible recursive calls', () => {
    for (const extra of ['dfs(sb, 0, n);', 'dfs(sb, answer, 0, n);', 'dfs("wrong", sb, 0, n);', 'dfs(unknown, sb, 0, n);']) {
      const source = screenshot.replace('            return;', `            ${extra}\n            return;`)
      expect(actions(source)).toEqual([])
    }
  })

  it('adds the parameter for the recursive screenshot from the caller or either recursive call', () => {
    const positions = [recursiveScreenshot.indexOf('dfs(answer'), recursiveScreenshot.indexOf('dfs(answer, sb, openCnt +'), recursiveScreenshot.indexOf('dfs(answer, sb, openCnt -')]
    for (const position of positions) {
      const [action] = javaIntentionsAt(recursiveScreenshot, position + 1)
      expect(action?.label).toBe("Add 'List<String>' as 1st parameter to method 'dfs()'")
      const change = action!.plan.change
      const updated = recursiveScreenshot.slice(0, change.from) + change.insert + recursiveScreenshot.slice(change.to)
      expect(updated).toBe(recursiveScreenshot.replace('private void dfs(', 'private void dfs(List<String> answer, '))
    }
    const editor = harness(recursiveScreenshot)
    expect(showJavaIntentions(editor.view)).toBe(true)
    expect(applySelectedJavaIntention(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toContain('private void dfs(List<String> answer, StringBuilder sb, int openCnt, int n)')
    expect(undo(editor.view)).toBe(true)
    expect(editor.state().doc.toString()).toBe(recursiveScreenshot)
  })

  it('allows another resolved caller containing the same extra parameter type', () => {
    const source = screenshot.replace('        return answer;', '        dfs(answer, sb, 1, n);\n        return answer;')
    expect(actions(source)[0]?.id).toBe('add-method-parameter')
  })

  it('suppresses signature edits referenced by a method reference', () => {
    for (const receiver of ['this', 'Solution']) {
      const source = screenshot.replace('        return answer;', `        Object callback = ${receiver}::dfs;\n        return answer;`)
      expect(actions(source)).toEqual([])
    }
  })

  it('preserves read-only documents and dismisses stale menu plans', () => {
    const readOnly = harness(screenshot, true)
    expect(showJavaIntentions(readOnly.view)).toBe(true)
    expect(applySelectedJavaIntention(readOnly.view)).toBe(true)
    expect(readOnly.state().doc.toString()).toBe(screenshot)
    expect(readOnly.state().field(javaIntentionsState)).toBeNull()

    const stale = harness()
    expect(showJavaIntentions(stale.view)).toBe(true)
    stale.view.dispatch({ changes: { from: 0, insert: '// changed\n' } })
    expect(applySelectedJavaIntention(stale.view)).toBe(false)
    expect(stale.state().doc.toString()).not.toContain('dfs(List<String> answer')
  })
})

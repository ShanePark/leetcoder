import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { showTooltip, runScopeHandlers, EditorView as EditorViewClass, type EditorView, type ViewUpdate, ViewPlugin } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { createJavaParameterInfo, javaParameterCallAt } from '../../../src/editor/parameter-info'
import { psLibraryExtension, setPsLibraryMetadata } from '../../../src/completions/library'
import type { JavaTypeMembersMetadata } from '../../../src/backend'

function harness(marked: string, inspect?: (names: string[]) => Promise<JavaTypeMembersMetadata>) {
  const position = marked.indexOf('|')
  const feature = createJavaParameterInfo(inspect)
  let state = EditorState.create({ doc: marked.replace('|', ''), selection: { anchor: position }, extensions: [java(), psLibraryExtension, feature.extension] })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorView['dispatch']>[0]) {
      const transaction = state.update(spec)
      state = transaction.state
      for (const listener of state.facet(EditorViewClass.updateListener)) listener({ state, view, docChanged: transaction.docChanged } as ViewUpdate)
    },
  } as EditorView
  return { feature, view, tooltip: () => state.facet(showTooltip).filter(Boolean)[0] }
}

const arrays: JavaTypeMembersMetadata = { fingerprint: 'jdk', types: [{ typeName: 'java.util.Arrays', available: true, fields: [], methods: [
  { name: 'sort', returnType: 'void', parameters: [{ name: 'a', typeName: 'int[]' }], isStatic: true },
  { name: 'sort', returnType: 'void', parameters: [{ name: 'a', typeName: 'T[]' }, { name: 'c', typeName: 'Comparator<? super T>' }], isStatic: true },
  { name: 'sort', returnType: 'void', parameters: [], isStatic: false },
] }] }

async function settle() { await Promise.resolve(); await Promise.resolve() }

class Element {
  className = ''
  textContent = ''
  readonly parts: (Element | string)[] = []
  constructor(readonly tag: string) {}
  setAttribute() {}
  append(...parts: (Element | string)[]) { this.parts.push(...parts) }
  get text(): string { return this.textContent + this.parts.map((part) => typeof part === 'string' ? part : part.text).join('') }
}

function render(editor: ReturnType<typeof harness>): Element {
  const original = globalThis.document
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } })
  try { return editor.tooltip()!.create(editor.view).dom as unknown as Element }
  finally { Object.defineProperty(globalThis, 'document', { configurable: true, value: original }) }
}

describe('Java parameter information', () => {
  it('finds the screenshot outer call inside lambda parameter parentheses', () => {
    const editor = harness('class A { void f() { Arrays.sort(nums, (a, |b) -> a - b); } }')
    const call = javaParameterCallAt(editor.view.state)
    expect(call).toMatchObject({ name: 'sort', receiver: 'Arrays', argument: 1 })
  })

  it('counts only direct commas across nested expressions, generics, strings and lambda bodies', () => {
    for (const expression of ['new HashMap<String, Integer>()', 'new int[]{1, 2}', '"a,b"', '(a, b) -> { return a + b; }']) {
      const editor = harness(`class A { void f() { dfs(${expression}, |3); } }`)
      expect(javaParameterCallAt(editor.view.state)).toMatchObject({ name: 'dfs', argument: 1 })
    }
    expect(javaParameterCallAt(harness('class A { void f() { dfs(1, nested(2, |3)); } }').view.state)).toMatchObject({ name: 'nested', argument: 1 })
  })

  it('opens immediately after the opening parenthesis and supports incomplete calls', () => {
    expect(javaParameterCallAt(harness('class A { void f() { dfs(|); } }').view.state)).toMatchObject({ name: 'dfs', argument: 0 })
    expect(javaParameterCallAt(harness('class A { void f() { dfs(1, |').view.state)).toMatchObject({ name: 'dfs', argument: 1 })
  })

  it('does not treat declarations or constructors as method calls', () => {
    for (const source of ['class A { void dfs(int |a) {} }', 'class A { void f() { new ArrayList(|); } }', 'class A { void f() { dfs(1);| } }']) {
      expect(javaParameterCallAt(harness(source).view.state)).toBeNull()
    }
  })

  it('shows typed local overloads, array suffixes and varargs and follows the current argument', () => {
    const editor = harness('class A { void dfs(int a, String values[]) {} void dfs(String... names) {} void f() { dfs(1, |"x"); } }')
    expect(editor.feature.show(editor.view)).toBe(true)
    const dom = render(editor)
    expect(dom.text).toContain('int a, String[] values')
    expect(dom.text).toContain('String... names')
    expect(dom.parts.flatMap((row) => (row as Element).parts).filter((part) => part instanceof Element && part.tag === 'strong').map((part) => (part as Element).text)).toEqual(['String[] values', 'String... names'])
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.toString().lastIndexOf('dfs(') + 4 } })
    expect(render(editor).parts.flatMap((row) => (row as Element).parts).filter((part) => part instanceof Element && part.tag === 'strong').map((part) => (part as Element).text)).toEqual(['int a', 'String... names'])
  })

  it('requests reflected overloads and retains the latest argument position when they arrive', async () => {
    let resolve!: (metadata: JavaTypeMembersMetadata) => void
    let requested: string[] = []
    const editor = harness('class A { void f() { Arrays.sort(|nums, comparator); } }', (names) => { requested = names; return new Promise((done) => { resolve = done }) })
    expect(editor.feature.show(editor.view)).toBe(true)
    expect(requested).toEqual(['java.util.Arrays'])
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.toString().indexOf('comparator') } })
    resolve(arrays)
    await settle()
    expect(render(editor).text).toBe('int[] aT[] a, Comparator<? super T> c')
    expect(render(editor).parts.flatMap((row) => (row as Element).parts).filter((part) => part instanceof Element && part.tag === 'strong').map((part) => (part as Element).text)).toEqual(['Comparator<? super T> c'])
  })

  it('uses available Ps metadata including imported static methods', () => {
    for (const call of ['Ps.sum', 'sum']) {
      const editor = harness(`import static example.Ps.sum;\nclass A { void f() { ${call}(|); } }`)
      editor.view.dispatch({ effects: setPsLibraryMetadata.of({ fingerprint: 'ps', methods: [{ name: 'sum', returnType: 'int', parameters: [{ name: 'values', typeName: 'int...' }] }] }) })
      editor.feature.show(editor.view)
      expect(render(editor).text).toBe('int... values')
    }
  })

  it('Escape closes pending help and ignores a late response', async () => {
    let resolve!: (metadata: JavaTypeMembersMetadata) => void
    const editor = harness('class A { void f() { Arrays.sort(|); } }', () => new Promise((done) => { resolve = done }))
    editor.feature.show(editor.view)
    expect(runScopeHandlers(editor.view, { key: 'Escape', code: 'Escape', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {} } as KeyboardEvent, 'editor')).toBe(true)
    resolve(arrays)
    await settle()
    expect(editor.tooltip()).toBeUndefined()
  })

  it('closes outside the call, refreshes edited calls and discards source-stale asynchronous results', async () => {
    const resolvers: ((metadata: JavaTypeMembersMetadata) => void)[] = []
    const editor = harness('class A { void f() { Arrays.sort(|); } }', () => new Promise((done) => { resolvers.push(done) }))
    editor.feature.show(editor.view)
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    resolvers[0]!(arrays)
    await settle()
    expect(editor.tooltip()).toBeUndefined()
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.toString().indexOf('sort(') + 5 } })
    editor.feature.show(editor.view)
    editor.view.dispatch({ changes: { from: editor.view.state.selection.main.head, insert: 'nums' } })
    resolvers[1]!(arrays)
    await settle()
    expect(render(editor).text).toBe('Loading parameters…')
    expect(resolvers).toHaveLength(3)
    resolvers[2]!(arrays)
    await settle()
    expect(render(editor).text).toContain('int[] a')
  })

  it('supports a selected autocomplete argument without confusing surrounding calls', () => {
    const editor = harness('class A { void dfs(int number) {} void f() { dfs(|number); } }')
    const from = editor.view.state.selection.main.head
    editor.view.dispatch({ selection: { anchor: from, head: from + 'number'.length } })
    expect(editor.feature.show(editor.view)).toBe(true)
    expect(render(editor).text).toBe('int number')
  })

  it('refreshes the latest cursor state when it moves before an edited-call refresh', async () => {
    const resolvers: ((metadata: JavaTypeMembersMetadata) => void)[] = []
    const editor = harness('class A { void f() { Arrays.sort(|nums, comparator); } }', () => new Promise((done) => resolvers.push(done)))
    editor.feature.show(editor.view)
    editor.view.dispatch({ changes: { from: editor.view.state.selection.main.head, insert: 'other' } })
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.toString().indexOf('comparator') } })
    await settle()
    expect(resolvers).toHaveLength(2)
    resolvers[1]!(arrays)
    await settle()
    expect(render(editor).text).toContain('Comparator<? super T> c')
  })

  it('cancels both pending inspection and queued source refresh on editor destruction', async () => {
    const resolvers: ((metadata: JavaTypeMembersMetadata) => void)[] = []
    const editor = harness('class A { void f() { Arrays.sort(|); } }', () => new Promise((done) => resolvers.push(done)))
    editor.feature.show(editor.view)
    editor.view.dispatch({ changes: { from: editor.view.state.selection.main.head, insert: 'nums' } })
    const plugin = (editor.feature.extension as unknown[]).find((extension) => extension instanceof ViewPlugin)
    const lifecycle = (plugin as { create: (view: EditorView) => { destroy: () => void } }).create(editor.view)
    lifecycle.destroy()
    let dispatched = false
    editor.view.dispatch = () => { dispatched = true }
    resolvers[0]!(arrays)
    await settle()
    expect(resolvers).toHaveLength(1)
    expect(dispatched).toBe(false)
  })

  it('inspects declaring types for explicit and wildcard static imports', async () => {
    for (const member of ['sort', '*']) {
      let requested: string[] = []
      const editor = harness(`import static java.util.Arrays.${member};\nclass A { void f() { sort(|nums); } }`, async (names) => { requested = names; return arrays })
      editor.feature.show(editor.view)
      await settle()
      expect(requested).toEqual(['java.util.Arrays'])
      expect(render(editor).text).toContain('int[] a')
      expect(render(editor).parts).toHaveLength(2)
    }
  })

  it('keeps known local signatures ahead of matching static imports', async () => {
    let inspected = false
    const editor = harness('import static java.util.Arrays.*;\nclass A { void sort(String value) {} void f() { sort(|); } }', async () => { inspected = true; return arrays })
    editor.feature.show(editor.view)
    await settle()
    expect(inspected).toBe(false)
    expect(render(editor).text).toBe('String value')
  })

  it('resolves simple and fully qualified same-class receivers to static local methods', () => {
    for (const receiver of ['A', 'example.A']) {
      const editor = harness(`package example;\nclass A { static void dfs(int number) {} void dfs(String value) {} void f() { ${receiver}.dfs(|); } }`)
      editor.feature.show(editor.view)
      expect(render(editor).text).toBe('int number')
    }
    const unrelated = harness('class A { static void dfs(int number) {} void f() { Other.dfs(|); } }')
    unrelated.feature.show(unrelated.view)
    expect(unrelated.tooltip()).toBeUndefined()
    const shadowed = harness('class A { static void dfs(int number) {} void f(Other A) { A.dfs(|); } }')
    shadowed.feature.show(shadowed.view)
    expect(shadowed.tooltip()).toBeUndefined()
  })

  it('shows instance methods inside an anonymous class without treating it as a class qualifier', () => {
    const editor = harness('class A { void f() { new Object() { void dfs(int x) {} void g() { dfs(|); } }; } }')
    editor.feature.show(editor.view)
    expect(render(editor).text).toBe('int x')
  })

  it('keeps local method signatures ahead of imported Ps metadata', () => {
    const editor = harness('import static example.Ps.sum;\nclass A { void sum(String x) {} void f() { sum(|); } }')
    editor.view.dispatch({ effects: setPsLibraryMetadata.of({ fingerprint: 'ps', methods: [{ name: 'sum', returnType: 'int', parameters: [{ name: 'values', typeName: 'int...' }] }] }) })
    editor.feature.show(editor.view)
    expect(render(editor).text).toBe('String x')
  })

  it('does not fabricate signatures for unavailable metadata', async () => {
    const editor = harness('class A { void f() { Unknown.method(|); } }', async () => ({ fingerprint: '', types: [] }))
    expect(editor.feature.show(editor.view)).toBe(true)
    await settle()
    expect(editor.tooltip()).toBeUndefined()
  })
})

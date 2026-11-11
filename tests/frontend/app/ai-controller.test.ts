import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { testMocks } from './lifecycle-mocks'
import {
  LeetcoderApp,
  createBackend,
  dailyProblem,
  deferred,
  file,
  installDom,
  rememberedStorage,
  type DomHarness,
  type FakeElement,
} from './lifecycle-harness'
import type {
  AiGenerateRequest,
  AiGenerateResult,
  BackendClient,
  DailyProblem,
  ProblemFileEntry,
} from '../../../src/backend'
import {
  aiButtonPresentation,
  aiProblemNumber,
  createAiController,
  psSignatures,
  type AiTarget,
} from '../../../src/app/ai-controller'

const javaSource = (body: string): string => `package shane.leetcode.problems.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q1TwoSum {

    public int[] twoSum(int[] nums, int target) {
        return new int[] {secretBodyValue};
    }

    @Test
    public void test() {
${body}
    }
}
`

const stubSource = javaSource('        assertThat()')
const filledSource = javaSource('        assertThat(twoSum(new int[] {1}, 1)).isEmpty();')
const testOnlySource = 'package easy;\n\npublic class Q1TwoSum {\n    @Test\n    public void test() {\n        assertThat()\n    }\n}\n'
const noTestSource = 'package easy;\n\npublic class Q1TwoSum {\n    public void twoSum() {\n    }\n}\n'
const classlessSource = 'package easy;\n'
const statements = ['assertThat(twoSum(new int[]{2, 7}, 9)).containsExactly(0, 1);']

const otherFile: ProblemFileEntry = {
  path: 'src/main/java/easy/Q9Palindrome.java',
  name: 'Q9Palindrome.java',
  packageSegment: 'easy',
}

const problemOne: DailyProblem = {
  ...dailyProblem,
  content: '<p>Example 1: nums = [2,7], target = 9. Output: [0,1]</p>',
  javaSnippet: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n    }\n}',
}

/** A problem the app has loaded, which the daily request only accepts with today's date. */
const loaded = (problem: DailyProblem): DailyProblem => ({
  ...problem,
  date: new Date().toISOString().slice(0, 10),
})

const okResult: AiGenerateResult = {
  outcome: 'ok',
  statements,
  servedModel: 'claude-sonnet-5-5',
  fellBack: false,
}

describe('AI test generation button', () => {
  let dom: DomHarness
  let app: LeetcoderApp | null = null

  beforeEach(() => {
    dom = installDom()
  })

  afterEach(async () => {
    await app?.destroy()
    app = null
    dom.restore()
  })

  function configuredBackend(source = stubSource): BackendClient {
    const { backend } = createBackend()
    vi.mocked(backend.aiStatus).mockResolvedValue({ configured: true })
    vi.mocked(backend.readProblemFile).mockResolvedValue(source)
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded(problemOne))
    vi.mocked(backend.aiGenerateTests).mockResolvedValue(okResult)
    return backend
  }

  async function openApp(backend: BackendClient, storage = rememberedStorage()): Promise<void> {
    app = new LeetcoderApp(dom.root as unknown as HTMLElement, {
      backend,
      storage: storage as unknown as Storage,
    })
    await app.start()
  }

  const appState = (): { selectedPath: string | null; dirty: boolean; dailyProblem: DailyProblem | null } =>
    (app as unknown as {
      state: { selectedPath: string | null; dirty: boolean; dailyProblem: DailyProblem | null }
    }).state

  async function selectFile(entry: ProblemFileEntry): Promise<void> {
    testMocks.fileViewCallbacks.at(-1)?.onFileSelect(entry)
    await vi.waitFor(() => {
      expect(appState().selectedPath).toBe(entry.path)
    })
  }

  async function openStub(backend: BackendClient, source = stubSource): Promise<void> {
    vi.mocked(backend.readProblemFile).mockResolvedValue(source)
    await openApp(backend)
    await selectFile(file)
  }

  const button = (): FakeElement => dom.root.querySelector<FakeElement>('#ai-generate-tests')
  const editor = (): (typeof testMocks.editorInstances)[number] => testMocks.editorInstances[0]
  const lastToast = (): (typeof testMocks.toasts)[number] | undefined => testMocks.toasts.at(-1)

  /** Click and wait for the request to finish, whichever way it finishes. */
  async function clickAndSettle(): Promise<void> {
    button().dispatch('click')
    expect(button().attributes.get('aria-busy')).toBe('true')
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })
  }

  it('opens the LLM settings tab without any network call or toast when no key is saved', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiStatus).mockResolvedValue({ configured: false })
    await openStub(backend)

    await clickAndSettle()

    expect(backend.fetchProblemBySlug).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()).toBeUndefined()
    expect(testMocks.settingsSections).toEqual(['llm'])
  })

  it('makes no call and says why when the file has neither test() nor a class', async () => {
    const backend = configuredBackend()
    await openStub(backend, classlessSource)

    await clickAndSettle()

    expect(backend.fetchProblemBySlug).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no test() method')
  })

  it.each([
    ['filled', filledSource],
    ['missing', noTestSource],
  ])('opens the failing case dialog instead of calling when test() is %s', async (_case, source) => {
    const backend = configuredBackend()
    await openStub(backend, source)

    button().dispatch('click')

    expect(dom.root.querySelector<FakeElement>('#ai-case-dialog').hidden).toBe(false)
    expect(dom.root.querySelector<FakeElement>('#ai-case-file').textContent).toBe('Q1TwoSum.java')
    expect(backend.aiStatus).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(editor().source).toBe(source)
  })

  it('fills the stub, marks the file dirty, and sends only the allowed fields', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.inspectPsLibrary).mockResolvedValue({
      fingerprint: 'ps',
      methods: [{
        name: 'intArray',
        returnType: 'int[][]',
        parameters: [{ name: null, typeName: 'String' }],
      }],
    })
    const storage = rememberedStorage()
    storage.setItem('leetcoder.llm-model.anthropic', 'claude-opus-5')
    vi.mocked(backend.readProblemFile).mockResolvedValue(stubSource)
    await openApp(backend, storage)
    await selectFile(file)

    await clickAndSettle()

    const request = vi.mocked(backend.aiGenerateTests).mock.calls[0][0] as AiGenerateRequest
    expect(request).toEqual({
      selectedModelId: 'claude-opus-5',
      problemTitle: problemOne.title,
      problemContent: problemOne.content,
      entryPoint: 'public int[] twoSum(int[] nums, int target)',
      javaSnippet: problemOne.javaSnippet,
      methodHeaders: ['public int[] twoSum(int[] nums, int target)'],
      psSignatures: ['int[][] Ps.intArray(String)'],
    })
    expect(JSON.stringify(request)).not.toContain('secretBodyValue')
    expect(JSON.stringify(request)).not.toContain('src/main/java')

    expect(editor().source).toContain(`        ${statements[0]}\n    }`)
    expect(editor().source).not.toContain('assertThat()')
    expect(appState().dirty).toBe(true)
    expect(lastToast()).toMatchObject({ message: 'Filled test() in Q1TwoSum.java.', tone: 'success' })
    expect(testMocks.settingsSections).toEqual([])
  })

  it('sends no helpers when the Ps library is unavailable', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.inspectPsLibrary).mockRejectedValue(new Error('no classpath'))
    await openStub(backend)

    await clickAndSettle()

    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].psSignatures).toEqual([])
    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].selectedModelId).toBeNull()
  })

  it('uses the loaded problem and sends no LeetCode request when it matches the open file', async () => {
    const backend = configuredBackend()
    await openStub(backend)
    expect(appState().dailyProblem?.frontendId).toBe('1')
    const dailyRequests = vi.mocked(backend.fetchDailyProblem).mock.calls.length

    await clickAndSettle()

    expect(backend.fetchProblemBySlug).not.toHaveBeenCalled()
    expect(backend.fetchDailyProblem).toHaveBeenCalledTimes(dailyRequests)
    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].problemContent).toBe(problemOne.content)
  })

  it('sends nothing and names both problems when another problem is loaded', async () => {
    const backend = configuredBackend()
    const header = loaded({ ...problemOne, frontendId: '9', title: 'Palindrome', content: '<p>Other</p>' })
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(header)
    await openStub(backend)
    const dailyRequests = vi.mocked(backend.fetchDailyProblem).mock.calls.length

    await clickAndSettle()

    expect(backend.fetchProblemBySlug).not.toHaveBeenCalled()
    expect(backend.fetchDailyProblem).toHaveBeenCalledTimes(dailyRequests)
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()).toMatchObject({
      message: 'This file is problem #1, but problem #9 is loaded. Paste the URL for #1 in the header, then try again.',
      tone: 'error',
    })
    expect(appState().dailyProblem).toEqual(header)
    expect(editor().source).toBe(stubSource)
  })

  it('sends nothing and says so when no problem is loaded', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockRejectedValue(new Error('Network down'))
    await openStub(backend)
    expect(appState().dailyProblem).toBeNull()
    const dailyRequests = vi.mocked(backend.fetchDailyProblem).mock.calls.length

    await clickAndSettle()

    expect(backend.fetchProblemBySlug).not.toHaveBeenCalled()
    expect(backend.fetchDailyProblem).toHaveBeenCalledTimes(dailyRequests)
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()).toMatchObject({
      message: 'This file is problem #1, but no problem is loaded. Paste the URL for #1 in the header, then try again.',
      tone: 'error',
    })
  })

  it('checks the stub before the loaded problem', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, frontendId: '9' }))
    await openStub(backend, filledSource)

    await clickAndSettle()

    expect(lastToast()?.message).toContain('already has code')
  })

  it('makes no generation call when the loaded problem has no content', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, content: null }))
    await openStub(backend)

    await clickAndSettle()

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no description')
    expect(lastToast()?.tone).toBe('error')
    expect(editor().source).toBe(stubSource)
  })

  it.each([
    ['a comment', 'class Solution {\n    // Solution(int[] nums) {\n    public int f() {\n    }\n}', 'public int f()'],
    ['a parameter type', 'class Solution {\n    public int f(Solution other) {\n    }\n}', 'public int f(Solution other)'],
  ])('still generates when %s only mentions the class name', async (_case, javaSnippet, entryPoint) => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, javaSnippet }))
    await openStub(backend)

    await clickAndSettle()

    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].entryPoint).toBe(entryPoint)
  })

  it.each([
    ['a class of its own', 'class LRUCache {\n    public int get(int key) {\n    }\n}'],
    ['a Solution constructor', 'class Solution {\n    public Solution(int[] nums) {\n    }\n    public int[] reset() {\n    }\n}'],
  ])('generates for a design problem with %s, before the file declares it', async (_case, javaSnippet) => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, javaSnippet }))
    await openStub(backend, testOnlySource)

    await clickAndSettle()

    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0]).toMatchObject({
      entryPoint: null,
      javaSnippet,
      methodHeaders: [],
    })
  })

  it('makes no call for a file with only tests when the snippet has one method', async () => {
    const backend = configuredBackend()
    await openStub(backend, testOnlySource)

    await clickAndSettle()

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toBe('Q1TwoSum.java has no method to test. No request was sent.')
    expect(lastToast()?.tone).toBe('error')
    expect(editor().source).toBe(testOnlySource)
  })

  it('makes no call for a test-only file when the problem has no snippet', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, javaSnippet: null }))
    await openStub(backend, testOnlySource)

    await clickAndSettle()

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no method to test')
  })

  it('makes no call when the methods are removed during the key status check', async () => {
    const backend = configuredBackend()
    const status = deferred<{ configured: boolean }>()
    await openStub(backend)
    vi.mocked(backend.aiStatus).mockClear()
    vi.mocked(backend.aiStatus).mockReturnValue(status.promise)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiStatus).toHaveBeenCalledOnce()
    })

    editor().emitChange(testOnlySource)
    status.resolve({ configured: true })
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no method to test')
  })

  it('still generates from the document when the problem has no snippet', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, javaSnippet: null }))
    await openStub(backend)

    await clickAndSettle()

    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0]).toMatchObject({
      entryPoint: null,
      methodHeaders: ['public int[] twoSum(int[] nums, int target)'],
    })
  })

  it('makes one call for repeated clicks and shows progress while it runs', async () => {
    const backend = configuredBackend()
    const generation = deferred<AiGenerateResult>()
    vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
    await openStub(backend)
    expect(button().disabled).toBe(false)

    button().dispatch('click')
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    })
    button().dispatch('click')

    expect(button().disabled).toBe(true)
    expect(button().attributes.get('aria-busy')).toBe('true')
    expect(button().title).toContain('Q1TwoSum.java')
    expect(button().dataset.icon).toBe('loader')
    expect(appState()).not.toMatchObject({ busy: true })

    generation.resolve(okResult)
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })
    expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    expect(button().dataset.icon).toBe('sparkles')
  })

  it('discards the result and says the call was charged when the file changes mid-request', async () => {
    const backend = configuredBackend()
    const generation = deferred<AiGenerateResult>()
    vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
    await openStub(backend)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    })

    const otherStub = stubSource.replaceAll('Q1TwoSum', 'Q9Palindrome')
    vi.mocked(backend.readProblemFile).mockResolvedValue(otherStub)
    await selectFile(otherFile)
    expect(button().title).toContain('Q1TwoSum.java')
    const apply = vi.spyOn(editor(), 'applyAiTests')

    generation.resolve(okResult)
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })

    expect(apply).not.toHaveBeenCalled()
    expect(editor().source).toBe(otherStub)
    expect(lastToast()?.message).toContain('Q1TwoSum.java is no longer the active file, so the result was discarded')
    expect(lastToast()?.message).toContain('still charged')
    expect(button().hidden).toBe(true)
  })

  it('sends nothing when the file changes during the key status check', async () => {
    const backend = configuredBackend()
    const status = deferred<{ configured: boolean }>()
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
    await openStub(backend)
    vi.mocked(backend.aiStatus).mockClear()
    vi.mocked(backend.aiStatus).mockReturnValue(status.promise)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiStatus).toHaveBeenCalledOnce()
    })

    await selectFile(otherFile)
    status.resolve({ configured: true })
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('no request was sent')
  })

  it('leaves the buffer alone when the stub is filled mid-request', async () => {
    const backend = configuredBackend()
    const generation = deferred<AiGenerateResult>()
    vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
    await openStub(backend)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    })

    editor().emitChange(filledSource)
    generation.resolve(okResult)
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })

    expect(editor().source).toBe(filledSource)
    expect(lastToast()?.message).toContain('test() already has code')
    expect(lastToast()?.message).toContain('still charged')
  })

  it.each([
    ['refused', 'The model declined'],
    ['truncated', 'output limit'],
  ] as const)('shows its own message and tries nothing else when the outcome is %s', async (outcome, message) => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, outcome, statements: [] })
    await openStub(backend)

    await clickAndSettle()

    expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    expect(lastToast()?.message).toContain(message)
    expect(lastToast()?.tone).toBe('error')
    expect(editor().source).toBe(stubSource)
    expect(appState().dirty).toBe(false)
  })

  it('says a refused call may still have been charged', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, outcome: 'refused', statements: [] })
    await openStub(backend)

    await clickAndSettle()

    expect(lastToast()?.message).toContain('may still have been charged')
    expect(lastToast()?.message).toContain('recorded in usage')
  })

  it('names the served model in a toast that stays when the pinned model was unavailable', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, fellBack: true })
    await openStub(backend)

    await clickAndSettle()

    expect(editor().source).toContain(statements[0])
    expect(lastToast()?.message).toContain('selected model is unavailable')
    expect(lastToast()?.message).toContain('claude-sonnet-5-5')
    // Only the error tone stays until dismissed.
    expect(lastToast()?.tone).toBe('error')
  })

  it('fills from statements with whitespace around them', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, statements: [`${statements[0]}  \n`] })
    await openStub(backend)

    await clickAndSettle()

    expect(editor().source).toContain(`        ${statements[0]}\n    }`)
    expect(lastToast()?.tone).toBe('success')
  })

  describe('focus after a fill', () => {
    const focusSpy = () => vi.spyOn(editor(), 'focus').mockClear()

    it('returns to the editor after the statements are in the document', async () => {
      const backend = configuredBackend()
      await openStub(backend)
      const focus = focusSpy()
      const sources: string[] = []
      focus.mockImplementation(() => {
        sources.push(editor().source)
      })

      await clickAndSettle()

      expect(focus).toHaveBeenCalledOnce()
      expect(sources[0]).toContain(statements[0])
    })

    it.each([
      ['the button', (): FakeElement | null => button()],
      ['the body', (): FakeElement | null => dom.document.body],
      ['nothing', (): FakeElement | null => null],
    ])('takes focus from %s', async (_case, active) => {
      const backend = configuredBackend()
      await openStub(backend)
      const focus = focusSpy()
      dom.document.activeElement = active()

      await clickAndSettle()

      expect(focus).toHaveBeenCalledOnce()
    })

    it('leaves focus alone when it moved to another control during the request', async () => {
      const backend = configuredBackend()
      const generation = deferred<AiGenerateResult>()
      vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
      await openStub(backend)
      const focus = focusSpy()
      button().focus()
      button().dispatch('click')
      await vi.waitFor(() => {
        expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      })

      const input = dom.root.querySelector<FakeElement>('#file-search')
      input.focus()
      generation.resolve(okResult)
      await vi.waitFor(() => {
        expect(button().attributes.get('aria-busy')).toBe('false')
      })

      expect(editor().source).toContain(statements[0])
      expect(focus).not.toHaveBeenCalled()
      expect(dom.document.activeElement).toBe(input)
    })

    it('leaves focus alone while a dialog is open, even with nothing focused in it', async () => {
      const backend = configuredBackend()
      await openStub(backend)
      const focus = focusSpy()
      const queryAll = dom.root.querySelectorAll.bind(dom.root)
      vi.spyOn(dom.root, 'querySelectorAll').mockImplementation(<T extends FakeElement = FakeElement>(selector: string): T[] =>
        selector === '.dialog-backdrop:not([hidden])' ? [dom.root.querySelector<T>('#settings-dialog')] : queryAll<T>(selector))
      dom.document.activeElement = dom.document.body

      await clickAndSettle()

      expect(editor().source).toContain(statements[0])
      expect(focus).not.toHaveBeenCalled()
    })

    it.each([
      ['a rejected result', { ...okResult, statements: ['foo()'] }],
      ['a refusal', { ...okResult, outcome: 'refused' as const, statements: [] }],
      ['a truncated result', { ...okResult, outcome: 'truncated' as const, statements: [] }],
    ])('does not take focus after %s', async (_case, result) => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockResolvedValue(result)
      await openStub(backend)
      const focus = focusSpy()

      await clickAndSettle()

      expect(editor().source).toBe(stubSource)
      expect(focus).not.toHaveBeenCalled()
    })

    it('does not take focus when no call was made or the call failed', async () => {
      const backend = configuredBackend()
      await openStub(backend, classlessSource)
      const focus = focusSpy()
      await clickAndSettle()

      vi.mocked(backend.aiGenerateTests).mockRejectedValue(new Error('Network down'))
      editor().emitChange(stubSource)
      await clickAndSettle()

      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      expect(focus).not.toHaveBeenCalled()
    })
  })

  describe('usage after a generation', () => {
    it.each([
      ['a fill', () => Promise.resolve(okResult)],
      ['a refusal', () => Promise.resolve({ ...okResult, outcome: 'refused' as const, statements: [] })],
      ['a rejected result', () => Promise.resolve({ ...okResult, statements: ['foo()'] })],
      ['a failed call', () => Promise.reject(new Error('Network down'))],
    ])('reloads an open LLM tab after %s', async (_case, generate) => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockImplementation(generate)
      await openStub(backend)

      await clickAndSettle()

      expect(backend.aiUsage).toHaveBeenCalledOnce()
    })

    it.each(['#settings-dialog', '#settings-llm-panel'])('leaves usage alone while %s is hidden', async (selector) => {
      const backend = configuredBackend()
      await openStub(backend)
      dom.root.querySelector<FakeElement>(selector).hidden = true

      await clickAndSettle()

      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      expect(backend.aiUsage).not.toHaveBeenCalled()
    })

    it('does not reload when no paid call was made', async () => {
      const backend = configuredBackend()
      await openStub(backend, classlessSource)

      await clickAndSettle()

      expect(backend.aiGenerateTests).not.toHaveBeenCalled()
      expect(backend.aiUsage).not.toHaveBeenCalled()
    })
  })

  it.each([
    ['a missing semicolon', ['assertThat(leakedModelOutput).isTrue()'], 'did not end in a single semicolon'],
    ['added members', ['} void leakedModelOutput() {'], 'unbalanced brackets'],
    ['no statements', [], 'no statements'],
  ])('rejects %s without dumping the output', async (_case, rejected, message) => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, statements: rejected })
    await openStub(backend)

    await clickAndSettle()

    expect(editor().source).toBe(stubSource)
    expect(appState().dirty).toBe(false)
    expect(lastToast()?.message).toContain(message)
    expect(lastToast()?.message).toContain('Q1TwoSum.java was not changed')
    expect(lastToast()?.message).toContain('still charged')
    expect(lastToast()?.message).not.toContain('leakedModelOutput')
  })

  it('shows a readable backend error and allows another try', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiGenerateTests).mockRejectedValueOnce(new Error('The provider is rate limiting this key (429).'))
    await openStub(backend)

    await clickAndSettle()

    expect(lastToast()).toMatchObject({
      message: 'Could not generate tests: The provider is rate limiting this key (429).',
      tone: 'error',
    })
    expect(editor().source).toBe(stubSource)

    await clickAndSettle()
    expect(backend.aiGenerateTests).toHaveBeenCalledTimes(2)
    expect(editor().source).toContain(statements[0])
  })

  it('shows a status failure as an error and sends nothing', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.aiStatus).mockRejectedValue(new Error('Could not read the key file.'))
    await openStub(backend)

    await clickAndSettle()

    expect(lastToast()?.message).toBe('Could not read the API key status: Could not read the key file.')
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
  })

  describe('visibility', () => {
    it('stays hidden until the open file is the loaded problem', async () => {
      const backend = configuredBackend()
      const scratch: ProblemFileEntry = { path: 'src/main/java/Scratch.java', name: 'Scratch.java', packageSegment: 'other' }
      const kotlin: ProblemFileEntry = { path: 'src/main/java/Q1TwoSum.kt', name: 'Q1TwoSum.kt', packageSegment: 'other' }
      vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile, scratch, kotlin])
      await openApp(backend)
      expect(button().hidden).toBe(true)

      for (const other of [scratch, kotlin, otherFile]) {
        await selectFile(other)
        expect(button().hidden).toBe(true)
      }

      await selectFile(file)
      expect(button().hidden).toBe(false)
      expect(button().disabled).toBe(false)
      expect(button().title).toBe('Generate tests for Q1TwoSum.java with AI')
    })

    it('stays hidden when the loaded problem has no description', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, content: '  ' }))
      await openStub(backend)

      expect(button().hidden).toBe(true)
    })

    it('stays hidden when the file has no class to add a test to', async () => {
      for (const source of [classlessSource, '']) {
        const backend = configuredBackend()
        await openStub(backend, source)
        expect(button().hidden).toBe(true)
        await app?.destroy()
      }
    })

    it('follows edits to test()', async () => {
      await openStub(configuredBackend())
      expect(button().title).toBe('Generate tests for Q1TwoSum.java with AI')

      editor().emitChange(filledSource)
      expect(button().title).toBe('Add a failing case to Q1TwoSum.java as a new test with AI')

      editor().emitChange(classlessSource)
      expect(button().hidden).toBe(true)

      editor().emitChange(stubSource)
      expect(button().hidden).toBe(false)
      expect(button().title).toBe('Generate tests for Q1TwoSum.java with AI')
    })

    it('switches to adding a case once a fill succeeds', async () => {
      await openStub(configuredBackend())

      await clickAndSettle()

      expect(editor().source).not.toBe(stubSource)
      expect(button().hidden).toBe(false)
      expect(button().title).toBe('Add a failing case to Q1TwoSum.java as a new test with AI')
    })

    it('keeps showing progress after switching away from the requested file', async () => {
      const backend = configuredBackend()
      const generation = deferred<AiGenerateResult>()
      vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
      vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
      await openStub(backend)
      button().dispatch('click')
      await vi.waitFor(() => {
        expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      })

      await selectFile(otherFile)
      expect(button().hidden).toBe(false)
      expect(button().attributes.get('aria-busy')).toBe('true')

      generation.resolve(okResult)
      await vi.waitFor(() => {
        expect(button().hidden).toBe(true)
      })
    })
  })

  describe('failing case', () => {
    const dialog = (): FakeElement => dom.root.querySelector<FakeElement>('#ai-case-dialog')
    const caseInput = (): FakeElement => dom.root.querySelector<FakeElement>('#ai-case-input')
    const caseFile = (): FakeElement => dom.root.querySelector<FakeElement>('#ai-case-file')
    const pasted = 'a =\n388168\nUse Testcase\nOutput\n1\nExpected\n84755163318'

    function submitCase(text: string): ReturnType<typeof vi.fn> {
      caseInput().value = text
      const preventDefault = vi.fn()
      dom.root.querySelector<FakeElement>('#ai-case-form').dispatch('submit', { preventDefault })
      return preventDefault
    }

    it('shows for any file of the loaded problem with a class, filled test() included', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
      await openStub(backend, filledSource)

      expect(button().hidden).toBe(false)
      expect(button().disabled).toBe(false)
      expect(button().dataset.icon).toBe('sparkles')
      expect(button().title).toBe('Add a failing case to Q1TwoSum.java as a new test with AI')

      editor().emitChange('')
      expect(button().hidden).toBe(true)
      editor().emitChange(noTestSource)
      expect(button().hidden).toBe(false)

      await selectFile(otherFile)
      expect(button().hidden).toBe(true)
    })

    it('switches the one button between filling test() and adding a case', async () => {
      const backend = configuredBackend()
      await openStub(backend)

      expect(button().title).toBe('Generate tests for Q1TwoSum.java with AI')
      button().dispatch('click')
      await vi.waitFor(() => {
        expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      })
      expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0]).not.toHaveProperty('failingCase')
      await vi.waitFor(() => {
        expect(button().attributes.get('aria-busy')).toBe('false')
      })

      expect(button().hidden).toBe(false)
      expect(button().title).toBe('Add a failing case to Q1TwoSum.java as a new test with AI')
      expect(caseFile().textContent).toBe('')
      button().dispatch('click')
      expect(dialog().hidden).toBe(false)
      expect(caseFile().textContent).toBe('Q1TwoSum.java')
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    })

    it('stays hidden when the loaded problem has no description', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.fetchDailyProblem).mockResolvedValue(loaded({ ...problemOne, content: null }))
      await openStub(backend, filledSource)

      expect(button().hidden).toBe(true)
    })

    it('opens the dialog without sending anything, and cancel sends nothing either', async () => {
      const backend = configuredBackend()
      await openStub(backend, filledSource)
      vi.mocked(backend.aiStatus).mockClear()

      button().dispatch('click')
      expect(dialog().hidden).toBe(false)
      expect(dom.root.querySelector<FakeElement>('#ai-case-file').textContent).toBe('Q1TwoSum.java')

      dom.root.querySelector<FakeElement>('#cancel-ai-case').dispatch('click')
      expect(dialog().hidden).toBe(true)
      expect(backend.aiStatus).not.toHaveBeenCalled()
      expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    })

    it('sends nothing for an empty paste and keeps the dialog open', async () => {
      const backend = configuredBackend()
      await openStub(backend, filledSource)
      button().dispatch('click')

      expect(submitCase('  \n ')).toHaveBeenCalledOnce()

      expect(dialog().hidden).toBe(false)
      expect(backend.aiGenerateTests).not.toHaveBeenCalled()
      expect(lastToast()).toMatchObject({ message: 'Paste the failing case first.', tone: 'error' })
    })

    it('sends the trimmed case on confirm and adds test2() after test()', async () => {
      const backend = configuredBackend()
      await openStub(backend, filledSource)
      button().dispatch('click')

      expect(submitCase(`\n${pasted}\n\n`)).toHaveBeenCalledOnce()
      expect(dialog().hidden).toBe(true)
      await vi.waitFor(() => {
        expect(lastToast()).toMatchObject({ message: 'Added test2() to Q1TwoSum.java.', tone: 'success' })
      })

      expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0]).toMatchObject({
        failingCase: pasted,
        methodHeaders: ['public int[] twoSum(int[] nums, int target)'],
      })
      expect(editor().source).toContain(
        `    @Test\n    public void test2() {\n        ${statements[0]}\n    }\n}\n`,
      )
      expect(editor().source).toContain('assertThat(twoSum(new int[] {1}, 1)).isEmpty();')
      expect(appState().dirty).toBe(true)
      expect(button().hidden).toBe(false)
    })

    it('sends no failingCase field from the examples button', async () => {
      const backend = configuredBackend()
      await openStub(backend)

      await clickAndSettle()

      expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0]).not.toHaveProperty('failingCase')
    })

    it('runs one request at a time', async () => {
      const backend = configuredBackend()
      const generation = deferred<AiGenerateResult>()
      vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)
      await vi.waitFor(() => {
        expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      })

      expect(button().attributes.get('aria-busy')).toBe('true')
      expect(button().dataset.icon).toBe('loader')
      expect(button().title).toBe('Adding a failing case to Q1TwoSum.java…')
      button().dispatch('click')
      expect(dialog().hidden).toBe(true)

      generation.resolve(okResult)
      await vi.waitFor(() => {
        expect(button().attributes.get('aria-busy')).toBe('false')
      })
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      expect(button().disabled).toBe(false)
      expect(button().dataset.icon).toBe('sparkles')
    })

    it('discards the result when the file changes mid-request', async () => {
      const backend = configuredBackend()
      const generation = deferred<AiGenerateResult>()
      vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
      vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)
      await vi.waitFor(() => {
        expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
      })

      const otherSource = filledSource.replaceAll('Q1TwoSum', 'Q9Palindrome')
      vi.mocked(backend.readProblemFile).mockResolvedValue(otherSource)
      await selectFile(otherFile)
      const apply = vi.spyOn(editor(), 'applyAiCaseTest')

      generation.resolve(okResult)
      await vi.waitFor(() => {
        expect(button().attributes.get('aria-busy')).toBe('false')
      })

      expect(apply).not.toHaveBeenCalled()
      expect(editor().source).toBe(otherSource)
      expect(lastToast()?.message).toContain('Q1TwoSum.java is no longer the active file, so the result was discarded')
    })

    it('rejects statements that would leave the new method and changes nothing', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, statements: ['foo bar baz();'] })
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)

      await vi.waitFor(() => {
        expect(lastToast()?.message).toContain('The result was rejected because')
      })
      expect(editor().source).toBe(filledSource)
    })
  })

  it('drops a result that arrives after the app is destroyed', async () => {
    const backend = configuredBackend()
    const generation = deferred<AiGenerateResult>()
    vi.mocked(backend.aiGenerateTests).mockReturnValue(generation.promise)
    await openStub(backend)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiGenerateTests).toHaveBeenCalledOnce()
    })
    const toastCount = testMocks.toasts.length

    await app?.destroy()
    generation.resolve(okResult)
    await new Promise((resolve) => setTimeout(resolve))

    expect(editor().source).toBe(stubSource)
    expect(testMocks.toasts).toHaveLength(toastCount)
  })
})

describe('AI controller helpers', () => {
  it('reads the problem number from Java Q-numbered file names only', () => {
    expect(aiProblemNumber('src/easy/Q1TwoSum.java')).toBe('1')
    expect(aiProblemNumber('src/easy/Q3_3Sum2.java')).toBe('3')
    expect(aiProblemNumber('src/easy/Q0012Foo.java')).toBe('12')
    expect(aiProblemNumber('src/easy/Q1TwoSum.kt')).toBeNull()
    expect(aiProblemNumber('src/easy/QuickSort.java')).toBeNull()
    expect(aiProblemNumber('src/easy/Q0.java')).toBeNull()
    expect(aiProblemNumber(null)).toBeNull()
  })

  it('never names a shortcut in the button title', () => {
    for (const presentation of [
      aiButtonPresentation('src/Q1TwoSum.java', null, null, false, problemOne, 'bare', false),
      aiButtonPresentation('src/Q1TwoSum.java', 'src/Q1TwoSum.java', 'examples', false, problemOne, 'bare', false),
      aiButtonPresentation('src/Q1TwoSum.java', null, null, true, problemOne, 'bare', false),
      aiButtonPresentation('src/Q1TwoSum.kt', null, null, false, problemOne, 'bare', false),
      aiButtonPresentation(null, null, null, false, problemOne, 'bare', false),
    ]) {
      expect(presentation.title).not.toMatch(/Alt\+|Ctrl\+|⌘/)
    }
    expect(aiButtonPresentation('src/Q1TwoSum.java', null, null, true, problemOne, 'bare', false)).toMatchObject({
      hidden: false,
      disabled: true,
    })
    expect(aiButtonPresentation('src/Q1TwoSum.kt', null, null, false, problemOne, 'bare', false).hidden).toBe(true)
  })

  it('formats no signatures without library metadata', () => {
    expect(psSignatures(null)).toEqual([])
  })

  it('discards a result when only the repository generation changed', async () => {
    const target: AiTarget = { repoPath: '/repo', path: 'src/Q1TwoSum.java', repositoryGeneration: 1 }
    let current = target
    const generation = deferred<AiGenerateResult>()
    const applyStatements = vi.fn()
    const showMessage = vi.fn()
    const focusEditor = vi.fn()
    const generationFinished = vi.fn()
    const controller = createAiController(
      {
        aiStatus: async () => ({ configured: true }),
        aiGenerateTests: () => generation.promise,
        currentTarget: () => current,
        headerProblem: () => problemOne,
        readContext: () => ({ stub: 'bare', methodHeaders: ['int f()'], canAddCase: true }),
        selectedModelId: () => null,
        psSignatures: () => [],
        applyStatements,
        applyCaseStatements: vi.fn(),
        focusEditor,
      },
      { requestChanged: () => {}, showMessage, showMissingKey: () => {}, generationFinished },
    )

    const finished = controller.generate()
    expect(controller.requestPath).toBe('src/Q1TwoSum.java')
    await new Promise((resolve) => setTimeout(resolve))
    current = { ...target, repositoryGeneration: 2 }
    generation.resolve(okResult)
    await finished

    expect(applyStatements).not.toHaveBeenCalled()
    expect(showMessage.mock.calls[0][0]).toContain('discarded')
    expect(focusEditor).not.toHaveBeenCalled()
    expect(generationFinished).toHaveBeenCalledOnce()
    expect(controller.requestPath).toBeNull()
  })
})

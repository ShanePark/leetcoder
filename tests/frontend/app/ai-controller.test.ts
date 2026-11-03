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
    vi.mocked(backend.fetchProblemByNumber).mockResolvedValue(problemOne)
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

    expect(backend.fetchProblemByNumber).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()).toBeUndefined()
    expect(testMocks.settingsSections).toEqual(['llm'])
  })

  it('makes no call and says why when test() is missing', async () => {
    const backend = configuredBackend()
    await openStub(backend, noTestSource)

    await clickAndSettle()

    expect(backend.fetchProblemByNumber).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no test() method')
  })

  it('makes no call and says why when test() is already filled', async () => {
    const backend = configuredBackend()
    await openStub(backend, filledSource)

    await clickAndSettle()

    expect(backend.fetchProblemByNumber).not.toHaveBeenCalled()
    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('already has code')
    expect(editor().source).toBe(filledSource)
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

  it('reuses the header problem when it matches the open file', async () => {
    const backend = configuredBackend()
    const today = new Date().toISOString().slice(0, 10)
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue({ ...problemOne, date: today })
    await openStub(backend)
    expect(appState().dailyProblem?.frontendId).toBe('1')

    await clickAndSettle()

    expect(backend.fetchProblemByNumber).not.toHaveBeenCalled()
    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].problemContent).toBe(problemOne.content)
  })

  it('follows the open file and leaves the header alone when the header shows another problem', async () => {
    const backend = configuredBackend()
    const today = new Date().toISOString().slice(0, 10)
    const header = { ...problemOne, date: today, frontendId: '9', title: 'Palindrome', content: '<p>Other</p>' }
    vi.mocked(backend.fetchDailyProblem).mockResolvedValue(header)
    await openStub(backend)

    await clickAndSettle()

    expect(backend.fetchProblemByNumber).toHaveBeenCalledWith('1')
    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].problemContent).toBe(problemOne.content)
    expect(appState().dailyProblem).toEqual(header)
  })

  it.each([
    ['a failed lookup', () => Promise.reject(new Error('Network down')), 'Could not load problem #1: Network down'],
    ['no content', () => Promise.resolve({ ...problemOne, content: null }), 'has no description'],
  ])('makes no generation call after %s', async (_case, lookup, message) => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchProblemByNumber).mockImplementation(lookup)
    await openStub(backend)

    await clickAndSettle()

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain(message)
    expect(lastToast()?.tone).toBe('error')
    expect(editor().source).toBe(stubSource)
  })

  it.each([
    ['a comment', 'class Solution {\n    // Solution(int[] nums) {\n    public int f() {\n    }\n}', 'public int f()'],
    ['a parameter type', 'class Solution {\n    public int f(Solution other) {\n    }\n}', 'public int f(Solution other)'],
  ])('still generates when %s only mentions the class name', async (_case, javaSnippet, entryPoint) => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchProblemByNumber).mockResolvedValue({ ...problemOne, javaSnippet })
    await openStub(backend)

    await clickAndSettle()

    expect(vi.mocked(backend.aiGenerateTests).mock.calls[0][0].entryPoint).toBe(entryPoint)
  })

  it.each([
    ['a class of its own', 'class LRUCache {\n    public int get(int key) {\n    }\n}'],
    ['a Solution constructor', 'class Solution {\n    public Solution(int[] nums) {\n    }\n    public int[] reset() {\n    }\n}'],
  ])('generates for a design problem with %s, before the file declares it', async (_case, javaSnippet) => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchProblemByNumber).mockResolvedValue({ ...problemOne, javaSnippet })
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
    vi.mocked(backend.fetchProblemByNumber).mockResolvedValue({ ...problemOne, javaSnippet: null })
    await openStub(backend, testOnlySource)

    await clickAndSettle()

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no method to test')
  })

  it('makes no call when the methods are removed during the problem lookup', async () => {
    const backend = configuredBackend()
    const lookup = deferred<DailyProblem>()
    vi.mocked(backend.fetchProblemByNumber).mockReturnValue(lookup.promise)
    await openStub(backend)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.fetchProblemByNumber).toHaveBeenCalledOnce()
    })

    editor().emitChange(testOnlySource)
    lookup.resolve(problemOne)
    await vi.waitFor(() => {
      expect(button().attributes.get('aria-busy')).toBe('false')
    })

    expect(backend.aiGenerateTests).not.toHaveBeenCalled()
    expect(lastToast()?.message).toContain('has no method to test')
  })

  it('still generates from the document when the problem has no snippet', async () => {
    const backend = configuredBackend()
    vi.mocked(backend.fetchProblemByNumber).mockResolvedValue({ ...problemOne, javaSnippet: null })
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
    expect(button().disabled).toBe(false)
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
    expect(button().title).toContain('Q9Palindrome.java')
  })

  it('sends nothing when the file changes during the problem lookup', async () => {
    const backend = configuredBackend()
    const lookup = deferred<DailyProblem>()
    vi.mocked(backend.fetchProblemByNumber).mockReturnValue(lookup.promise)
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
    await openStub(backend)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.fetchProblemByNumber).toHaveBeenCalledOnce()
    })

    await selectFile(otherFile)
    lookup.resolve(problemOne)
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
      await openStub(backend, filledSource)
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
      await openStub(backend, filledSource)

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

  it('stays disabled with a reason until a Q-numbered Java file is open', async () => {
    const backend = configuredBackend()
    const scratch: ProblemFileEntry = { path: 'src/main/java/Scratch.java', name: 'Scratch.java', packageSegment: 'other' }
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, scratch])
    await openApp(backend)

    expect(button().disabled).toBe(true)
    expect(button().title).toContain('Open a Java problem file')

    await selectFile(scratch)
    expect(button().disabled).toBe(true)
    expect(button().title).toContain('Scratch.java')

    button().dispatch('click')
    await Promise.resolve()
    expect(backend.aiStatus).not.toHaveBeenCalled()

    await selectFile(file)
    expect(button().disabled).toBe(false)
    expect(button().title).toBe('Generate tests for Q1TwoSum.java with AI')
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
      aiButtonPresentation('src/Q1TwoSum.java', null, false),
      aiButtonPresentation('src/Q1TwoSum.java', 'src/Q1TwoSum.java', false),
      aiButtonPresentation('src/Q1TwoSum.java', null, true),
      aiButtonPresentation('src/Q1TwoSum.kt', null, false),
      aiButtonPresentation(null, null, false),
    ]) {
      expect(presentation.title).not.toMatch(/Alt\+|Ctrl\+|⌘/)
    }
    expect(aiButtonPresentation('src/Q1TwoSum.java', null, true).disabled).toBe(true)
    expect(aiButtonPresentation('src/Q1TwoSum.kt', null, false).disabled).toBe(true)
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
        fetchProblemByNumber: async () => problemOne,
        aiGenerateTests: () => generation.promise,
        currentTarget: () => current,
        headerProblem: () => null,
        readContext: () => ({ stub: 'bare', methodHeaders: ['int f()'] }),
        selectedModelId: () => null,
        psSignatures: () => [],
        applyStatements,
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

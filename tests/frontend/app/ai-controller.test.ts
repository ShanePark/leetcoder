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
  AiModelList,
  AiModelPricing,
  AiProblemHelp,
  AiProgressHandler,
  AiRequestUsage,
  AiStreamHandler,
  AiReview,
  AiReviewFollowUpResult,
  AiReviewResult,
  AiStatus,
  TestResult,
  BackendClient,
  DailyProblem,
  ProblemFileEntry,
} from '../../../src/backend'
import {
  MAX_AI_REVIEW_FIELD_LENGTH,
  MAX_AI_REVIEW_TEST_RUN_LENGTH,
  aiButtonPresentation,
  aiProblemNumber,
  aiReviewButtonPresentation,
  aiReviewMode,
  aiReviewTestRun,
  aiReviewTestRunSelection,
  createAiController,
  psSignatures,
  type AiController,
  type AiControllerApi,
  type AiControllerUi,
  type AiReviewModelChoice,
  type AiReviewModelRequest,
  type AiReviewStream,
  type AiTarget,
} from '../../../src/app/ai-controller'
import type { ProgressOverlayState } from '../../../src/app/progress-overlay'
import { AiEditDiffDialog } from '../../../src/app/ai-edit-diff-dialog'

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

const provider = { id: 'anthropic', displayName: 'Claude' }

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
    vi.mocked(backend.aiStatus).mockResolvedValue({ configured: true, provider })
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
    vi.mocked(backend.aiStatus).mockResolvedValue({ configured: false, provider })
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
    const status = deferred<AiStatus>()
    await openStub(backend)
    vi.mocked(backend.aiStatus).mockClear()
    vi.mocked(backend.aiStatus).mockReturnValue(status.promise)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiStatus).toHaveBeenCalledOnce()
    })

    editor().emitChange(testOnlySource)
    status.resolve({ configured: true, provider })
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
    // The filled test() turns the button into the add-case action.
    expect(button().dataset.icon).toBe('circlePlus')
    expect(button().dataset.text).toBe('Add case')
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
    const status = deferred<AiStatus>()
    vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
    await openStub(backend)
    vi.mocked(backend.aiStatus).mockClear()
    vi.mocked(backend.aiStatus).mockReturnValue(status.promise)
    button().dispatch('click')
    await vi.waitFor(() => {
      expect(backend.aiStatus).toHaveBeenCalledOnce()
    })

    await selectFile(otherFile)
    status.resolve({ configured: true, provider })
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
      expect(button().dataset.icon).toBe('circlePlus')
      expect(button().dataset.text).toBe('Add case')
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
      expect(button().dataset.icon).toBe('circlePlus')
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

    it('explains an empty result in terms of a pasted or described case', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, statements: [] })
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)

      await vi.waitFor(() => {
        expect(lastToast()?.message).toContain(
          'the case may lack an input or Expected value without asking for a time-limit case',
        )
      })
      expect(editor().source).toBe(filledSource)
    })

    it('starts the next case from an empty field once a case was added', async () => {
      const backend = configuredBackend()
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)
      await vi.waitFor(() => {
        expect(lastToast()).toMatchObject({ message: 'Added test2() to Q1TwoSum.java.' })
      })

      button().dispatch('click')
      expect(dialog().hidden).toBe(false)
      expect(caseInput().value).toBe('')
    })

    it('keeps the pasted case when it could not be added', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockResolvedValue({ ...okResult, outcome: 'refused', statements: [] })
      await openStub(backend, filledSource)
      button().dispatch('click')
      submitCase(pasted)
      await vi.waitFor(() => {
        expect(lastToast()?.message).toContain('The model declined')
      })

      button().dispatch('click')
      expect(caseInput().value).toBe(pasted)
    })
  })

  describe('progress popup', () => {
    it('shows the stages while generating and closes before the result toast', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockImplementation(async (_request, onProgress) => {
        onProgress?.({ stage: 'requesting', model: 'model-x' })
        onProgress?.({ stage: 'received' })
        return okResult
      })
      await openStub(backend)

      await clickAndSettle()

      const states = testMocks.progressOverlays
      expect(states[0]).toMatchObject({ kicker: 'AI tests', title: 'Generating tests', current: 0 })
      expect(states).toContainEqual(expect.objectContaining({
        current: 1,
        stages: ['Reading the problem', { label: 'Asking Claude', detail: 'model-x' }, 'Writing tests'],
      }))
      expect(states).toContainEqual(expect.objectContaining({ current: 2 }))
      expect(states.at(-1)).toBeNull()
      expect(lastToast()?.message).toBe('Filled test() in Q1TwoSum.java.')
    })

    it('closes after an error', async () => {
      const backend = configuredBackend()
      vi.mocked(backend.aiGenerateTests).mockRejectedValue(new Error('HTTP 500'))
      await openStub(backend)

      await clickAndSettle()

      expect(testMocks.progressOverlays.length).toBeGreaterThan(1)
      expect(testMocks.progressOverlays.at(-1)).toBeNull()
      expect(lastToast()).toMatchObject({ message: 'Could not generate tests: HTTP 500', tone: 'error' })
    })
  })

  describe('review', () => {
    const reviewButton = (): FakeElement => dom.root.querySelector<FakeElement>('#ai-review-code')
    const reviewTab = (): FakeElement => dom.root.querySelector<FakeElement>('#review-tab')
    const reviewPanel = (): FakeElement => dom.root.querySelector<FakeElement>('#review-panel')

    function reviewBackend(): BackendClient {
      const backend = configuredBackend()
      vi.mocked(backend.reviewAiCode).mockResolvedValue(reviewResult)
      vi.mocked(backend.aiListModels).mockResolvedValue(reviewModels)
      return backend
    }

    it('shows for the loaded problem file only', async () => {
      const backend = reviewBackend()
      vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
      await openStub(backend, filledSource)

      expect(reviewButton().hidden).toBe(false)
      expect(reviewButton().disabled).toBe(false)
      expect(reviewButton().dataset.icon).toBe('review')
      expect(reviewButton().dataset.text).toBe('AI review')
      expect(reviewButton().title).toBe('Review code with AI')

      await selectFile(otherFile)
      expect(reviewButton().hidden).toBe(true)
    })

    it('offers help while the solution is unimplemented and follows edits', async () => {
      const backend = reviewBackend()
      vi.mocked(backend.reviewAiCode).mockResolvedValue(helpResult)
      const unimplemented = javaSource('        assertThat()').replace('        return new int[] {secretBodyValue};\n', '        // TODO\n')
      await openStub(backend, unimplemented)

      expect(reviewButton().dataset.icon).toBe('lightbulb')
      expect(reviewButton().dataset.text).toBe('AI help')
      expect(reviewButton().title).toBe('Get hints from AI')
      editor().emitChange(filledSource)
      expect(reviewButton().dataset.text).toBe('AI review')
      editor().emitChange(unimplemented)
      expect(reviewButton().dataset.text).toBe('AI help')

      reviewButton().dispatch('click')
      await vi.waitFor(() => {
        expect(picker('title').textContent).toBe('Get help')
      })
      expect(picker('test-run').hidden).toBe(true)
      picker('form').dispatch('submit', { preventDefault: vi.fn() })
      await vi.waitFor(() => {
        expect(reviewTab().attributes.get('aria-selected')).toBe('true')
      })
      expect(vi.mocked(backend.reviewAiCode).mock.calls[0][0]).toMatchObject({ mode: 'help', testRun: null })
      await vi.waitFor(() => {
        expect(reviewButton().disabled).toBe(false)
      })
      const main = dom.root.querySelector<FakeElement>('#review-body').children[0].children[2]
      expect(main.children.map((section) => section.children[0]?.textContent)).toEqual(['Overview', 'Key points', 'Hints'])
      expect((dom.root.querySelector<FakeElement>('#review-follow-up-input') as unknown as { placeholder: string }).placeholder)
        .toBe('Ask about this problem (Shift+Enter for a new line)')
    })

    const picker = (selector: string): FakeElement => dom.root.querySelector<FakeElement>(`#ai-review-model-${selector}`)
    type FakeRadio = FakeElement & { checked?: boolean }
    const pickerRows = (): FakeElement[] => picker('list').children
    const pickerRadios = (): FakeRadio[] => pickerRows().map((row) => row.children[0] as FakeRadio)
    const pickerNames = (): string[] => pickerRows().map((row) => row.children[1].children[0].textContent)
    const checkedModel = (): string | undefined => pickerRadios().find((radio) => radio.checked)?.value

    /** Click the review button and wait for the model picker to fill. */
    async function openPicker(): Promise<void> {
      picker('test-run').textContent = ''
      reviewButton().dispatch('click')
      await vi.waitFor(() => {
        expect(picker('test-run').textContent).not.toBe('')
      })
    }

    const submitPicker = (): void => {
      picker('form').dispatch('submit', { preventDefault: vi.fn() })
    }

    it('opens the model picker and sends nothing until Review is chosen', async () => {
      const backend = reviewBackend()
      const storage = rememberedStorage()
      storage.setItem('leetcoder.llm-response-language', 'korean')
      vi.mocked(backend.readProblemFile).mockResolvedValue(filledSource)
      await openApp(backend, storage)
      await selectFile(file)
      editor().emitChange(`${filledSource}\n// edited`)

      await openPicker()
      expect(backend.aiListModels).toHaveBeenCalledWith(false)
      expect(backend.reviewAiCode).not.toHaveBeenCalled()
      expect(testMocks.progressOverlays).toHaveLength(0)
      expect(reviewButton().attributes.get('aria-busy')).not.toBe('true')
      expect(picker('dialog').hidden).toBe(false)
      expect(picker('file').textContent).toBe('Q1TwoSum.java')
      expect(picker('provider').textContent).toBe('Claude')
      expect(picker('test-run').textContent).toBe('No test run yet')
      expect(pickerNames()).toEqual(['Small Name', 'Mid Name', 'Large Name'])
      expect(checkedModel()).toBe('model-small')

      submitPicker()
      expect(picker('dialog').hidden).toBe(true)
      await vi.waitFor(() => {
        expect(reviewTab().attributes.get('aria-selected')).toBe('true')
      })

      expect(backend.reviewAiCode).toHaveBeenCalledOnce()
      expect(vi.mocked(backend.reviewAiCode).mock.calls[0][0]).toMatchObject({
        selectedModelId: 'model-small',
        source: `${filledSource}\n// edited`,
        testRun: null,
        language: 'korean',
        problemTitle: problemOne.title,
        entryPoint: 'public int[] twoSum(int[] nums, int target)',
      })
      expect(storage.getItem('leetcoder.llm-review-model.anthropic')).toBe('model-small')
      expect(storage.getItem('leetcoder.llm-model.anthropic')).toBeNull()
      expect(backend.aiGenerateTests).not.toHaveBeenCalled()
      expect(reviewPanel().hidden).toBe(false)
      expect(dom.root.querySelector<FakeElement>('#tests-panel').hidden).toBe(true)
      expect(dom.root.querySelector<FakeElement>('#review-body').children[0].children
        .map((child) => (child as unknown as { className: string }).className))
        .toEqual(['review-head', 'review-usage', 'review-main'])
      expect(testMocks.progressOverlays).toHaveLength(0)
      expect(reviewButton().attributes.get('aria-busy')).toBe('false')
      expect(reviewButton().disabled).toBe(false)
    })

    it('sends nothing when the picker is cancelled', async () => {
      const backend = reviewBackend()
      const storage = rememberedStorage()
      await openApp(backend, storage)
      await selectFile(file)

      await openPicker()
      dom.root.querySelector<FakeElement>('#cancel-ai-review-model').dispatch('click')
      expect(picker('dialog').hidden).toBe(true)
      await Promise.resolve()
      await Promise.resolve()

      expect(backend.reviewAiCode).not.toHaveBeenCalled()
      expect(testMocks.progressOverlays).toHaveLength(0)
      expect(storage.getItem('leetcoder.llm-review-model.anthropic')).toBeNull()
      expect(reviewButton().disabled).toBe(false)

      await openPicker()
      dom.window.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() })
      expect(picker('dialog').hidden).toBe(true)
      await Promise.resolve()
      expect(backend.reviewAiCode).not.toHaveBeenCalled()
    })

    it('preselects the remembered model and remembers a new choice', async () => {
      const backend = reviewBackend()
      const storage = rememberedStorage()
      storage.setItem('leetcoder.llm-review-model.anthropic', 'model-older')
      await openApp(backend, storage)
      await selectFile(file)

      await openPicker()
      expect(pickerNames()).toEqual(['Small Name', 'Mid Name', 'Large Name', 'Older Name'])
      expect(checkedModel()).toBe('model-older')

      const small = pickerRadios()[0]
      small.checked = true
      picker('list').dispatch('change', { target: small })
      submitPicker()
      await vi.waitFor(() => {
        expect(backend.reviewAiCode).toHaveBeenCalledOnce()
      })
      expect(vi.mocked(backend.reviewAiCode).mock.calls[0][0].selectedModelId).toBe('model-small')
      expect(storage.getItem('leetcoder.llm-review-model.anthropic')).toBe('model-small')
    })

    it('opens the key settings instead of the picker without a key', async () => {
      const backend = reviewBackend()
      vi.mocked(backend.aiStatus).mockResolvedValue({ configured: false, provider })
      await openStub(backend, filledSource)

      reviewButton().dispatch('click')
      await vi.waitFor(() => {
        expect(backend.aiStatus).toHaveBeenCalled()
      })
      await Promise.resolve()
      expect(backend.aiListModels).not.toHaveBeenCalled()
      expect(picker('test-run').textContent).toBe('')
      expect(backend.reviewAiCode).not.toHaveBeenCalled()
    })

    it('keeps the last review and shows a toast when the model declines', async () => {
      const backend = reviewBackend()
      vi.mocked(backend.reviewAiCode).mockResolvedValue({ ...reviewResult, outcome: 'refused', review: null, servedModel: 'm' })
      await openStub(backend, filledSource)

      await openPicker()
      submitPicker()
      await vi.waitFor(() => {
        expect(lastToast()?.message).toContain('The model declined to review Q1TwoSum.java.')
      })
      // The tab opened when the review started; it goes back to what it showed before.
      expect(reviewTab().attributes.get('aria-selected')).toBe('true')
      expect(classNames(dom.root.querySelector<FakeElement>('#review-body').children)).toEqual(['review-empty'])
      expect(testMocks.progressOverlays).toHaveLength(0)
    })

    it('streams the review into the Review tab while the editor stays usable', async () => {
      const backend = reviewBackend()
      const result = deferred<AiReviewResult>()
      let onEvent: AiStreamHandler | undefined
      vi.mocked(backend.reviewAiCode).mockImplementation((_request, _onProgress, handler) => {
        onEvent = handler
        return result.promise
      })
      await openStub(backend, filledSource)

      await openPicker()
      submitPicker()
      await vi.waitFor(() => {
        expect(onEvent).toBeDefined()
      })
      const body = dom.root.querySelector<FakeElement>('#review-body')
      const layout = () => body.children[0]
      expect(reviewTab().attributes.get('aria-selected')).toBe('true')
      expect(classNames(layout().children)).toEqual(['review-head', 'review-usage', 'review-main'])
      const status = layout().children[0].children.at(-1)!
      expect((status as unknown as { className: string }).className).toBe('review-stream-status')
      expect(status.children[1].textContent).toMatch(/^Thinking… \d+s · Small Name$/)
      expect(testMocks.progressOverlays).toHaveLength(0)
      expect(reviewButton().disabled).toBe(true)
      // The disabled button has lost focus, as it does in a browser.
      dom.document.activeElement = dom.document.body
      const keydown = { key: 'a', preventDefault: vi.fn() }
      dom.window.dispatch('keydown', keydown)
      expect(keydown.preventDefault).not.toHaveBeenCalled()

      onEvent!({ kind: 'usage', usage: { inputTokens: 2_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, final: false })
      onEvent!({ kind: 'text', text: '{"verdict":"correct","summary":"Two poi' })
      expect(status.children[1].textContent).toMatch(/^Writing the review… \d+s · Small Name$/)
      const main = layout().children[2]
      expect(main.attributes.get('aria-busy')).toBe('true')
      expect(main.children[0].textContent).toBe('Two poi')
      const meter = layout().children[1]
      // 2,000 input tokens and ten estimated output tokens at $1 and $5 per million.
      expect(meter.children[1].textContent).toBe('≈ $0.0021')

      result.resolve(reviewResult)
      await vi.waitFor(() => {
        expect(reviewButton().disabled).toBe(false)
      })
      expect(layout().children[1]).toBe(meter)
      expect(meter.children[1].textContent).toBe('$0.0123')
      expect(classNames(layout().children[0].children)).not.toContain('review-stream-status')
      expect(dom.document.activeElement === reviewButton()).toBe(true)
    })

    it('leaves focus where the user moved it during the review', async () => {
      const backend = reviewBackend()
      const result = deferred<AiReviewResult>()
      vi.mocked(backend.reviewAiCode).mockReturnValue(result.promise)
      await openStub(backend, filledSource)
      await openPicker()
      submitPicker()
      await vi.waitFor(() => {
        expect(backend.reviewAiCode).toHaveBeenCalledOnce()
      })
      const input = dom.root.querySelector<FakeElement>('#file-search')
      input.focus()
      result.resolve(reviewResult)
      await vi.waitFor(() => {
        expect(reviewButton().disabled).toBe(false)
      })
      expect(dom.document.activeElement === input).toBe(true)
    })

    describe('follow-up', () => {
      const followUpInput = (): FakeElement => dom.root.querySelector<FakeElement>('#review-follow-up-input')
      const followUpSend = (): FakeElement => dom.root.querySelector<FakeElement>('#review-follow-up-send')
      const typeQuestion = (text: string): void => {
        followUpInput().value = text
        followUpInput().dispatch('input')
      }
      const pressEnter = (): void => {
        followUpInput().dispatch('keydown', { key: 'Enter', preventDefault: vi.fn() })
      }
      const followUpResult = {
        outcome: 'ok' as const,
        answer: 'Because **order** matters.',
        servedModel: 'model-a',
        fellBack: false,
        usage: reviewUsage,
      }

      async function reviewed(backend: BackendClient): Promise<void> {
        vi.mocked(backend.readProblemFile).mockResolvedValue(filledSource)
        await openApp(backend)
        await selectFile(file)
        await openPicker()
        submitPicker()
        await vi.waitFor(() => {
          expect(reviewTab().attributes.get('aria-selected')).toBe('true')
        })
      }

      it('is disabled until a review is shown', async () => {
        await openStub(reviewBackend(), filledSource)
        expect(followUpInput().disabled).toBe(true)
        expect(followUpSend().disabled).toBe(true)
      })

      it('asks about the code as reviewed, streams the answer, and leaves the app usable', async () => {
        const backend = reviewBackend()
        const answer = deferred<typeof followUpResult>()
        let onEvent: AiStreamHandler | undefined
        vi.mocked(backend.askAiReviewFollowUp).mockImplementation((_request, handler) => {
          onEvent = handler
          return answer.promise
        })
        await reviewed(backend)
        expect(followUpInput().disabled).toBe(false)
        editor().emitChange(`${filledSource}\n// edited after the review`)
        const progressCount = testMocks.progressOverlays.length

        typeQuestion('Why does order matter?')
        expect(followUpSend().disabled).toBe(false)
        pressEnter()
        await vi.waitFor(() => {
          expect(backend.askAiReviewFollowUp).toHaveBeenCalledOnce()
        })
        const request = vi.mocked(backend.askAiReviewFollowUp).mock.calls[0][0]
        expect(request).toMatchObject({
          selectedModelId: 'model-a',
          reviewAnswer: review,
          history: [],
          question: 'Why does order matter?',
        })
        expect(request.review).toEqual(vi.mocked(backend.reviewAiCode).mock.calls[0][0])
        expect(request.review.source).toBe(filledSource)
        expect(followUpInput().value).toBe('')
        expect(followUpSend().disabled).toBe(true)
        expect(reviewButton().disabled).toBe(true)
        expect(testMocks.progressOverlays).toHaveLength(progressCount)
        const keydown = { key: 'a', preventDefault: vi.fn() }
        dom.window.dispatch('keydown', keydown)
        expect(keydown.preventDefault).not.toHaveBeenCalled()

        onEvent?.({ kind: 'text', text: 'Because ' })
        answer.resolve(followUpResult)
        await vi.waitFor(() => {
          expect(reviewButton().disabled).toBe(false)
        })
        const main = dom.root.querySelector<FakeElement>('#review-body').children[0].children[2]
        const conversation = main.children.at(-1)!
        expect((conversation as unknown as { className: string }).className).toBe('review-section review-follow-ups')
        expect(conversation.children[1].children[0].textContent).toBe('Why does order matter?')
        expect(backend.aiUsage).toHaveBeenCalled()
      })

      describe('a proposed change', () => {
        const proposal = { summary: 'Return early', code: `${filledSource}\n// changed`, baseCode: filledSource }
        let open: ReturnType<typeof vi.spyOn<AiEditDiffDialog, 'open'>>

        beforeEach(() => {
          open = vi.spyOn(AiEditDiffDialog.prototype, 'open').mockImplementation(() => {})
        })

        afterEach(() => {
          open.mockRestore()
        })

        it('opens the diff as soon as the answer settles, once', async () => {
          const backend = reviewBackend()
          vi.mocked(backend.askAiReviewFollowUp).mockResolvedValue({ ...followUpResult, proposal })
          await reviewed(backend)

          typeQuestion('Fix it')
          pressEnter()
          await vi.waitFor(() => {
            expect(open).toHaveBeenCalledOnce()
          })
          expect(open.mock.calls[0][0]).toMatchObject({
            fileName: 'Q1TwoSum.java',
            proposal: { ...proposal, status: 'pending' },
            canAccept: true,
          })

          vi.mocked(backend.askAiReviewFollowUp).mockResolvedValue({ ...followUpResult, proposal: null })
          typeQuestion('Why?')
          pressEnter()
          await vi.waitFor(() => {
            expect(backend.askAiReviewFollowUp).toHaveBeenCalledTimes(2)
            expect(reviewButton().disabled).toBe(false)
          })
          expect(open).toHaveBeenCalledOnce()
        })

        it('leaves the change for its View diff button while another dialog is open', async () => {
          const backend = reviewBackend()
          const answer = deferred<AiReviewFollowUpResult>()
          vi.mocked(backend.askAiReviewFollowUp).mockReturnValue(answer.promise)
          await reviewed(backend)

          typeQuestion('Fix it')
          pressEnter()
          await vi.waitFor(() => {
            expect(backend.askAiReviewFollowUp).toHaveBeenCalledOnce()
          })
          const queryAll = dom.root.querySelectorAll.bind(dom.root)
          vi.spyOn(dom.root, 'querySelectorAll').mockImplementation(<T extends FakeElement = FakeElement>(selector: string): T[] =>
            selector === '.dialog-backdrop:not([hidden])' ? [dom.root.querySelector<T>('#settings-dialog')] : queryAll<T>(selector))
          answer.resolve({ ...followUpResult, proposal })
          await vi.waitFor(() => {
            expect(reviewButton().disabled).toBe(false)
          })
          expect(open).not.toHaveBeenCalled()
        })
      })

      it('puts the question back and shows the error when the request fails', async () => {
        const backend = reviewBackend()
        vi.mocked(backend.askAiReviewFollowUp).mockRejectedValue(new Error('Too many follow-up turns.'))
        await reviewed(backend)

        typeQuestion('Why?')
        pressEnter()
        await vi.waitFor(() => {
          expect(followUpInput().value).toBe('Why?')
        })
        expect(lastToast()?.message).toBe('Could not answer the question: Too many follow-up turns.')
        const main = dom.root.querySelector<FakeElement>('#review-body').children[0].children[2]
        expect(main.children.map((child) => (child as unknown as { className: string }).className))
          .not.toContain('review-section review-follow-ups')
      })

      it('keeps the draft across file switches', async () => {
        const backend = reviewBackend()
        vi.mocked(backend.listProblemFiles).mockResolvedValue([file, otherFile])
        await reviewed(backend)
        typeQuestion('Half-typed question')
        await selectFile(otherFile)
        await selectFile(file)
        expect(followUpInput().value).toBe('Half-typed question')
        expect(followUpInput().disabled).toBe(false)
      })
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

  it('captions the button by what a click does, and keeps the caption while it runs', () => {
    const path = 'src/Q1TwoSum.java'
    expect(aiButtonPresentation(path, null, null, false, problemOne, 'bare', true)).toMatchObject({
      icon: 'sparkles',
      text: 'Fill test',
      label: 'Generate tests with AI',
    })
    expect(aiButtonPresentation(path, null, null, false, problemOne, 'filled', true)).toMatchObject({
      icon: 'circlePlus',
      text: 'Add case',
      label: 'Add a failing case with AI',
    })
    expect(aiButtonPresentation(path, path, 'examples', false, problemOne, 'bare', false)).toMatchObject({
      icon: 'loader',
      text: 'Fill test',
    })
    expect(aiButtonPresentation(path, path, 'case', false, problemOne, 'filled', true)).toMatchObject({
      icon: 'loader',
      text: 'Add case',
    })
  })

  it('formats no signatures without library metadata', () => {
    expect(psSignatures(null)).toEqual([])
  })

  it('discards a result when only the repository generation changed', async () => {
    const target: AiTarget = { repoPath: '/repo', path: 'src/Q1TwoSum.java', repositoryGeneration: 1 }
    let current = target
    const generation = deferred<AiGenerateResult>()
    const { controller, api, ui } = unitController({
      aiGenerateTests: () => generation.promise,
      currentTarget: () => current,
    })

    const finished = controller.generate()
    expect(controller.requestPath).toBe('src/Q1TwoSum.java')
    await new Promise((resolve) => setTimeout(resolve))
    current = { ...target, repositoryGeneration: 2 }
    generation.resolve(okResult)
    await finished

    expect(api.applyStatements).not.toHaveBeenCalled()
    expect(vi.mocked(ui.showMessage).mock.calls[0][0]).toContain('discarded')
    expect(api.focusEditor).not.toHaveBeenCalled()
    expect(ui.generationFinished).toHaveBeenCalledOnce()
    expect(ui.progressStates.at(-1)).toBeNull()
    expect(controller.requestPath).toBeNull()
  })
})

const unitTarget: AiTarget = { repoPath: '/repo', path: 'src/Q1TwoSum.java', repositoryGeneration: 1 }

const review: AiReview = {
  verdict: 'incorrect',
  summary: 'Misses duplicates.',
  failureCause: 'The map is filled before the lookup.',
  issues: ['Wrong order'],
  missedCases: [{ input: 'nums = [3,3], target = 6', reason: 'Same value twice' }],
  efficiency: { time: 'O(n)', space: 'O(n)', assessment: 'Fits the limits.' },
  improvements: [],
}

const reviewUsage: AiRequestUsage = {
  inputTokens: 2_410,
  outputTokens: 96,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0123,
}

const classNames = (elements: readonly FakeElement[]): string[] =>
  elements.map((element) => (element as unknown as { className: string }).className)

const reviewResult: AiReviewResult = { outcome: 'ok', review, help: null, servedModel: 'model-a', fellBack: false, usage: reviewUsage }

const problemHelp: AiProblemHelp = {
  overview: 'Find two indices whose values add up to the target.',
  keyPoints: ['Exactly one answer exists.'],
  hints: ['Remember the values you have seen.'],
}

const helpResult: AiReviewResult = { ...reviewResult, review: null, help: problemHelp }

/** The scaffold with an empty solution method. */
const unimplementedSource = 'class Q1TwoSum {\n    public int[] twoSum(int[] nums, int target) {\n\n    }\n}'

const pricing = (inputPerMTok: number, outputPerMTok: number): AiModelPricing => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: null,
  cacheWritePerMTok: null,
})

/** The most capable current model is Large, by output price. */
const reviewModels: AiModelList = {
  models: [
    { id: 'model-small', displayName: 'Small Name', deprecated: false, superseded: false, pricing: pricing(1, 5) },
    { id: 'model-large', displayName: 'Large Name', deprecated: false, superseded: false, pricing: pricing(5, 25) },
    { id: 'model-mid', displayName: 'Mid Name', deprecated: false, superseded: false, pricing: pricing(3, 15) },
    { id: 'model-retired', displayName: 'Retired Name', deprecated: true, superseded: false, pricing: pricing(15, 75) },
    { id: 'model-older', displayName: 'Older Name', deprecated: false, superseded: true, pricing: pricing(15, 75) },
  ],
  defaultModelId: 'model-small',
  fetchedAt: 1,
  error: null,
}

type UnitUi = AiControllerUi & {
  /** Every popup update, plus the order of popup and message calls. */
  progressStates: Array<ProgressOverlayState | null>
  events: string[]
}

/** A controller over fakes whose calls record the order of popup updates and messages. */
function unitController(overrides: Partial<AiControllerApi> = {}, uiOverrides: Partial<AiControllerUi> = {}) {
  const progressStates: Array<ProgressOverlayState | null> = []
  const events: string[] = []
  const api: AiControllerApi = {
    aiStatus: vi.fn(async () => ({ configured: true, provider })),
    aiListModels: vi.fn(async () => reviewModels),
    aiGenerateTests: vi.fn(async () => okResult),
    reviewAiCode: vi.fn(async () => reviewResult),
    askAiReviewFollowUp: vi.fn(async () => ({ outcome: 'ok', answer: '', proposal: null, servedModel: 'model-a', fellBack: false, usage: reviewUsage }) as const),
    currentTarget: () => unitTarget,
    headerProblem: () => problemOne,
    readContext: () => ({ stub: 'bare', methodHeaders: ['int f()'], canAddCase: true }),
    selectedModelId: () => 'model-pinned',
    psSignatures: () => [],
    applyStatements: vi.fn(() => ({ ok: true }) as never),
    applyCaseStatements: vi.fn(() => ({ ok: true, methodName: 'test2' }) as never),
    focusEditor: vi.fn(() => {
      events.push('focus')
    }),
    readSource: () => 'class Q1TwoSum { int f() { return 1; } }',
    replaceSource: vi.fn(),
    reviewTestRun: () => ({ testRun: null, omitted: 'no-run' }),
    responseLanguage: () => 'korean',
    ...overrides,
  }
  const ui: UnitUi = {
    progressStates,
    events,
    requestChanged: vi.fn(),
    showMessage: vi.fn((message: string) => {
      events.push(`message: ${message}`)
    }),
    showMissingKey: vi.fn(() => {
      events.push('missing key')
    }),
    generationFinished: vi.fn(),
    showProgress: vi.fn((state: ProgressOverlayState | null) => {
      progressStates.push(state)
      events.push(state ? `progress ${state.current}` : 'progress closed')
    }),
    caseAdded: vi.fn(),
    reviewed: vi.fn(() => {
      events.push('reviewed')
    }),
    reviewStreamChanged: vi.fn((stream: AiReviewStream | null) => {
      events.push(stream ? `stream: ${stream.text}` : 'stream ended')
    }),
    usageChanged: vi.fn(() => {
      events.push('usage')
    }),
    proposalArrived: vi.fn(),
    chooseReviewModel: vi.fn(async () => {
      events.push('picker')
      return { modelId: 'model-review' }
    }),
    followUpsChanged: vi.fn(),
    followUpAnswerChanged: vi.fn(),
    ...uiOverrides,
  }
  return { controller: createAiController(api, ui), api, ui }
}

const stageLabels = (state: ProgressOverlayState | null): string[] =>
  (state?.stages ?? []).map((stage) => typeof stage === 'string' ? stage : stage.label)

describe('AI progress popup', () => {
  it('steps through reading, asking the provider by name, and writing, then closes before the message', async () => {
    let report: AiProgressHandler | undefined
    const generation = deferred<AiGenerateResult>()
    const status = deferred<AiStatus>()
    const { controller, ui } = unitController({
      aiStatus: () => status.promise,
      aiGenerateTests: (_request, onProgress) => {
        report = onProgress
        return generation.promise
      },
    })

    const finished = controller.generate()
    expect(ui.progressStates).toHaveLength(1)
    expect(ui.progressStates[0]).toMatchObject({ kicker: 'AI tests', title: 'Generating tests', current: 0 })
    expect(stageLabels(ui.progressStates[0])).toEqual(['Reading the problem', 'Asking the model', 'Writing tests'])

    status.resolve({ configured: true, provider: { id: 'other', displayName: 'Provider X' } })
    await vi.waitFor(() => {
      expect(report).toBeDefined()
    })
    expect(stageLabels(ui.progressStates.at(-1)!)).toEqual(['Reading the problem', 'Asking Provider X', 'Writing tests'])

    report!({ stage: 'requesting', model: 'model-123' })
    expect(ui.progressStates.at(-1)).toMatchObject({ current: 1 })
    expect(ui.progressStates.at(-1)!.stages[1]).toEqual({ label: 'Asking Provider X', detail: 'model-123' })

    report!({ stage: 'received' })
    expect(ui.progressStates.at(-1)).toMatchObject({ current: 2 })

    generation.resolve(okResult)
    await finished
    expect(ui.progressStates.at(-1)).toBeNull()
    expect(ui.events.slice(-3)).toEqual(['progress closed', 'message: Filled test() in Q1TwoSum.java.', 'focus'])

    // A late event after the request ended shows nothing.
    const count = ui.progressStates.length
    report!({ stage: 'received' })
    expect(ui.progressStates).toHaveLength(count)
  })

  it('titles a failing case request as adding a case', async () => {
    const { controller, ui } = unitController()
    await controller.generateCase('a = 1\nExpected\n2')
    expect(ui.progressStates[0]).toMatchObject({ kicker: 'AI tests', title: 'Adding failing case' })
    expect(ui.progressStates.at(-1)).toBeNull()
  })

  it.each([
    ['an error', { aiGenerateTests: vi.fn(async () => { throw new Error('HTTP 529') }) }, 'Could not generate tests: HTTP 529'],
    ['a refusal', { aiGenerateTests: vi.fn(async () => ({ ...okResult, outcome: 'refused' as const, statements: [] })) }, 'The model declined'],
    ['a truncated reply', { aiGenerateTests: vi.fn(async () => ({ ...okResult, outcome: 'truncated' as const, statements: [] })) }, 'output limit'],
    ['a status failure', { aiStatus: vi.fn(async () => { throw new Error('disk') }) }, 'Could not read the API key status'],
  ])('closes before the message after %s', async (_name, overrides, message) => {
    const { controller, ui } = unitController(overrides as Partial<AiControllerApi>)
    await controller.generate()

    const closed = ui.events.indexOf('progress closed')
    expect(closed).toBeGreaterThan(-1)
    expect(ui.events[closed + 1]).toContain(message)
    expect(ui.progressStates.at(-1)).toBeNull()
    expect(ui.progressStates.filter((state) => state === null)).toHaveLength(1)
  })

  it('closes before opening the key settings', async () => {
    const { controller, ui } = unitController({ aiStatus: async () => ({ configured: false, provider }) })
    await controller.generate()
    expect(ui.events.slice(-2)).toEqual(['progress closed', 'missing key'])
  })

  it('closes when the request is discarded after the app is torn down', async () => {
    const generation = deferred<AiGenerateResult>()
    const { controller, ui } = unitController({ aiGenerateTests: () => generation.promise })
    const finished = controller.generate()
    await new Promise((resolve) => setTimeout(resolve))
    controller.dispose()
    generation.resolve(okResult)
    await finished
    // Teardown removes any popup itself; nothing more is shown.
    expect(ui.progressStates.every((state) => state !== null)).toBe(true)
    expect(ui.showMessage).not.toHaveBeenCalled()
  })

  it('names the case added so the dialog can forget it, and not when it was rejected', async () => {
    const added = unitController()
    await added.controller.generateCase('a = 1')
    expect(added.ui.caseAdded).toHaveBeenCalledOnce()

    const rejected = unitController({
      applyCaseStatements: vi.fn(() => ({ ok: false, reason: 'syntax-error' }) as never),
    })
    await rejected.controller.generateCase('a = 1')
    expect(rejected.ui.caseAdded).not.toHaveBeenCalled()

    const examples = unitController()
    await examples.controller.generate()
    expect(examples.ui.caseAdded).not.toHaveBeenCalled()
  })
})

describe('AI review', () => {
  it('sends the open source, current test run, language, and the generation problem fields', async () => {
    const testRun = aiReviewTestRun(passingRun)
    const { controller, api, ui } = unitController({
      reviewTestRun: () => ({ testRun, omitted: null }),
    })

    await controller.review()

    expect(api.reviewAiCode).toHaveBeenCalledOnce()
    expect(vi.mocked(api.reviewAiCode).mock.calls[0][0]).toEqual({
      mode: 'review',
      selectedModelId: 'model-review',
      problemTitle: problemOne.title,
      problemContent: problemOne.content,
      entryPoint: 'public int[] twoSum(int[] nums, int target)',
      source: 'class Q1TwoSum { int f() { return 1; } }',
      testRun,
      language: 'korean',
    })
    expect(ui.reviewed).toHaveBeenCalledWith({
      review,
      help: null,
      fileName: 'Q1TwoSum.java',
      servedModel: 'model-a',
      servedModelName: 'model-a',
      testRunOmitted: null,
      usage: reviewUsage,
      pricing: null,
      request: vi.mocked(api.reviewAiCode).mock.calls[0][0],
      target: api.currentTarget(),
      followUps: [],
    })
    expect(ui.progressStates).toHaveLength(0)
    expect(ui.events.slice(-3)).toEqual(['stream: ', 'stream ended', 'reviewed'])
    expect(ui.generationFinished).toHaveBeenCalledOnce()
    expect(api.aiGenerateTests).not.toHaveBeenCalled()
  })

  it('records why test results were left out', async () => {
    const { controller, ui } = unitController({ reviewTestRun: () => ({ testRun: null, omitted: 'changed' }) })
    await controller.review()
    expect(ui.reviewed).toHaveBeenCalledWith(expect.objectContaining({ testRunOmitted: 'changed' }))
  })

  it.each([
    ['refused', 'The model declined to review Q1TwoSum.java.'],
    ['truncated', 'The response hit the output limit before it finished, so no review is shown.'],
  ] as const)('shows a %s review as an error and keeps the last review', async (outcome, message) => {
    const { controller, ui } = unitController({
      reviewAiCode: vi.fn(async () => ({ ...reviewResult, outcome, review: null })),
    })
    await controller.review()
    expect(ui.reviewed).not.toHaveBeenCalled()
    expect(ui.showMessage).toHaveBeenCalledWith(expect.stringContaining(message), 'error')
    expect(ui.events.slice(-2)).toEqual(['stream ended', expect.stringContaining(message)])
  })

  it('shows an error and no review when the call fails', async () => {
    const { controller, ui } = unitController({ reviewAiCode: vi.fn(async () => { throw new Error('too long') }) })
    await controller.review()
    expect(ui.showMessage).toHaveBeenCalledWith('Could not review the code: too long', 'error')
    expect(ui.reviewed).not.toHaveBeenCalled()
    expect(ui.events.slice(-2)).toEqual(['stream ended', 'message: Could not review the code: too long'])
  })

  it('streams the review: the model by name, the JSON so far, and the usage, then ends before the result', async () => {
    const pending = deferred<AiReviewResult>()
    let report: AiProgressHandler | undefined
    let onEvent: AiStreamHandler | undefined
    const { controller, ui } = unitController({
      reviewTestRun: () => ({ testRun: null, omitted: 'changed' }),
      reviewAiCode: (_request, onProgress, handler) => {
        report = onProgress
        onEvent = handler
        return pending.promise
      },
    }, { chooseReviewModel: vi.fn(async () => ({ modelId: 'model-mid' })) })
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)

    const reviewing = controller.review()
    await vi.waitFor(() => {
      expect(onEvent).toBeDefined()
    })
    const stream = vi.mocked(ui.reviewStreamChanged).mock.calls[0][0]!
    expect(stream).toEqual({
      mode: 'review',
      fileName: 'Q1TwoSum.java',
      modelId: 'model-mid',
      modelName: 'Mid Name',
      pricing: pricing(3, 15),
      testRunOmitted: 'changed',
      startedAt: 5_000,
      text: '',
      live: { reported: null, final: false, chars: 0 },
    })
    expect(controller.requestKind).toBe('review')

    report!({ stage: 'requesting', model: 'model-large' })
    expect(stream).toMatchObject({ modelId: 'model-large', modelName: 'Large Name', pricing: pricing(5, 25) })
    const usage = { inputTokens: 900, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }
    onEvent!({ kind: 'usage', usage, final: false })
    onEvent!({ kind: 'thinking', chars: 8 })
    onEvent!({ kind: 'text', text: '{"verdict":' })
    onEvent!({ kind: 'text', text: '"correct"' })
    expect(stream.text).toBe('{"verdict":"correct"')
    expect(stream.live).toEqual({ reported: usage, final: false, chars: 8 + 20 })
    expect(ui.reviewStreamChanged).toHaveBeenCalledTimes(4)
    expect(vi.mocked(ui.reviewStreamChanged).mock.calls.every(([value]) => value === stream)).toBe(true)

    pending.resolve(reviewResult)
    await reviewing
    expect(ui.events.slice(-6)).toEqual([
      'usage', 'usage', 'stream: {"verdict":', 'stream: {"verdict":"correct"', 'stream ended', 'reviewed',
    ])
    onEvent!({ kind: 'text', text: 'late' })
    expect(ui.reviewStreamChanged).toHaveBeenCalledTimes(5)
    expect(stream.text).toBe('{"verdict":"correct"')
    now.mockRestore()
  })

  it('names the catalog default before the request says which model it sent to', async () => {
    const firstStream = async (overrides: Partial<AiControllerApi>) => {
      const unit = unitController(overrides, { chooseReviewModel: vi.fn(async () => ({ modelId: null })) })
      let seen: AiReviewStream | null = null
      vi.mocked(unit.ui.reviewStreamChanged).mockImplementation((stream) => {
        seen ??= stream && { ...stream }
      })
      await unit.controller.review()
      return seen
    }
    expect(await firstStream({})).toMatchObject({ modelId: 'model-small', modelName: 'Small Name' })
    expect(await firstStream({ aiListModels: vi.fn(async () => { throw new Error('no cache') }) }))
      .toMatchObject({ modelId: '', modelName: 'the default model', pricing: null })
  })

  it('names a substituted model after showing the review', async () => {
    const { controller, ui } = unitController({
      reviewAiCode: vi.fn(async () => ({ ...reviewResult, servedModel: 'model-b', fellBack: true })),
    })
    await controller.review()
    expect(ui.events.slice(-2)).toEqual([
      'reviewed',
      'message: The selected model is unavailable, so model-b was used.',
    ])
  })

  it('shares one in-flight request with generation', async () => {
    const pending = deferred<AiReviewResult>()
    const { controller, api } = unitController({ reviewAiCode: () => pending.promise })
    const reviewing = controller.review()
    await vi.waitFor(() => {
      expect(controller.requestKind).toBe('review')
    })
    await controller.generate()
    await controller.review()
    expect(api.aiGenerateTests).not.toHaveBeenCalled()
    pending.resolve(reviewResult)
    await reviewing
    expect(controller.requestKind).toBeNull()
  })

  it('asks for a model first and sends nothing while the picker is open', async () => {
    const choice = deferred<AiReviewModelChoice | null>()
    const testRun = aiReviewTestRun(passingRun)
    const chooseReviewModel = vi.fn((_request: AiReviewModelRequest) => choice.promise)
    const { controller, api, ui } = unitController(
      { reviewTestRun: () => ({ testRun, omitted: null }) },
      { chooseReviewModel },
    )

    const reviewing = controller.review()
    await vi.waitFor(() => {
      expect(chooseReviewModel).toHaveBeenCalledOnce()
    })
    expect(api.aiListModels).toHaveBeenCalledWith(false)
    expect(chooseReviewModel.mock.calls[0][0]).toEqual({
      mode: 'review',
      fileName: 'Q1TwoSum.java',
      provider,
      models: reviewModels,
      testModelId: 'model-pinned',
      testRun: { testRun, omitted: null },
    })
    expect(controller.requestPath).toBeNull()
    expect(ui.progressStates).toHaveLength(0)
    // Nothing else may start while the picker is open.
    await controller.generate()
    await controller.review()
    expect(api.aiGenerateTests).not.toHaveBeenCalled()
    expect(chooseReviewModel).toHaveBeenCalledOnce()
    expect(api.reviewAiCode).not.toHaveBeenCalled()

    choice.resolve({ modelId: 'model-mid' })
    await reviewing
    expect(vi.mocked(api.reviewAiCode).mock.calls[0][0].selectedModelId).toBe('model-mid')
  })

  it('sends nothing when the picker is cancelled', async () => {
    const { controller, api, ui } = unitController({}, { chooseReviewModel: vi.fn(async () => null) })
    await controller.review()
    expect(api.reviewAiCode).not.toHaveBeenCalled()
    expect(ui.progressStates).toHaveLength(0)
    expect(ui.showMessage).not.toHaveBeenCalled()
    expect(controller.requestPath).toBeNull()
  })

  it('opens the key settings instead of the picker without a key', async () => {
    const { controller, api, ui } = unitController({ aiStatus: vi.fn(async () => ({ configured: false, provider })) })
    await controller.review()
    expect(ui.showMissingKey).toHaveBeenCalledOnce()
    expect(ui.chooseReviewModel).not.toHaveBeenCalled()
    expect(api.aiListModels).not.toHaveBeenCalled()
    expect(api.reviewAiCode).not.toHaveBeenCalled()
  })

  it('still opens the picker when the model list cannot be read', async () => {
    const { controller, ui } = unitController({ aiListModels: vi.fn(async () => { throw new Error('no cache') }) })
    await controller.review()
    expect(vi.mocked(ui.chooseReviewModel).mock.calls[0][0].models).toBeNull()
    expect(ui.reviewed).toHaveBeenCalledWith(expect.objectContaining({ servedModelName: 'model-a' }))
  })

  it('names the served model from the catalog and keeps the usage', async () => {
    const { controller, ui } = unitController({
      reviewAiCode: vi.fn(async () => ({ ...reviewResult, servedModel: 'model-large' })),
    })
    await controller.review()
    expect(ui.reviewed).toHaveBeenCalledWith(expect.objectContaining({
      servedModel: 'model-large',
      servedModelName: 'Large Name',
      usage: reviewUsage,
    }))
  })

  it('shows no popup for a review and enables the button again before the stream ends', async () => {
    let controller: AiController | undefined
    const order: string[] = []
    const unit = unitController({}, {
      requestChanged: vi.fn(() => {
        order.push(controller!.requestPath === null ? 'idle' : 'busy')
      }),
      reviewStreamChanged: vi.fn((stream: AiReviewStream | null) => {
        if (!stream) order.push('stream ended')
      }),
    })
    controller = unit.controller
    await controller.review()
    expect(unit.ui.showProgress).not.toHaveBeenCalled()
    expect(order).toEqual(['busy', 'idle', 'stream ended'])
  })

  it('sends nothing for another loaded problem or an empty file', async () => {
    const other = unitController({ headerProblem: () => ({ ...problemOne, frontendId: '9' }) })
    await other.controller.review()
    expect(other.api.reviewAiCode).not.toHaveBeenCalled()

    const empty = unitController({ readSource: () => '  \n' })
    await empty.controller.review()
    expect(empty.api.reviewAiCode).not.toHaveBeenCalled()
    expect(empty.ui.showMessage).toHaveBeenCalledWith('Q1TwoSum.java is empty. No request was sent.', 'error')
  })
})

describe('AI help', () => {
  it('asks for help without the test run when the solution is unimplemented at the click', async () => {
    const testRun = aiReviewTestRun(passingRun)
    const { controller, api, ui } = unitController({
      readSource: () => unimplementedSource,
      reviewTestRun: () => ({ testRun, omitted: null }),
      reviewAiCode: vi.fn(async () => helpResult),
    })

    await controller.review()

    expect(vi.mocked(ui.chooseReviewModel).mock.calls[0][0].mode).toBe('help')
    expect(vi.mocked(ui.reviewStreamChanged).mock.calls[0][0]).toMatchObject({ mode: 'help', testRunOmitted: 'no-run' })
    expect(vi.mocked(api.reviewAiCode).mock.calls[0][0]).toMatchObject({
      mode: 'help',
      source: unimplementedSource,
      testRun: null,
    })
    expect(ui.reviewed).toHaveBeenCalledWith(expect.objectContaining({
      review: null,
      help: problemHelp,
      testRunOmitted: 'no-run',
      request: expect.objectContaining({ mode: 'help' }),
    }))
  })

  it('keeps the mode chosen at the click while the request runs', async () => {
    let source = unimplementedSource
    const choice = deferred<AiReviewModelChoice | null>()
    const pending = deferred<AiReviewResult>()
    const { controller, api } = unitController(
      { readSource: () => source, reviewAiCode: vi.fn(() => pending.promise) },
      { chooseReviewModel: vi.fn(() => choice.promise) },
    )
    expect(controller.reviewMode).toBeNull()
    const asking = controller.review()
    await vi.waitFor(() => {
      expect(api.aiListModels).toHaveBeenCalled()
    })
    source = 'class Q1TwoSum { int[] twoSum() { return null; } }'
    choice.resolve({ modelId: 'model-mid' })
    await vi.waitFor(() => {
      expect(api.reviewAiCode).toHaveBeenCalledOnce()
    })
    expect(controller.reviewMode).toBe('help')
    expect(vi.mocked(api.reviewAiCode).mock.calls[0][0].mode).toBe('help')
    pending.resolve(helpResult)
    await asking
    expect(controller.reviewMode).toBeNull()
  })

  it.each([
    ['refused', 'The model declined to help with Q1TwoSum.java.'],
    ['truncated', 'The response hit the output limit before it finished, so no help is shown.'],
  ] as const)('shows %s help as an error', async (outcome, message) => {
    const { controller, ui } = unitController({
      readSource: () => unimplementedSource,
      reviewAiCode: vi.fn(async () => ({ ...helpResult, outcome, help: null })),
    })
    await controller.review()
    expect(ui.reviewed).not.toHaveBeenCalled()
    expect(ui.showMessage).toHaveBeenCalledWith(expect.stringContaining(message), 'error')
  })

  it('names help in a failed call', async () => {
    const { controller, ui } = unitController({
      readSource: () => unimplementedSource,
      reviewAiCode: vi.fn(async () => { throw new Error('too long') }),
    })
    await controller.review()
    expect(ui.showMessage).toHaveBeenCalledWith('Could not get help: too long', 'error')
  })
})

const passingRun: TestResult = {
  success: false,
  phase: 'test',
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, errors: 0, durationMs: 12 },
  tests: [
    { name: 'test', status: 'passed', durationMs: 3, stdout: 'ok' },
    {
      name: 'test2',
      status: 'failed',
      message: 'expected 1',
      expected: '1',
      actual: '2',
      stdout: 'debug',
      stderr: 'ignored',
      details: 'stack',
    },
  ],
  diagnostics: [{ message: 'warning: unchecked', severity: 'warning', line: 3 }],
  stdout: 'whole log',
  stderr: '',
}

describe('AI review test results', () => {
  const snapshot = { repoPath: '/repo', filePath: 'src/Q1TwoSum.java', source: 'a' }
  const target = { repoPath: '/repo', path: 'src/Q1TwoSum.java' }

  it('sends only the fields the review needs', () => {
    expect(aiReviewTestRun(passingRun)).toEqual({
      success: false,
      phase: 'test',
      summary: { total: 2, passed: 1, failed: 1, skipped: 0, errors: 0 },
      tests: [
        { name: 'test', status: 'passed', message: null, expected: null, actual: null, stdout: 'ok' },
        { name: 'test2', status: 'failed', message: 'expected 1', expected: '1', actual: '2', stdout: 'debug' },
      ],
      diagnostics: ['warning: unchecked'],
    })
  })

  it('includes the run only when its source is current, and says why otherwise', () => {
    expect(aiReviewTestRunSelection(passingRun, snapshot, true, target).testRun).not.toBeNull()
    expect(aiReviewTestRunSelection(passingRun, snapshot, false, target)).toEqual({ testRun: null, omitted: 'changed' })
    expect(aiReviewTestRunSelection(passingRun, { ...snapshot, filePath: 'src/Q9.java' }, false, target))
      .toEqual({ testRun: null, omitted: 'no-run' })
    expect(aiReviewTestRunSelection(null, null, false, target)).toEqual({ testRun: null, omitted: 'no-run' })
    expect(aiReviewTestRunSelection(passingRun, null, false, target)).toEqual({ testRun: null, omitted: 'no-run' })
  })

  it('clips long fields and keeps the total under the native limit, the same way every time', () => {
    const long = 'x'.repeat(10_000)
    const tests = Array.from({ length: 40 }, (_, index) => ({
      name: `test${index}`,
      status: 'failed',
      message: long,
      expected: long,
      actual: long,
      stdout: long,
    }))
    const result: TestResult = {
      ...passingRun,
      tests,
      diagnostics: Array.from({ length: 20 }, () => ({ message: long, severity: 'error' })),
    }

    const run = aiReviewTestRun(result)
    const length = run.phase.length
      + run.tests.reduce((sum, test) => sum + test.name.length + test.status.length + (test.message?.length ?? 0)
        + (test.expected?.length ?? 0) + (test.actual?.length ?? 0) + (test.stdout?.length ?? 0), 0)
      + run.diagnostics.reduce((sum, diagnostic) => sum + diagnostic.length, 0)
    expect(length).toBeLessThanOrEqual(MAX_AI_REVIEW_TEST_RUN_LENGTH)
    expect(run.tests[0].message).toHaveLength(MAX_AI_REVIEW_FIELD_LENGTH)
    expect(run.tests[0].message!.endsWith('… [truncated]')).toBe(true)
    expect(run.diagnostics.length).toBeGreaterThan(0)
    expect(run.diagnostics.length).toBeLessThan(20)
    // Every outcome survives; the tests that did not fit keep only their name and status.
    expect(run.tests.map((test) => test.name)).toEqual(tests.map((test) => test.name))
    expect(run.tests.at(-1)).toEqual({ name: 'test39', status: 'failed', message: null, expected: null, actual: null, stdout: null })
    expect(aiReviewTestRun(result)).toEqual(run)
  })

  it('never splits a surrogate pair when clipping', () => {
    const emoji = '😀'.repeat(MAX_AI_REVIEW_FIELD_LENGTH)
    const run = aiReviewTestRun({ ...passingRun, tests: [{ name: 'test', status: 'failed', stdout: emoji }] })
    const clipped = run.tests[0].stdout!
    expect(clipped.length).toBeLessThanOrEqual(MAX_AI_REVIEW_FIELD_LENGTH)
    expect(clipped.replace('… [truncated]', '')).toMatch(/^(😀)+$/u)
  })
})

describe('AI review button', () => {
  const path = 'src/main/java/easy/Q1TwoSum.java'

  it('shows for the loaded problem file and waits for other work', () => {
    expect(aiReviewButtonPresentation(path, null, null, false, problemOne, 'review', null)).toMatchObject({
      icon: 'review',
      hidden: false,
      disabled: false,
      text: 'AI review',
      label: 'Review code with AI',
      title: 'Review code with AI',
    })
    expect(aiReviewButtonPresentation(path, null, null, true, problemOne, 'review', null)).toMatchObject({ hidden: false, disabled: true })
    expect(aiReviewButtonPresentation(path, path, 'examples', false, problemOne, 'review', null)).toMatchObject({
      hidden: false,
      disabled: true,
      busy: false,
    })
    expect(aiReviewButtonPresentation(path, null, null, false, { ...problemOne, frontendId: '9' }, 'review', null).hidden).toBe(true)
    expect(aiReviewButtonPresentation(path, null, null, false, { ...problemOne, content: null }, 'review', null).hidden).toBe(true)
    expect(aiReviewButtonPresentation(null, null, null, false, problemOne, 'review', null).hidden).toBe(true)
  })

  it('offers help while the solution is unimplemented', () => {
    expect(aiReviewMode(unimplementedSource)).toBe('help')
    expect(aiReviewMode('class Q1TwoSum { int[] twoSum() { return null; } }')).toBe('review')
    expect(aiReviewButtonPresentation(path, null, null, false, problemOne, 'help', null)).toMatchObject({
      icon: 'lightbulb',
      hidden: false,
      disabled: false,
      text: 'AI help',
      label: 'Get hints from AI',
      title: 'Get hints from AI',
    })
    expect(aiReviewButtonPresentation(path, path, 'review', false, problemOne, 'review', 'help')).toMatchObject({
      icon: 'loader',
      busy: true,
      text: 'AI help',
      label: 'Getting AI help',
      title: 'Getting help for Q1TwoSum.java…',
    })
  })

  it('spins while a review runs, and the generate button waits for it', () => {
    expect(aiReviewButtonPresentation(path, path, 'review', false, problemOne, 'help', 'review')).toMatchObject({
      icon: 'loader',
      busy: true,
      disabled: true,
      text: 'AI review',
      title: 'Reviewing Q1TwoSum.java…',
    })
    expect(aiButtonPresentation(path, path, 'review', false, problemOne, 'bare', true)).toMatchObject({
      icon: 'sparkles',
      busy: false,
      hidden: false,
      disabled: true,
      title: 'Available when the current AI request finishes',
    })
  })
})

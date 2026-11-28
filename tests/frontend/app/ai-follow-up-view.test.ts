import { describe, expect, it, vi } from 'vitest'

import type { AiReviewFollowUp } from '../../../src/app/ai-follow-up'
import { emptyLiveUsage } from '../../../src/app/ai-usage-meter'
import {
  AI_FOLLOW_UP_HELP_PLACEHOLDER,
  AI_FOLLOW_UP_NO_REVIEW_PLACEHOLDER,
  AI_FOLLOW_UP_PLACEHOLDER,
  AI_PROPOSAL_PREPARING,
  AiFollowUpView,
} from '../../../src/app/ai-follow-up-view'

type Listener = (event: object) => void

class FakeElement {
  className = ''
  textContent = ''
  value = ''
  placeholder = ''
  title = ''
  disabled = false
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
  }

  dispatch(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, entries) => count + entries.length, 0)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  focus(): void {
    this.ownerDocument.activeElement = this
  }

  all(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...child.all(className),
    ])
  }

  /** Visible text, depth first. */
  text(): string {
    return this.children.length > 0 ? this.children.map((child) => child.text()).join('') : this.textContent
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null
  readonly frames: FrameRequestCallback[] = []
  readonly defaultView = {
    requestAnimationFrame: (callback: FrameRequestCallback): number => this.frames.push(callback),
    cancelAnimationFrame: vi.fn(),
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement('#text', this)
    node.textContent = text
    return node
  }

  runFrames(): void {
    for (const frame of this.frames.splice(0)) frame(0)
  }
}

function setup(
  send: (question: string) => Promise<boolean> = vi.fn(async () => true),
  viewProposal?: (turn: AiReviewFollowUp) => void,
) {
  const document = new FakeDocument()
  const elements = new Map<string, FakeElement>(
    ['#review-follow-up-form', '#review-follow-up-input', '#review-follow-up-send', '#review-body']
      .map((selector) => [selector, document.createElement(selector.slice(1))]),
  )
  const root = { ownerDocument: document, querySelector: (selector: string) => elements.get(selector) ?? null }
  const view = new AiFollowUpView({ root: root as unknown as HTMLElement, send, viewProposal })
  view.bindEvents()
  const element = (selector: string): FakeElement => elements.get(selector)!
  const input = element('#review-follow-up-input')
  const sendButton = element('#review-follow-up-send')
  const type = (text: string): void => {
    input.value = text
    input.dispatch('input')
  }
  const key = (init: Partial<KeyboardEvent> = {}) => {
    const event = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, preventDefault: vi.fn(), ...init }
    input.dispatch('keydown', event)
    return event
  }
  return { view, document, element, input, sendButton, type, key, send }
}

const turn = (overrides: Partial<AiReviewFollowUp> = {}): AiReviewFollowUp => ({
  question: 'Why is it O(n)?',
  answer: '',
  status: 'streaming',
  usage: null,
  preparingProposal: false,
  proposal: null,
  live: emptyLiveUsage(),
  ...overrides,
})

describe('follow-up composer', () => {
  it('is disabled without a review and says why', () => {
    const { view, input, sendButton, type } = setup()
    view.update({ hasReview: false, help: false, busy: false })
    type('question')
    expect(input.disabled).toBe(true)
    expect(input.placeholder).toBe(AI_FOLLOW_UP_NO_REVIEW_PLACEHOLDER)
    expect(sendButton.disabled).toBe(true)
  })

  it('asks about the problem after AI help', () => {
    const { view, input } = setup()
    view.update({ hasReview: true, help: true, busy: false })
    expect(input.disabled).toBe(false)
    expect(input.placeholder).toBe(AI_FOLLOW_UP_HELP_PLACEHOLDER)
  })

  it('enables Send only for a non-empty question while no AI request runs', () => {
    const { view, input, sendButton, type } = setup()
    view.update({ hasReview: true, help: false, busy: false })
    expect(input.disabled).toBe(false)
    expect(input.placeholder).toBe(AI_FOLLOW_UP_PLACEHOLDER)
    expect(sendButton.disabled).toBe(true)
    type('  ')
    expect(sendButton.disabled).toBe(true)
    type('Why?')
    expect(sendButton.disabled).toBe(false)
    view.update({ hasReview: true, help: false, busy: true })
    expect(sendButton.disabled).toBe(true)
    expect(sendButton.title).toBe('Available when the current AI request finishes')
    // The draft stays editable while a request runs.
    expect(input.disabled).toBe(false)
  })

  it('sends on Enter, clears the input, and keeps focus in it', () => {
    const send = vi.fn(async () => true)
    const { view, input, type, key, document } = setup(send)
    view.update({ hasReview: true, help: false, busy: false })
    type('  Why O(n)?  ')
    const event = key()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('Why O(n)?')
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  it('leaves Shift+Enter, modified Enter, and IME composition to the textarea', () => {
    const send = vi.fn(async () => true)
    const { view, type, key } = setup(send)
    view.update({ hasReview: true, help: false, busy: false })
    type('line one')
    for (const init of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(key(init).preventDefault).not.toHaveBeenCalled()
    }
    expect(key({ key: 'a' }).preventDefault).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing on Enter while busy, empty, or without a review, and inserts no newline', () => {
    const send = vi.fn(async () => true)
    const { view, type, key, input } = setup(send)
    view.update({ hasReview: true, help: false, busy: true })
    type('Why?')
    expect(key().preventDefault).toHaveBeenCalled()
    view.update({ hasReview: true, help: false, busy: false })
    type(' ')
    key()
    view.update({ hasReview: false, help: false, busy: false })
    type('Why?')
    key()
    expect(send).not.toHaveBeenCalled()
    expect(input.value).toBe('Why?')
  })

  it('sends from the form submit and returns focus to the input', () => {
    const send = vi.fn(async () => true)
    const { view, type, element, input, sendButton, document } = setup(send)
    view.update({ hasReview: true, help: false, busy: false })
    type('Why?')
    sendButton.focus()
    const preventDefault = vi.fn()
    element('#review-follow-up-form').dispatch('submit', { preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('Why?')
    expect(document.activeElement).toBe(input)
  })

  it('puts an unanswered question back, ahead of anything typed since', async () => {
    let answer!: (answered: boolean) => void
    const send = vi.fn(() => new Promise<boolean>((resolve) => {
      answer = resolve
    }))
    const { view, type, key, input, sendButton } = setup(send)
    view.update({ hasReview: true, help: false, busy: false })
    type('First?')
    key()
    type('next draft')
    answer(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(input.value).toBe('First?\nnext draft')
    expect(sendButton.disabled).toBe(false)

    key()
    expect(send).toHaveBeenLastCalledWith('First?\nnext draft')
    expect(input.value).toBe('')
    answer(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(input.value).toBe('First?\nnext draft')
  })

  it('removes its listeners on dispose', () => {
    const { view, input, element } = setup()
    view.dispose()
    expect(input.listenerCount()).toBe(0)
    expect(element('#review-follow-up-form').listenerCount()).toBe(0)
  })

  it('sizes the box to its text plus borders so it never scrolls below its cap, and keeps the review in place', () => {
    const { view, input, element, document, type } = setup()
    const review = element('#review-body')
    // Collapsing the box to measure it lets the review above clamp its scroll position.
    let height = ''
    const style = {
      overflowY: '',
      get height() { return height },
      set height(value: string) {
        height = value
        if (value === 'auto') review.scrollTop = 0
      },
    }
    // A border-box textarea with 1px borders: offsetHeight - clientHeight is 2.
    const box = Object.assign(input, { style, offsetHeight: 30, clientHeight: 28, scrollHeight: 28 })
    view.update({ hasReview: true, help: false, busy: false })
    const section = view.renderConversation([turn({ answer: 'Each element is visited once.', status: 'done' })])!
    review.append(section)
    const rendered = [...section.children]
    review.scrollTop = 400

    type('Why?')
    expect([style.height, style.overflowY]).toEqual(['30px', 'hidden'])
    expect(review.scrollTop).toBe(400)

    box.scrollHeight = 500
    type('a\n'.repeat(30))
    expect([style.height, style.overflowY]).toEqual(['160px', 'auto'])

    // Typing touches only the composer: the conversation is neither rebuilt nor queued.
    expect(review.children).toEqual([section])
    expect(section.children).toEqual(rendered)
    expect(document.frames).toHaveLength(0)
  })
})

describe('follow-up conversation', () => {
  it('renders nothing without turns', () => {
    expect(setup().view.renderConversation([])).toBeNull()
  })

  it('shows each question with its answer as markdown and a pending cue before the first text', () => {
    const { view } = setup()
    const section = view.renderConversation([
      turn({ question: 'Q1', answer: 'Use **two** pointers.', status: 'done' }),
      turn({ question: '<b>Q2</b>' }),
    ]) as unknown as FakeElement

    expect(section.all('review-section-title').map((title) => title.textContent)).toEqual(['Follow-up'])
    const turns = section.all('review-turn')
    expect(turns).toHaveLength(2)
    expect(turns.map((element) => element.all('review-question')[0].textContent)).toEqual(['Q1', '<b>Q2</b>'])
    const [first, second] = turns.map((element) => element.all('review-answer')[0])
    expect(first.attributes.get('aria-busy')).toBe('false')
    expect(first.all('md-paragraph')[0].children.map((child) => child.tagName)).toEqual(['#text', 'strong', '#text'])
    expect(second.attributes.get('aria-busy')).toBe('true')
    expect(second.all('review-answer-pending')[0].attributes.get('aria-label')).toBe('Waiting for the answer')
  })

  it.each([
    ['truncated', 'The answer was cut off at the output limit.'],
    ['refused', 'The model declined to answer.'],
  ] as const)('notes a %s answer and keeps its text', (status, note) => {
    const section = setup().view.renderConversation([turn({ answer: 'Partial', status })]) as unknown as FakeElement
    expect(section.all('review-answer')[0].text()).toBe('Partial')
    expect(section.all('review-answer-note').map((element) => element.textContent)).toEqual([note])
    expect(section.all('review-answer-pending')).toHaveLength(0)
  })

  it('re-renders only the growing answer, once per frame', () => {
    const { view, document } = setup()
    const growing = turn()
    const section = view.renderConversation([turn({ answer: 'old', status: 'done' }), growing]) as unknown as FakeElement
    const [settled, streaming] = section.all('review-turn')
    const settledChildren = [...settled.children]

    growing.answer = '```java\nint x'
    view.updateTurn(growing)
    growing.answer += ' = 1;'
    view.updateTurn(growing)
    expect(document.frames).toHaveLength(1)
    expect(streaming.all('review-answer-pending')).toHaveLength(1)

    document.runFrames()
    expect(streaming.all('md-code')[0].className).toBe('md-code is-open')
    expect(streaming.all('md-code')[0].text()).toBe('int x = 1;')
    expect(settled.children).toEqual(settledChildren)
  })

  it('follows the stream only while the review is scrolled near its end', () => {
    const { view, document, element } = setup()
    const scroller = element('#review-body')
    const growing = turn()
    view.renderConversation([growing])
    Object.assign(scroller, { scrollHeight: 1_000, clientHeight: 200, scrollTop: 780 })
    growing.answer = 'more'
    view.updateTurn(growing)
    document.runFrames()
    expect(scroller.scrollTop).toBe(1_000)

    Object.assign(scroller, { scrollHeight: 1_200, scrollTop: 300 })
    view.updateTurn(growing)
    document.runFrames()
    expect(scroller.scrollTop).toBe(300)
  })

  it('applies a pending update to the conversation rendered after it was queued', () => {
    const { view, document } = setup()
    const growing = turn()
    view.renderConversation([growing])
    growing.answer = 'text'
    view.updateTurn(growing)
    const fresh = view.renderConversation([growing]) as unknown as FakeElement
    document.runFrames()
    expect(fresh.all('review-answer')[0].text()).toBe('text')
  })

  it('cancels a queued frame on dispose', () => {
    const { view, document } = setup()
    const growing = turn()
    view.renderConversation([growing])
    view.updateTurn(growing)
    view.dispose()
    expect(document.defaultView.cancelAnimationFrame).toHaveBeenCalledWith(1)
  })
})

describe('proposed code changes', () => {
  const proposal = (status: 'pending' | 'accepted' | 'rejected' = 'pending') => ({
    summary: 'Check the complement first.',
    code: 'new',
    baseCode: 'old',
    status,
    added: 3,
    removed: 1,
  })

  it('shows a spinner and a note while a change is prepared', () => {
    const { view, document } = setup()
    const growing = turn({ answer: 'Here.' })
    const section = view.renderConversation([growing]) as unknown as FakeElement
    expect(section.all('review-proposal-preparing')).toHaveLength(0)

    growing.preparingProposal = true
    view.updateTurn(growing)
    document.runFrames()
    const [preparing] = section.all('review-proposal-preparing')
    expect(preparing.attributes.get('role')).toBe('status')
    expect(preparing.text()).toBe(AI_PROPOSAL_PREPARING)
    expect(preparing.all('review-proposal-spinner')[0].attributes.get('aria-hidden')).toBe('true')

    // A settled turn no longer prepares anything.
    growing.status = 'done'
    view.updateTurn(growing)
    document.runFrames()
    expect(section.all('review-proposal-preparing')).toHaveLength(0)
  })

  it.each([
    ['pending', 'Not applied'],
    ['accepted', 'Applied'],
    ['rejected', 'Rejected'],
  ] as const)('shows a %s change with its summary, line counts, and status', (status, label) => {
    const section = setup(undefined, vi.fn()).view.renderConversation([
      turn({ answer: 'Here.', status: 'done', proposal: proposal(status) }),
    ]) as unknown as FakeElement
    const [card] = section.all('review-proposal')
    expect(card.className).toBe(`review-proposal is-${status}`)
    expect(card.all('review-proposal-title')[0].textContent).toBe('Proposed change')
    expect(card.all('review-proposal-summary')[0].textContent).toBe('Check the complement first.')
    expect(card.all('is-added')[0].textContent).toBe('+3')
    expect(card.all('is-removed')[0].textContent).toBe('−1')
    expect(card.all('review-proposal-stats')[0].attributes.get('aria-label')).toBe('3 lines added, 1 removed')
    expect(card.all('review-proposal-status')[0].textContent).toBe(label)
  })

  it('opens the diff for its turn from View diff', () => {
    const viewProposal = vi.fn()
    const changed = turn({ status: 'done', proposal: proposal() })
    const section = setup(undefined, viewProposal).view.renderConversation([changed]) as unknown as FakeElement
    const [button] = section.all('review-proposal-view')
    expect(button.tagName).toBe('button')
    expect(button.textContent).toBe('View diff')
    button.dispatch('click')
    expect(viewProposal).toHaveBeenCalledExactlyOnceWith(changed)
  })

  it.each(['accepted', 'rejected'] as const)('drops View diff once the change is %s', (status) => {
    const section = setup(undefined, vi.fn()).view.renderConversation([
      turn({ status: 'done', proposal: proposal(status) }),
    ]) as unknown as FakeElement
    const [card] = section.all('review-proposal')
    expect(card.all('review-proposal-view')).toHaveLength(0)
    expect(card.all('review-proposal-status')).toHaveLength(1)
    expect(card.all('review-proposal-summary')).toHaveLength(1)
  })

  it('has no View diff button without a handler, and no card without a change', () => {
    const section = setup().view.renderConversation([
      turn({ status: 'done', proposal: proposal() }),
      turn({ status: 'done' }),
    ]) as unknown as FakeElement
    expect(section.all('review-proposal')).toHaveLength(1)
    expect(section.all('review-proposal-view')).toHaveLength(0)
  })
})

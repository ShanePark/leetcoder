import { describe, expect, it } from 'vitest'

import type { AiReviewStream } from '../../../src/app/ai-controller'
import { AiReviewStreamView, aiReviewStreamStatus } from '../../../src/app/ai-review-stream-view'
import { emptyLiveUsage } from '../../../src/app/ai-usage-meter'

class FakeElement {
  className = ''
  textContent = ''
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes)
  }

  all(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...child.all(className),
    ])
  }

  texts(className: string): string[] {
    return this.all(className).map((element) => element.textContent)
  }
}

/** Frames and the one-second ticker run only when the test steps them. */
class FakeWindow {
  readonly frames = new Map<number, () => void>()
  readonly intervals = new Map<number, () => void>()
  private nextId = 1

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextId++
    this.frames.set(id, callback)
    return id
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id)
  }

  setInterval(callback: () => void): number {
    const id = this.nextId++
    this.intervals.set(id, callback)
    return id
  }

  clearInterval(id: number): void {
    this.intervals.delete(id)
  }

  frame(): void {
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) callback()
  }

  tick(): void {
    for (const callback of this.intervals.values()) callback()
  }
}

class FakeDocument {
  readonly defaultView = new FakeWindow()

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this)
  }
}

const stream = (overrides: Partial<AiReviewStream> = {}): AiReviewStream => ({
  fileName: 'Q1TwoSum.java',
  modelId: 'model-a',
  modelName: 'Model A',
  pricing: null,
  testRunOmitted: null,
  startedAt: 10_000,
  text: '',
  live: emptyLiveUsage(),
  ...overrides,
})

function setup() {
  const documentRef = new FakeDocument()
  const body = documentRef.createElement('div')
  const meter = documentRef.createElement('aside')
  meter.className = 'review-usage'
  let now = 10_000
  const view = new AiReviewStreamView({
    body: () => body as unknown as HTMLElement,
    meter: () => meter as unknown as HTMLElement,
    now: () => now,
  })
  return {
    view,
    body,
    meter,
    window: documentRef.defaultView,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('review stream status', () => {
  it('says the model is thinking until text arrives, with whole seconds and the model name', () => {
    expect(aiReviewStreamStatus(stream(), 10_999)).toBe('Thinking… 0s · Model A')
    expect(aiReviewStreamStatus(stream(), 12_400)).toBe('Thinking… 2s · Model A')
    expect(aiReviewStreamStatus(stream({ text: '{' }), 13_000)).toBe('Writing the review… 3s · Model A')
    // A clock that runs back never shows negative time.
    expect(aiReviewStreamStatus(stream(), 9_000)).toBe('Thinking… 0s · Model A')
  })
})

describe('review stream view', () => {
  it('renders at once with the status under the head and the meter beside the sections', () => {
    const { view, body, meter } = setup()
    view.show(stream())

    const layout = body.children[0]
    expect(layout.children.map((child) => child.className)).toEqual(['review-head', 'review-usage', 'review-main'])
    expect(layout.children[1]).toBe(meter)
    const status = layout.children[0].children.at(-1)!
    expect(status.className).toBe('review-stream-status')
    expect(status.children[0]).toMatchObject({ className: 'review-stream-spinner' })
    expect(status.children[0].attributes.get('aria-hidden')).toBe('true')
    expect(status.children[1].textContent).toBe('Thinking… 0s · Model A')
    expect(body.all('review-main')[0].attributes.get('aria-busy')).toBe('true')
  })

  it('coalesces text into one render a frame and keeps the same status element', () => {
    const { view, body, window } = setup()
    const current = stream()
    view.show(current)
    const status = body.all('review-stream-status')[0]

    current.text = '{"verdict":"incorrect","summary":"Mis'
    view.update()
    current.text += 'ses dup'
    view.update()
    expect(window.frames.size).toBe(1)
    expect(body.texts('review-summary')).toEqual([])
    window.frame()

    expect(body.all('review-verdict')[0].textContent).toBe('Incorrect')
    expect(body.texts('review-summary')).toEqual(['Misses dup'])
    expect(body.all('review-stream-status')[0]).toBe(status)
    expect(status.children[1].textContent).toBe('Writing the review… 0s · Model A')
  })

  it('ticks the seconds without rendering the sections again', () => {
    const { view, body, window, advance } = setup()
    view.show(stream({ text: '{"summary":"x"' }))
    const summary = body.all('review-summary')[0]
    advance(2_500)
    window.tick()
    expect(body.texts('review-stream-text')).toEqual(['Writing the review… 2s · Model A'])
    expect(body.all('review-summary')[0]).toBe(summary)
  })

  it('stops its frame and ticker when hidden, and renders nothing after', () => {
    const { view, body, window } = setup()
    view.show(stream())
    view.update()
    expect(window.intervals.size).toBe(1)
    view.hide()
    expect(view.stream).toBeNull()
    expect(window.frames.size).toBe(0)
    expect(window.intervals.size).toBe(0)
    body.replaceChildren()
    view.update()
    view.render()
    expect(body.children).toHaveLength(0)
  })

  it('replaces the stream it shows with a new one and its own ticker', () => {
    const { view, window } = setup()
    const first = stream()
    const second = stream({ modelName: 'Model B' })
    view.show(first)
    view.show(second)
    expect(view.stream).toBe(second)
    expect(window.intervals.size).toBe(1)
    view.dispose()
    expect(window.intervals.size).toBe(0)
  })
})

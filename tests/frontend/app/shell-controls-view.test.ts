import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGitState } from '../../../src/app/git-controller'
import { ShellControlsView } from '../../../src/app/shell-controls-view'
import type { AppState } from '../../../src/app/types'

vi.mock('../../../src/icons', () => ({
  iconFor: (name: string, className: string) => ({ icon: name, className }),
}))

class FakeTabElement {
  hidden = false
  tabIndex = 0
  private readonly classes = new Set<string>()
  private readonly attributes = new Map<string, string>()
  readonly classList = {
    toggle: (name: string, force: boolean): void => {
      if (force) this.classes.add(name)
      else this.classes.delete(name)
    },
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

function tabsRoot(): { root: HTMLElement; element: (selector: string) => FakeTabElement } {
  const elements = new Map(
    ['#tests-tab', '#review-tab', '#git-tab', '#tests-panel', '#review-panel', '#git-panel', '#run-test', '#git-tab-indicator']
      .map((selector) => [selector, new FakeTabElement()]),
  )
  const root = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
  } as unknown as HTMLElement
  return { root, element: (selector) => elements.get(selector)! }
}

describe('bottom panel tabs', () => {
  it('shows the Git change indicator on either tab only while work is pending', () => {
    const { root, element } = tabsRoot()
    const state = { bottomPanelTab: 'tests', git: createGitState() } as AppState
    const controls = new ShellControlsView({
      root,
      state,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
    })
    const indicator = element('#git-tab-indicator')

    controls.renderBottomPanelTabs()
    expect(indicator.hidden).toBe(true)

    state.git.loadedRepoPath = '/repo'
    state.git.unpushedCommitCount = 1
    controls.renderBottomPanelTabs()
    expect(element('#git-tab').getAttribute('aria-selected')).toBe('false')
    expect(indicator.hidden).toBe(false)

    state.bottomPanelTab = 'git'
    controls.renderBottomPanelTabs()
    expect(element('#git-tab').getAttribute('aria-selected')).toBe('true')
    expect(indicator.hidden).toBe(false)

    state.git.unpushedCommitCount = 0
    controls.renderBottomPanelTabs()
    expect(indicator.hidden).toBe(true)
  })

  it('shows only the selected panel of the three, and Run only with Tests', () => {
    const { root, element } = tabsRoot()
    const state = { bottomPanelTab: 'review', git: createGitState() } as AppState
    const controls = new ShellControlsView({
      root,
      state,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
    })

    controls.renderBottomPanelTabs()
    expect(element('#review-tab').getAttribute('aria-selected')).toBe('true')
    expect(element('#review-tab').tabIndex).toBe(0)
    expect(element('#tests-tab').tabIndex).toBe(-1)
    expect(element('#git-tab').tabIndex).toBe(-1)
    expect(element('#review-panel').hidden).toBe(false)
    expect(element('#tests-panel').hidden).toBe(true)
    expect(element('#git-panel').hidden).toBe(true)
    expect(element('#run-test').hidden).toBe(true)

    state.bottomPanelTab = 'tests'
    controls.renderBottomPanelTabs()
    expect(element('#review-panel').hidden).toBe(true)
    expect(element('#tests-panel').hidden).toBe(false)
    expect(element('#run-test').hidden).toBe(false)
  })
})

class FakeAiButton {
  hidden = false
  disabled = false
  title = ''
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  children: unknown[] = []
  renders = 0

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes
    this.renders += 1
  }
}

describe('AI action buttons', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function aiRoot(): { root: HTMLElement; review: FakeAiButton; generate: FakeAiButton } {
    const review = new FakeAiButton()
    const generate = new FakeAiButton()
    const elements = new Map<string, unknown>([['#ai-review-code', review], ['#ai-generate-tests', generate]])
    const root = { querySelector: (selector: string) => elements.get(selector) ?? null } as unknown as HTMLElement
    return { root, review, generate }
  }

  it('shows an icon and a caption that follows the mode, rebuilt only when either changes', () => {
    vi.stubGlobal('document', { createElement: () => ({ className: '', textContent: '' }) })
    const { root, review, generate } = aiRoot()
    const problem = {
      frontendId: '1',
      content: '<p>Example</p>',
    } as AppState['dailyProblem']
    const state = { selectedPath: 'src/Q1TwoSum.java', busy: false, dailyProblem: problem } as AppState
    let stub: 'bare' | 'filled' = 'bare'
    const controls = new ShellControlsView({
      root,
      state,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
      aiRequestKind: () => null,
      aiTestStub: () => stub,
      aiCaseTestAvailable: () => true,
    })

    controls.updateAiButton()
    expect(review.children).toEqual([
      { icon: 'review', className: 'button-icon' },
      { className: 'ai-action-label', textContent: 'AI review' },
    ])
    expect(review.attributes.get('aria-label')).toBe('Review code with AI')
    expect(generate.children).toEqual([
      { icon: 'sparkles', className: 'button-icon' },
      { className: 'ai-action-label', textContent: 'Fill test' },
    ])

    controls.updateAiButton()
    expect(generate.renders).toBe(1)

    stub = 'filled'
    controls.updateAiButton()
    expect(generate.renders).toBe(2)
    expect(generate.children).toEqual([
      { icon: 'circlePlus', className: 'button-icon' },
      { className: 'ai-action-label', textContent: 'Add case' },
    ])
    expect(generate.attributes.get('aria-label')).toBe('Add a failing case with AI')
  })
})

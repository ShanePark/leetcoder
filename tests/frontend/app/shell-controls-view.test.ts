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
    [
      '#tests-tab', '#review-tab', '#git-tab', '#tests-panel', '#review-panel', '#git-panel', '#run-test', '#run-selected-test', '#git-tab-indicator',
      '#sidebar-problems-tab', '#sidebar-description-tab', '#sidebar-problems-panel', '#sidebar-description-panel',
      '#sidebar-toggle',
    ]
      .map((selector) => [selector, new FakeTabElement()]),
  )
  const root = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
  } as unknown as HTMLElement
  return { root, element: (selector) => elements.get(selector)! }
}

describe('sidebar tabs', () => {
  it('selects one tab, keeps only its panel visible, and leaves the other tab out of the tab order', () => {
    const { root, element } = tabsRoot()
    const controls = new ShellControlsView({
      root,
      state: { bottomPanelTab: 'tests', git: createGitState() } as AppState,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
    })

    controls.renderSidebarTabs('description', false)
    expect(element('#sidebar-description-tab').getAttribute('aria-selected')).toBe('true')
    expect(element('#sidebar-description-tab').tabIndex).toBe(0)
    expect(element('#sidebar-problems-tab').getAttribute('aria-selected')).toBe('false')
    expect(element('#sidebar-problems-tab').tabIndex).toBe(-1)
    expect(element('#sidebar-description-panel').hidden).toBe(false)
    expect(element('#sidebar-problems-panel').hidden).toBe(true)

    controls.renderSidebarTabs('problems', false)
    expect(element('#sidebar-problems-tab').getAttribute('aria-selected')).toBe('true')
    expect(element('#sidebar-problems-tab').tabIndex).toBe(0)
    expect(element('#sidebar-description-tab').tabIndex).toBe(-1)
    expect(element('#sidebar-problems-panel').hidden).toBe(false)
    expect(element('#sidebar-description-panel').hidden).toBe(true)
  })

  it('presses the header toggle only while the Problems tab is on screen', () => {
    const { root, element } = tabsRoot()
    const controls = new ShellControlsView({
      root,
      state: { bottomPanelTab: 'tests', git: createGitState() } as AppState,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
    })
    const pressed = (): string | null => element('#sidebar-toggle').getAttribute('aria-pressed')

    controls.renderSidebarTabs('problems', false)
    expect(pressed()).toBe('true')
    controls.renderSidebarTabs('description', false)
    expect(pressed()).toBe('false')
    controls.renderSidebarTabs('problems', true)
    expect(pressed()).toBe('false')
  })
})

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

  it('shows only the selected panel of the three, and both run buttons only with Tests', () => {
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
    expect(element('#run-selected-test').hidden).toBe(true)

    state.bottomPanelTab = 'tests'
    controls.renderBottomPanelTabs()
    expect(element('#review-panel').hidden).toBe(true)
    expect(element('#tests-panel').hidden).toBe(false)
    expect(element('#run-test').hidden).toBe(false)
    expect(element('#run-selected-test').hidden).toBe(false)

    state.bottomPanelTab = 'git'
    controls.renderBottomPanelTabs()
    expect(element('#git-panel').hidden).toBe(false)
    expect(element('#run-test').hidden).toBe(true)
    expect(element('#run-selected-test').hidden).toBe(true)
  })
})

class FakeRunButton {
  disabled = false
  title = ''
  readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
}

describe('Run selected button', () => {
  function runSelected(state: Partial<AppState>, method: string | null, mac = false): FakeRunButton {
    const button = new FakeRunButton()
    const root = {
      querySelector: (selector: string) => selector === '#run-selected-test' ? button : null,
    } as unknown as HTMLElement
    const controls = new ShellControlsView({
      root,
      state: { busy: false, testRun: null, selectedFqcn: 'easy.Q1TwoSum', ...state } as AppState,
      pickerOpen: () => false,
      macPlatform: () => mac,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
      aiRequestKind: () => null,
      aiRequestReviewMode: () => null,
      aiTestStub: () => 'filled',
      aiCaseTestAvailable: () => false,
      testMethodAtCursor: () => method,
    })
    controls.updateRunSelectedButton()
    return button
  }

  it('targets the @Test method at the cursor with the shortcut from the registry', () => {
    const button = runSelected({}, 'returnsPair')
    expect(button.disabled).toBe(false)
    expect(button.title).toBe('Run returnsPair() (Ctrl+Shift+R)')
    expect(button.attributes.get('aria-label')).toBe('Run returnsPair() (Ctrl+Shift+R)')
    expect(runSelected({}, 'returnsPair', true).title).toBe('Run returnsPair() (⌃⇧R)')
  })

  it('is disabled with a reason off a test method, without a problem file, or while busy', () => {
    const offMethod = runSelected({}, null)
    expect(offMethod.disabled).toBe(true)
    expect(offMethod.title).toBe('Put the cursor in an @Test method to run only that test')
    expect(offMethod.attributes.get('aria-label')).toBe('Run selected test (Ctrl+Shift+R)')

    const noFile = runSelected({ selectedFqcn: null }, 'returnsPair')
    expect(noFile.disabled).toBe(true)
    expect(noFile.title).toBe('Select a Java problem file to run')

    expect(runSelected({ busy: true }, 'returnsPair').disabled).toBe(true)
  })

  it('stays disabled during a run instead of becoming a second Stop button', () => {
    const button = runSelected({
      busy: true,
      testRun: { status: 'running', stopRequested: false } as AppState['testRun'],
    }, 'returnsPair')
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Wait for the current test run to finish')
    expect(button.attributes.get('aria-label')).toBe('Run selected test (Ctrl+Shift+R)')
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
    const state = {
      selectedPath: 'src/Q1TwoSum.java',
      selectedSource: 'class Q1TwoSum {\n    int solve() {\n        return 0;\n    }\n}',
      busy: false,
      dailyProblem: problem,
    } as AppState
    let stub: 'bare' | 'filled' = 'bare'
    const controls = new ShellControlsView({
      root,
      state,
      pickerOpen: () => false,
      macPlatform: () => false,
      invalidatePendingNavigation: () => {},
      aiRequestPath: () => null,
      aiRequestKind: () => null,
      aiRequestReviewMode: () => null,
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

    state.selectedSource = 'class Q1TwoSum {\n    int solve() {\n        // later\n    }\n}'
    controls.updateAiButton()
    expect(review.children).toEqual([
      { icon: 'lightbulb', className: 'button-icon' },
      { className: 'ai-action-label', textContent: 'AI help' },
    ])
    expect(review.attributes.get('aria-label')).toBe('Get hints from AI')
  })
})

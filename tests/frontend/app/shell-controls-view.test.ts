import { describe, expect, it } from 'vitest'

import { createGitState } from '../../../src/app/git-controller'
import { ShellControlsView } from '../../../src/app/shell-controls-view'
import type { AppState } from '../../../src/app/types'

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
    ['#tests-tab', '#git-tab', '#tests-panel', '#git-panel', '#run-test', '#git-tab-indicator']
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
})

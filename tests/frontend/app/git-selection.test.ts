import { describe, expect, it } from 'vitest'

import { selectedGitFiles, updateGitCommitControls } from '../../../src/app/git-view'
import { createGitState } from '../../../src/app/git-controller'
import { renderDiscardGitDialog } from '../../../src/app/dialogs-view'
import type { GitChangedFile } from '../../../src/app/types'

describe('Git selection indexing', () => {
  it('filters changed files in repository order with constant-time membership checks', () => {
    const files: GitChangedFile[] = [
      { path: 'Q1.java', status: 'modified', staged: false, additions: null, deletions: null },
      { path: 'Q2.java', status: 'added', staged: false, additions: 2, deletions: null },
      { path: 'Q3.java', status: 'deleted', staged: true, additions: null, deletions: 3 },
    ]

    expect(selectedGitFiles(files, new Set(['Q3.java', 'missing.java', 'Q1.java']))).toEqual([
      files[0],
      files[2],
    ])
  })
})


describe('Git selection controls', () => {
  it('reflects empty, partial, all, cleared and busy selection in the heading checkbox', () => {
    const elements = new Map<string, { disabled: boolean; checked?: boolean; indeterminate?: boolean }>()
    const root = { querySelector: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { disabled: false })
      return elements.get(selector)
    } } as unknown as HTMLElement
    const git = createGitState()
    const model = { bottomPanelTab: 'git' as const, busy: false, git }
    const update = () => updateGitCommitControls(root, model)
    update()
    const checkbox = elements.get('#git-select-all-checkbox')!
    expect(checkbox).toMatchObject({ checked: false, indeterminate: false, disabled: true })
    git.files = ['Q1.java', 'Q2.java'].map((path) => ({
      path, status: 'M', staged: false, additions: null, deletions: null,
    }))
    git.selectedPaths = ['Q1.java', 'stale.java']
    update()
    expect(checkbox).toMatchObject({ checked: false, indeterminate: true, disabled: false })
    git.selectedPaths = ['Q1.java', 'Q2.java', 'stale.java']
    update()
    expect(checkbox).toMatchObject({ checked: true, indeterminate: false, disabled: false })
    git.selectedPaths = []
    update()
    expect(checkbox).toMatchObject({ checked: false, indeterminate: false, disabled: false })
    for (const state of ['busy', 'loading'] as const) {
      git[state] = true
      update()
      expect(checkbox.disabled).toBe(true)
      git[state] = false
    }
    model.busy = true
    update()
    expect(checkbox.disabled).toBe(true)
  })

  it('lists every snapshotted path in the destructive confirmation', () => {
    const elements = new Map<string, { textContent: string; hidden: boolean }>()
    const root = { querySelector: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false })
      return elements.get(selector)
    } } as unknown as HTMLElement
    const files = ['Q1.java', 'Q2.java'].map((path) => ({
      path, status: 'M', staged: false, additions: null, deletions: null,
    }))
    renderDiscardGitDialog(root, { files, busy: false, gitBusy: false })
    expect(elements.get('#discard-git-path')?.textContent).toBe('Q1.java\nQ2.java')
    expect(elements.get('#discard-git-message')?.textContent).toContain('cannot be undone')
  })
})

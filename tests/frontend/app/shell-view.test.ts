import { describe, expect, it } from 'vitest'

import { renderShellView } from '../../../src/app/shell-view'

function shellMarkup(macPlatform: boolean): string {
  const root = { innerHTML: '' } as HTMLElement
  renderShellView(root, {
    appVersion: '0',
    macPlatform,
    minSidebarWidth: 0,
    maxSidebarWidth: 0,
    minDailyDescriptionHeight: 0,
    maxDailyDescriptionHeight: 0,
    minBottomPanelHeight: 0,
    maxBottomPanelHeight: 0,
    minGitFileListWidth: 0,
    maxGitFileListWidth: 0,
  })
  return root.innerHTML
}

function elementMarkup(markup: string, id: string): string {
  return new RegExp(`<button id="${id}"[\\s\\S]*?</button>`).exec(markup)?.[0] ?? ''
}

describe('shell markup', () => {
  it('places the sidebar toggle right after the application menu button', () => {
    const markup = shellMarkup(false)
    expect(markup).toMatch(/id="app-menu-button"[^>]*><\/button>\s*<button id="sidebar-toggle"/)
    const toggle = elementMarkup(markup, 'sidebar-toggle')
    expect(toggle).toContain('aria-label="Problems"')
    expect(toggle).toContain('aria-controls="sidebar"')
    expect(toggle).toContain('aria-pressed="true"')
    expect(toggle).toContain('title="Problems (Alt+1)"')
    expect(elementMarkup(shellMarkup(true), 'sidebar-toggle')).toContain('title="Problems (⌘1)"')
  })

  it('gives the sidebar toggle and bottom tabs hidden keytips with platform labels', () => {
    const keytip = (label: string) => `<span class="keytip" aria-hidden="true">${label}</span>`
    const linux = shellMarkup(false)
    expect(elementMarkup(linux, 'sidebar-toggle')).toContain(keytip('Alt+1'))
    expect(elementMarkup(linux, 'tests-tab')).toContain(keytip('Alt+4'))
    expect(elementMarkup(linux, 'git-tab')).toContain(keytip('Alt+9'))
    const mac = shellMarkup(true)
    expect(elementMarkup(mac, 'sidebar-toggle')).toContain(keytip('⌘1'))
    expect(elementMarkup(mac, 'tests-tab')).toContain(keytip('⌘4'))
    expect(elementMarkup(mac, 'git-tab')).toContain(keytip('⌘9'))
    // Tabs carry no inline shortcut text that would widen them.
    expect(elementMarkup(linux, 'tests-tab')).not.toContain('<kbd')
    expect(elementMarkup(linux, 'git-tab')).not.toContain('<kbd')
  })
  it('puts the review button before the generate button and the AI tab between Tests and Git', () => {
    const markup = shellMarkup(false)
    const review = elementMarkup(markup, 'ai-review-code')
    expect(review).toContain('aria-label="Review code with AI"')
    expect(review).toContain('hidden')
    // Captioned AI actions, not square icon buttons.
    expect(review).toContain('class="ai-action-button"')
    expect(elementMarkup(markup, 'ai-generate-tests')).toContain('class="ai-action-button"')
    expect(markup.indexOf('id="ai-review-code"')).toBeLessThan(markup.indexOf('id="ai-generate-tests"'))

    const tabs = ['tests-tab', 'review-tab', 'git-tab'].map((id) => markup.indexOf(`id="${id}"`))
    expect(tabs).toEqual([...tabs].sort((a, b) => a - b))
    expect(elementMarkup(markup, 'review-tab')).not.toContain('keytip')
    expect(elementMarkup(markup, 'review-tab')).toMatch(/>\s*AI\s*</)
    expect(markup).toMatch(/<section id="review-panel"[^>]*aria-labelledby="review-tab"[^>]*hidden>/)
  })

  it('offers Run selected and Run as buttons with registry shortcuts, and no separate status row', () => {
    const linux = shellMarkup(false)
    const selected = elementMarkup(linux, 'run-selected-test')
    expect(selected).toContain('class="secondary-button"')
    expect(selected).toContain('Run selected <kbd id="run-selected-shortcut">Ctrl+Shift+R</kbd>')
    expect(elementMarkup(linux, 'run-test')).toContain('<kbd id="run-shortcut">Ctrl+R</kbd>')
    expect(linux.indexOf('id="run-selected-test"')).toBeLessThan(linux.indexOf('id="run-test"'))
    expect(elementMarkup(shellMarkup(true), 'run-selected-test')).toContain('<kbd id="run-selected-shortcut">⌃⇧R</kbd>')
    expect(linux).not.toContain('selected-test-shortcut-hint')
    expect(linux).not.toContain('test-status-row')
  })
})

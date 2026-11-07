import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBackend, installDom, startApp, type DomHarness } from './lifecycle-harness'
import { testMocks } from './lifecycle-mocks'

describe('LLM settings wiring in the app', () => {
  let dom: DomHarness | null = null

  afterEach(() => {
    dom?.restore()
    dom = null
  })

  it('reaches the backend only when the tab activates, not on start or app renders', async () => {
    dom = installDom()
    const { root } = dom
    const { backend } = createBackend()
    const app = await startApp(dom, backend)
    const renderAll = (): void => (app as unknown as { renderAll: () => void }).renderAll()

    renderAll()
    expect(backend.aiStatus).not.toHaveBeenCalled()
    expect(backend.aiUsage).not.toHaveBeenCalled()
    expect(backend.aiListModels).not.toHaveBeenCalled()

    testMocks.overlayOptions[0]?.llmSettings?.activate()
    renderAll()
    renderAll()
    await vi.waitFor(() => {
      expect(root.querySelector('#llm-key-status').textContent).toBe('No key saved')
    })
    expect(backend.aiStatus).toHaveBeenCalledOnce()
    expect(backend.aiUsage).toHaveBeenCalledOnce()
    expect(backend.aiListModels).not.toHaveBeenCalled()

    await app.destroy()
  })
})

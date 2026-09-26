import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PsLibraryMetadata } from '../../../src/backend'
import {
  PS_LIBRARY_CONFIG_DEBOUNCE_MS,
  PS_LIBRARY_REVALIDATE_INTERVAL_MS,
  PsLibraryController,
  isPsBuildConfigurationPath,
} from '../../../src/app/ps-library-controller'

const metadata: PsLibraryMetadata = {
  fingerprint: 'psh-1.2.1',
  methods: [{
    name: 'strList',
    returnType: 'List<List<String>>',
    parameters: [{ name: 'input', typeName: 'String' }],
  }],
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createController(inspectPsLibrary: (repoPath: string) => Promise<PsLibraryMetadata>) {
  const setMetadata = vi.fn<(next: PsLibraryMetadata | null) => void>()
  const setMessage = vi.fn<(message: string, tone: 'error') => void>()
  const controller = new PsLibraryController({
    backend: { inspectPsLibrary },
    setMetadata,
    setMessage,
  })
  return { controller, setMetadata, setMessage }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PsLibraryController', () => {
  it('loads signatures for the selected repository and clears them when it changes', async () => {
    const inspect = vi.fn().mockResolvedValue(metadata)
    const { controller, setMetadata } = createController(inspect)

    controller.setRepository('/repo-one')
    await flushPromises()
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith('/repo-one')
    expect(setMetadata).toHaveBeenLastCalledWith(metadata)

    controller.setRepository('/repo-two')
    expect(setMetadata).toHaveBeenLastCalledWith(null)
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(inspect).toHaveBeenLastCalledWith('/repo-two')
    expect(setMetadata).toHaveBeenLastCalledWith(metadata)
    controller.dispose()
  })

  it('discards an old result and performs one latest-repository rerun after config events', async () => {
    const first = deferred<PsLibraryMetadata>()
    const second = deferred<PsLibraryMetadata>()
    const inspect = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { controller, setMetadata } = createController(inspect)

    controller.setRepository('/repo-one')
    controller.setRepository('/repo-two')
    controller.invalidate()
    controller.invalidate()
    expect(setMetadata).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(PS_LIBRARY_CONFIG_DEBOUNCE_MS)
    expect(inspect).toHaveBeenCalledOnce()

    first.resolve(metadata)
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(inspect).toHaveBeenLastCalledWith('/repo-two')
    expect(setMetadata).not.toHaveBeenCalledWith(metadata)

    second.resolve(metadata)
    await flushPromises()
    expect(setMetadata).toHaveBeenLastCalledWith(metadata)
    controller.dispose()
  })

  it('debounces repeated Gradle invalidations into one inspection', async () => {
    const inspect = vi.fn().mockResolvedValue(metadata)
    const { controller } = createController(inspect)
    controller.setRepository('/repo')
    await flushPromises()

    controller.invalidate()
    await vi.advanceTimersByTimeAsync(100)
    controller.invalidate()
    await vi.advanceTimersByTimeAsync(100)
    controller.invalidate()
    await vi.advanceTimersByTimeAsync(PS_LIBRARY_CONFIG_DEBOUNCE_MS - 1)
    expect(inspect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(inspect).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('throttles focus revalidation and reports a repeated failure only once', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('Gradle sync failed'))
    const { controller, setMessage, setMetadata } = createController(inspect)
    controller.setRepository('/repo')
    await flushPromises()

    expect(setMetadata).toHaveBeenLastCalledWith(null)
    expect(setMessage).toHaveBeenCalledOnce()
    expect(setMessage.mock.calls[0]?.[0]).toContain('Gradle sync failed')
    controller.revalidateIfStale()
    expect(inspect).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(PS_LIBRARY_REVALIDATE_INTERVAL_MS)
    controller.revalidateIfStale()
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(setMessage).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('does not call an inspection endpoint that an older backend does not provide', () => {
    const setMetadata = vi.fn()
    const setMessage = vi.fn()
    const controller = new PsLibraryController({
      backend: {},
      setMetadata,
      setMessage,
    })
    expect(() => controller.setRepository('/repo')).not.toThrow()
    expect(setMetadata).toHaveBeenLastCalledWith(null)
    expect(setMessage).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores late results and scheduled work after disposal', async () => {
    const pending = deferred<PsLibraryMetadata>()
    const inspect = vi.fn().mockReturnValue(pending.promise)
    const { controller, setMetadata } = createController(inspect)
    controller.setRepository('/repo')
    controller.invalidate()
    controller.dispose()
    pending.resolve(metadata)

    await flushPromises()
    await vi.advanceTimersByTimeAsync(PS_LIBRARY_CONFIG_DEBOUNCE_MS)
    expect(inspect).toHaveBeenCalledOnce()
    expect(setMetadata).toHaveBeenLastCalledWith(null)
  })
})

describe('isPsBuildConfigurationPath', () => {
  it.each([
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'gradle/libs.versions.toml',
    'gradle/test-libs.versions.toml',
    'gradle/wrapper/gradle-wrapper.properties',
    '.\\gradle\\libs.versions.toml',
  ])('recognizes %s', (path) => {
    expect(isPsBuildConfigurationPath(path)).toBe(true)
  })

  it.each([
    'src/main/java/Q1.java',
    'package.json',
    'gradle/verification-metadata.xml',
    'gradle/wrapper/gradle-wrapper.jar',
    'nested/build.gradle',
  ])('ignores %s', (path) => {
    expect(isPsBuildConfigurationPath(path)).toBe(false)
  })
})

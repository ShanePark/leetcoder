import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JavaTypeMembers, JavaTypeMembersMetadata } from '../../../src/backend'
import {
  JAVA_TYPE_MEMBERS_CONFIG_DEBOUNCE_MS,
  JAVA_TYPE_MEMBERS_REVALIDATE_INTERVAL_MS,
  JavaTypeMembersController,
} from '../../../src/app/java-type-members-controller'

function member(typeName: string, available = true): JavaTypeMembers {
  return {
    typeName,
    available,
    methods: available ? [{
      name: 'push',
      returnType: 'java.lang.Object',
      parameters: [{ name: 'item', typeName: 'java.lang.Object' }],
      isStatic: false,
    }] : [],
    fields: [],
  }
}

function metadata(typeNames: string[], fingerprint = 'classpath-1'): JavaTypeMembersMetadata {
  return { fingerprint, types: typeNames.map((typeName) => member(typeName)) }
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

function createController(inspectJavaTypeMembers: (repoPath: string, typeNames: string[]) => Promise<JavaTypeMembersMetadata>) {
  const inspect = vi.fn(inspectJavaTypeMembers)
  const controller = new JavaTypeMembersController({ backend: { inspectJavaTypeMembers: inspect } })
  return { controller, inspect }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('JavaTypeMembersController', () => {
  it('lazily loads, batches, and caches public members including negative type results', async () => {
    const inspect = vi.fn(async (_repoPath: string, typeNames: string[]) => ({
      fingerprint: 'classpath-1',
      types: typeNames.map((typeName) => member(typeName, typeName !== 'missing.Type')),
    }))
    const { controller } = createController(inspect)
    controller.setRepository('/repo')

    const first = controller.inspect(['java.util.Stack', 'missing.Type', 'java.util.Stack'])
    const second = controller.inspect(['java.util.List'])
    await flushPromises()

    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledWith('/repo', ['java.util.Stack', 'missing.Type', 'java.util.List'])
    const [firstMetadata, secondMetadata] = await Promise.all([first, second])
    expect(firstMetadata.types.map(({ typeName, available }) => [typeName, available])).toEqual([
      ['java.util.Stack', true],
      ['missing.Type', false],
    ])
    expect(secondMetadata.types[0]?.typeName).toBe('java.util.List')

    const cached = await controller.inspect(['java.util.Stack', 'missing.Type'])
    expect(inspect).toHaveBeenCalledOnce()
    expect(cached.types[0]?.methods[0]?.name).toBe('push')
    controller.dispose()
  })

  it('reuses overlapping in-flight requests and queues only newly requested types', async () => {
    const first = deferred<JavaTypeMembersMetadata>()
    const second = deferred<JavaTypeMembersMetadata>()
    const { controller, inspect } = createController(vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise))
    controller.setRepository('/repo')

    const initial = controller.inspect(['java.util.Stack'])
    await flushPromises()
    const overlap = controller.inspect(['java.util.Stack', 'java.util.List'])
    first.resolve(metadata(['java.util.Stack']))
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(inspect).toHaveBeenLastCalledWith('/repo', ['java.util.List'])
    second.resolve(metadata(['java.util.List']))
    const [initialResult, overlapResult] = await Promise.all([initial, overlap])
    expect(initialResult.types[0]?.typeName).toBe('java.util.Stack')
    expect(overlapResult.types.map(({ typeName }) => typeName)).toEqual(['java.util.Stack', 'java.util.List'])
    controller.dispose()
  })

  it('ignores an old repository result and requests the type from the new repository', async () => {
    const old = deferred<JavaTypeMembersMetadata>()
    const current = deferred<JavaTypeMembersMetadata>()
    const { controller, inspect } = createController(vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise))
    controller.setRepository('/old-repo')
    const oldRequest = controller.inspect(['java.util.Stack'])
    await flushPromises()

    controller.setRepository('/new-repo')
    const currentRequest = controller.inspect(['java.util.Stack'])
    await flushPromises()
    old.resolve(metadata(['java.util.Stack'], 'old-classpath'))
    await flushPromises()
    current.resolve(metadata(['java.util.Stack'], 'new-classpath'))

    const result = await currentRequest
    expect(inspect).toHaveBeenNthCalledWith(1, '/old-repo', ['java.util.Stack'])
    expect(inspect).toHaveBeenNthCalledWith(2, '/new-repo', ['java.util.Stack'])
    expect(result.fingerprint).toBe('new-classpath')
    expect(result.types[0]?.methods[0]?.name).toBe('push')
    await oldRequest
    controller.dispose()
  })

  it('refreshes earlier JDK metadata once when the project classpath first resolves', async () => {
    const { controller, inspect } = createController(vi.fn()
      .mockResolvedValueOnce(metadata(['java.lang.String'], 'jdk=21;classpath=unresolved'))
      .mockResolvedValueOnce(metadata(['java.util.Stack'], 'jdk=21;classpath=resolved-1'))
      .mockResolvedValueOnce(metadata(['java.lang.String'], 'jdk=21;classpath=resolved-1')))
    controller.setRepository('/repo')

    await controller.inspect(['java.lang.String'])
    await controller.inspect(['java.util.Stack'])
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(inspect).toHaveBeenNthCalledWith(3, '/repo', ['java.lang.String'])

    const cached = await controller.inspect(['java.lang.String'])
    expect(cached.fingerprint).toBe('jdk=21;classpath=resolved-1')
    expect(inspect).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  it('debounces classpath invalidation and refreshes waiting requests', async () => {
    const old = deferred<JavaTypeMembersMetadata>()
    const refreshed = deferred<JavaTypeMembersMetadata>()
    const { controller, inspect } = createController(vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(refreshed.promise))
    controller.setRepository('/repo')
    const initial = controller.inspect(['java.util.Stack'])
    await flushPromises()

    controller.invalidate()
    const afterChange = controller.inspect(['java.util.Stack'])
    old.resolve(metadata(['java.util.Stack'], 'old-classpath'))
    await flushPromises()
    expect(inspect).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(JAVA_TYPE_MEMBERS_CONFIG_DEBOUNCE_MS)
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    refreshed.resolve(metadata(['java.util.Stack'], 'new-classpath'))
    const result = await afterChange
    expect(result.fingerprint).toBe('new-classpath')
    await initial
    controller.dispose()
  })

  it('caches a failed batch and retries after stale revalidation', async () => {
    const { controller, inspect } = createController(vi.fn()
      .mockRejectedValueOnce(new Error('Gradle unavailable'))
      .mockResolvedValueOnce(metadata(['java.util.Stack'], 'recovered-classpath')))
    controller.setRepository('/repo')

    const failed = await controller.inspect(['java.util.Stack'])
    expect(failed.types[0]?.available).toBe(false)
    await controller.inspect(['java.util.Stack'])
    expect(inspect).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(JAVA_TYPE_MEMBERS_REVALIDATE_INTERVAL_MS)
    controller.revalidateIfStale()
    await flushPromises()
    expect(inspect).toHaveBeenCalledTimes(2)
    const recovered = await controller.inspect(['java.util.Stack'])
    expect(recovered.fingerprint).toBe('recovered-classpath')
    expect(recovered.types[0]?.available).toBe(true)
    controller.dispose()
  })

  it('splits inspection batches at the backend limit', async () => {
    const { controller, inspect } = createController(async (_repoPath, typeNames) => metadata(typeNames))
    controller.setRepository('/repo')
    const names = Array.from({ length: 40 }, (_, index) => `example.Type${index}`)

    const result = controller.inspect(names)
    await flushPromises()
    await result

    expect(inspect).toHaveBeenCalledTimes(3)
    expect(inspect.mock.calls.map(([, typeNames]) => typeNames.length)).toEqual([16, 16, 8])
    controller.dispose()
  })
})

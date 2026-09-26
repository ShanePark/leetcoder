import { describe, expect, it } from 'vitest'

import { createBackendClient, type Invoke, normalizePsLibraryMetadata } from '../../../src/backend'

describe('Ps library backend', () => {
  it('invokes the native inspection command and preserves overloaded generic signatures', async () => {
    const metadata = {
      fingerprint: 'sha256:project-classpath',
      methods: [
        {
          name: 'strList',
          returnType: 'java.util.List<java.util.List<java.lang.String>>',
          parameters: [{ name: null, typeName: 'java.lang.String' }],
        },
        {
          name: 'strList',
          returnType: 'java.util.List<java.util.List<java.lang.String>>',
          parameters: [{ name: 'rows', typeName: 'java.lang.String[]' }],
        },
        {
          name: 'intList',
          returnType: 'java.util.List<java.util.List<java.lang.Integer>>',
          parameters: [{ name: null, typeName: 'java.lang.String' }],
        },
      ],
    }
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args })
      return metadata
    }

    await expect(createBackendClient(invoke).inspectPsLibrary('/repo')).resolves.toEqual(metadata)
    expect(calls).toEqual([
      { command: 'inspect_ps_library', args: { repoPath: '/repo' } },
    ])
  })

  it('represents a missing Ps class with an empty method list', async () => {
    const invoke: Invoke = async () => ({ fingerprint: 'sha256:no-ps-class', methods: [] })

    await expect(createBackendClient(invoke).inspectPsLibrary('/repo')).resolves.toEqual({
      fingerprint: 'sha256:no-ps-class',
      methods: [],
    })
  })

  it('accepts the native snake-case method and parameter type fields', () => {
    expect(normalizePsLibraryMetadata({
      fingerprint: 'classpath-v1',
      methods: [{
        name: 'strList',
        return_type: 'java.util.List<java.util.List<java.lang.String>>',
        parameters: [{ name: null, type_name: 'java.lang.String' }],
      }],
    })).toEqual({
      fingerprint: 'classpath-v1',
      methods: [{
        name: 'strList',
        returnType: 'java.util.List<java.util.List<java.lang.String>>',
        parameters: [{ name: null, typeName: 'java.lang.String' }],
      }],
    })
  })

  it.each([
    null,
    {},
    { fingerprint: 'no-methods-field' },
    { fingerprint: 'bad-method', methods: [{ name: 'strList', returnType: '', parameters: [] }] },
    { fingerprint: 'bad-parameter', methods: [{ name: 'strList', returnType: 'String', parameters: [{ name: 'value' }] }] },
    { fingerprint: 'bad-name', methods: [{ name: 'strList', returnType: 'String', parameters: [{ name: 7, typeName: 'String' }] }] },
  ])('rejects malformed inspection metadata: %j', async (metadata) => {
    const invoke: Invoke = async () => metadata

    await expect(createBackendClient(invoke).inspectPsLibrary('/repo')).rejects.toThrow(/invalid/)
  })
})

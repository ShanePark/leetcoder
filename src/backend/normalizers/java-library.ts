import type { PsLibraryMetadata, PsMethod, PsParameter } from '../contracts'
import { isRecord } from './common'

/** Validate method metadata discovered from a project's Java classpath. */
export function normalizePsLibraryMetadata(value: unknown): PsLibraryMetadata {
  if (!isRecord(value) || typeof value.fingerprint !== 'string' || !Array.isArray(value.methods)) {
    throw new Error('The Ps library metadata response was invalid.')
  }

  return {
    fingerprint: value.fingerprint,
    methods: value.methods.map(normalizePsMethod),
  }
}

function normalizePsMethod(value: unknown): PsMethod {
  if (!isRecord(value)) {
    throw new Error('The Ps library metadata contained an invalid method.')
  }

  const name = nonEmptyString(value.name)
  const returnType = nonEmptyString(
    value.returnType !== undefined ? value.returnType : value.return_type,
  )
  if (!name || !returnType || !Array.isArray(value.parameters)) {
    throw new Error('The Ps library metadata contained an invalid method.')
  }

  return {
    name,
    returnType,
    parameters: value.parameters.map(normalizePsParameter),
  }
}

function normalizePsParameter(value: unknown): PsParameter {
  if (!isRecord(value)) {
    throw new Error('The Ps library metadata contained an invalid parameter.')
  }

  const typeName = nonEmptyString(value.typeName !== undefined ? value.typeName : value.type_name)
  const name = value.name
  if (!typeName || (name !== null && (typeof name !== 'string' || name.length === 0))) {
    throw new Error('The Ps library metadata contained an invalid parameter.')
  }

  return { name, typeName }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

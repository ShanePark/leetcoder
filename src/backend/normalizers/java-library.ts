import type {
  JavaFieldMember,
  JavaMemberParameter,
  JavaMethodMember,
  JavaTypeMembers,
  JavaTypeMembersMetadata,
  PsLibraryMetadata,
  PsMethod,
  PsParameter,
} from '../contracts'
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

/** Validate public member metadata discovered for a batch of Java types. */
export function normalizeJavaTypeMembersMetadata(value: unknown): JavaTypeMembersMetadata {
  if (!isRecord(value) || typeof value.fingerprint !== 'string' || !Array.isArray(value.types)) {
    throw new Error('The Java type member metadata response was invalid.')
  }

  return {
    fingerprint: value.fingerprint,
    types: value.types.map(normalizeJavaTypeMembers),
  }
}

function normalizeJavaTypeMembers(value: unknown): JavaTypeMembers {
  if (!isRecord(value)) {
    throw new Error('The Java type member metadata contained an invalid type.')
  }
  const typeName = nonEmptyString(value.typeName !== undefined ? value.typeName : value.type_name)
  if (!typeName || typeof value.available !== 'boolean'
    || !Array.isArray(value.methods) || !Array.isArray(value.fields)) {
    throw new Error('The Java type member metadata contained an invalid type.')
  }

  return {
    typeName,
    available: value.available,
    methods: value.methods.map(normalizeJavaMethodMember),
    fields: value.fields.map(normalizeJavaFieldMember),
  }
}

function normalizeJavaMethodMember(value: unknown): JavaMethodMember {
  if (!isRecord(value)) {
    throw new Error('The Java type member metadata contained an invalid method.')
  }
  const name = nonEmptyString(value.name)
  const returnType = nonEmptyString(
    value.returnType !== undefined ? value.returnType : value.return_type,
  )
  const isStatic = value.isStatic !== undefined ? value.isStatic : value.is_static
  if (!name || !returnType || !Array.isArray(value.parameters) || typeof isStatic !== 'boolean') {
    throw new Error('The Java type member metadata contained an invalid method.')
  }

  return {
    name,
    returnType,
    parameters: value.parameters.map(normalizeJavaMemberParameter),
    isStatic,
  }
}

function normalizeJavaMemberParameter(value: unknown): JavaMemberParameter {
  if (!isRecord(value)) {
    throw new Error('The Java type member metadata contained an invalid parameter.')
  }
  const typeName = nonEmptyString(value.typeName !== undefined ? value.typeName : value.type_name)
  const name = value.name
  if (!typeName || (name !== null && (typeof name !== 'string' || name.length === 0))) {
    throw new Error('The Java type member metadata contained an invalid parameter.')
  }
  return { name, typeName }
}

function normalizeJavaFieldMember(value: unknown): JavaFieldMember {
  if (!isRecord(value)) {
    throw new Error('The Java type member metadata contained an invalid field.')
  }
  const name = nonEmptyString(value.name)
  const typeName = nonEmptyString(value.typeName !== undefined ? value.typeName : value.type_name)
  const isStatic = value.isStatic !== undefined ? value.isStatic : value.is_static
  if (!name || !typeName || typeof isStatic !== 'boolean') {
    throw new Error('The Java type member metadata contained an invalid field.')
  }
  return { name, typeName, isStatic }
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

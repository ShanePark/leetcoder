import { describe, expect, it } from 'vitest'

import { findProjectSearchLocation } from '../../../src/app/project-search-location'

describe('findProjectSearchLocation', () => {
  it('finds the literal again after source lines have moved', () => {
    expect(findProjectSearchLocation('prefix\n  Return True;\na.b[]', 'return true'))
      .toEqual({ line: 2, column: 3 })
    expect(findProjectSearchLocation('prefix\n  Return True;\na.b[]', 'a.b[]'))
      .toEqual({ line: 3, column: 1 })
  })

  it('returns UTF-16 columns and no result when the current source no longer matches', () => {
    expect(findProjectSearchLocation('😀 value', 'VALUE'))
      .toEqual({ line: 1, column: 4 })
    expect(findProjectSearchLocation('😀İ target', 'TARGET'))
      .toEqual({ line: 1, column: 5 })
    expect(findProjectSearchLocation('changed source', 'missing')).toBeNull()
    expect(findProjectSearchLocation('source', '')).toBeNull()
  })
})

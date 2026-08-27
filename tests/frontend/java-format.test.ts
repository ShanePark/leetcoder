import { describe, expect, it } from 'vitest'

import {
  formatJavaSource,
  importBlockRange,
  normalizeJavaWhitespace,
  organizeJavaImports,
  removeUnusedJavaTypeImports,
} from '../../src/java-format'

const HEADER = 'package shane.leetcode.problems.easy;\n\n'

describe('import block range', () => {
  it('spans the leading run of imports without their last line break', () => {
    const source = `${HEADER}import java.util.ArrayList;\nimport java.util.List;\n\nclass Q1 {\n}\n`
    const block = importBlockRange(source)
    expect(block).not.toBeNull()
    expect(block!.count).toBe(2)
    expect(source.slice(block!.from, block!.to)).toBe(
      'import java.util.ArrayList;\nimport java.util.List;',
    )
  })

  it('treats blank lines between imports as part of the same block', () => {
    const source = `${HEADER}import java.util.List;\n\nimport static org.assertj.core.api.Assertions.assertThat;\n\nclass Q1 {}\n`
    expect(importBlockRange(source)?.count).toBe(2)
  })

  it('stops at the first line of code and returns null without imports', () => {
    const split = `${HEADER}import java.util.List;\n\nclass Q1 {}\nimport java.util.Set;\n`
    expect(importBlockRange(split)?.count).toBe(1)
    expect(importBlockRange(`${HEADER}class Q1 {}\n`)).toBeNull()
  })
})

describe('unused import removal', () => {
  it('drops a catalog import once its last reference is gone', () => {
    const source = `${HEADER}import java.util.ArrayList;\nimport java.util.List;\n\nclass Q1 {\n    List<Integer> values = new ArrayList<>();\n}\n`
    const withoutList = source.replace('    List<Integer> values = new ArrayList<>();\n', '')
    expect(removeUnusedJavaTypeImports(source)).toBe(source)
    expect(removeUnusedJavaTypeImports(withoutList)).toBe(
      `${HEADER}class Q1 {\n}\n`,
    )
  })

  it('keeps a longer type that merely contains the name', () => {
    const source = `${HEADER}import java.util.List;\n\nclass Q1 {\n    LinkedList<Integer> values;\n}\n`
    expect(removeUnusedJavaTypeImports(source)).toBe(`${HEADER}class Q1 {\n    LinkedList<Integer> values;\n}\n`)
  })

  it('does not count references inside comments or string literals', () => {
    const source = `${HEADER}import java.util.List;\n\nclass Q1 {\n    // returns a List\n    String label = "List";\n}\n`
    expect(removeUnusedJavaTypeImports(source)).not.toContain('import java.util.List;')
  })

  it('leaves static, wildcard, and hand-written imports alone', () => {
    const source = `${HEADER}import java.util.concurrent.Callable;\nimport java.util.*;\n\nimport static org.assertj.core.api.Assertions.assertThat;\n\nclass Q1 {}\n`
    expect(removeUnusedJavaTypeImports(source)).toBe(source)
  })

  it('keeps a type whose name starts with the identifier being typed', () => {
    const source = `${HEADER}import java.util.List;\n\nclass Q1 {\n    Lis\n}\n`
    expect(removeUnusedJavaTypeImports(source, 'Lis')).toBe(source)
    expect(removeUnusedJavaTypeImports(source, 'Set')).not.toContain('import java.util.List;')
  })

  it('collapses the blank lines left behind when the whole block goes', () => {
    const source = `${HEADER}import java.util.List;\n\nclass Q1 {}\n`
    expect(removeUnusedJavaTypeImports(source)).toBe(`${HEADER}class Q1 {}\n`)
  })
})

describe('import organization', () => {
  it('sorts and de-duplicates ordinary imports and moves static imports last', () => {
    const source = `${HEADER}import static org.assertj.core.api.Assertions.assertThat;\nimport java.util.List;\nimport java.util.ArrayList;\nimport java.util.List;\n\nclass Q1 {}\n`
    expect(organizeJavaImports(source)).toBe(
      `${HEADER}import java.util.ArrayList;\nimport java.util.List;\n\nimport static org.assertj.core.api.Assertions.assertThat;\n\nclass Q1 {}\n`,
    )
  })

  it('leaves a source without imports untouched', () => {
    const source = `${HEADER}class Q1 {}\n`
    expect(organizeJavaImports(source)).toBe(source)
  })
})

describe('whitespace normalization', () => {
  it('trims trailing spaces, caps blank runs, and ends with one line break', () => {
    expect(normalizeJavaWhitespace('class Q1 {   \n\n\n\n    int a;\n}\n\n\n')).toBe(
      'class Q1 {\n\n    int a;\n}\n',
    )
  })

  it('keeps CRLF documents on CRLF', () => {
    expect(normalizeJavaWhitespace('class Q1 {\r\n}\r\n')).toBe('class Q1 {\r\n}\r\n')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeJavaWhitespace('\n\n  \n')).toBe('')
  })
})

describe('formatJavaSource', () => {
  it('prunes, sorts, and tidies in one pass', () => {
    const source = `${HEADER}import java.util.List;\nimport java.util.ArrayList;\nimport java.util.Set;\n\n\n\nclass Q1 {\n    List<Integer> values = new ArrayList<>();   \n}\n`
    expect(formatJavaSource(source)).toBe(
      `${HEADER}import java.util.ArrayList;\nimport java.util.List;\n\nclass Q1 {\n    List<Integer> values = new ArrayList<>();\n}\n`,
    )
  })
})

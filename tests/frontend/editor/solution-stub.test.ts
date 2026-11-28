import { describe, expect, it } from 'vitest'
import { renderJavaProblemSource } from '../../../src/domain/template'
import { isJavaSolutionUnimplemented } from '../../../src/editor/solution-stub'

const SCAFFOLD = renderJavaProblemSource('example', 'Q1Example', 'public int minMoves(int[] nums) {')

const withSolution = (body: string): string => SCAFFOLD.replace(
  'public int minMoves(int[] nums) {\n\n    }',
  `public int minMoves(int[] nums) {\n${body}\n    }`,
)

describe('unimplemented solution check', () => {
  it('treats the scaffold, and one without a signature, as unimplemented', () => {
    expect(isJavaSolutionUnimplemented(SCAFFOLD)).toBe(true)
    expect(isJavaSolutionUnimplemented(renderJavaProblemSource('example', 'Q2Design', null))).toBe(true)
  })

  it('ignores whitespace and comments in a solution body', () => {
    expect(isJavaSolutionUnimplemented(withSolution('        // try two pointers\n        /* later */\n'))).toBe(true)
  })

  it('ignores filled @Test methods', () => {
    const tested = SCAFFOLD.replace('assertThat()', 'assertThat(minMoves(new int[]{1})).isEqualTo(0);')
    expect(isJavaSolutionUnimplemented(tested)).toBe(true)
  })

  it('counts one statement in a method as implemented', () => {
    expect(isJavaSolutionUnimplemented(withSolution('        return 0;'))).toBe(false)
  })

  it('counts a statement in a constructor or a nested class method as implemented', () => {
    const design = (members: string): string => [
      'class Q3Design {',
      '    @Test',
      '    public void test() {',
      '    }',
      members,
      '}',
    ].join('\n')

    expect(isJavaSolutionUnimplemented(design('    Q3Design() {\n        // state\n    }'))).toBe(true)
    expect(isJavaSolutionUnimplemented(design('    Q3Design() {\n        size = 0;\n    }'))).toBe(false)
    expect(isJavaSolutionUnimplemented(design('    class Cache {\n        int get(int key) {\n        }\n    }'))).toBe(true)
    expect(isJavaSolutionUnimplemented(design('    class Cache {\n        int get(int key) {\n            return key;\n        }\n    }'))).toBe(false)
  })

  it('counts an unfinished statement as implemented', () => {
    expect(isJavaSolutionUnimplemented(withSolution('        int count ='))).toBe(false)
  })
})

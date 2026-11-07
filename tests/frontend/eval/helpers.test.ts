import { describe, expect, it } from 'vitest'
import {
  classifyRunnerResult,
  countExamples,
  countScenarios,
  fullyQualifiedClassName,
  resetTestBody,
} from '../../../eval/helpers'
import { findBareJavaTest } from '../../../src/editor/test-markers'

const SOLVED = `package example.easy;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class Q1Example {

    @Test
    public void test() {
        assertThat(add(1, 2)).isEqualTo(3);
    }

    @Test
    public void test2() {
        assertThat(add(2, 2)).isEqualTo(4);
    }

    public int add(int a, int b) {
        return a + b;
    }
}
`

describe('resetTestBody', () => {
  it('leaves test() as the bare stub and keeps the other tests', () => {
    const reset = resetTestBody(SOLVED)
    expect(findBareJavaTest(reset).status).toBe('bare')
    expect(reset).toContain('assertThat(add(2, 2)).isEqualTo(4);')
    expect(reset).not.toContain('assertThat(add(1, 2))')
  })

  it('accepts a package-private test and adds the import the template has', () => {
    const reset = resetTestBody(`package example;

import org.assertj.core.api.Assertions;
import org.junit.jupiter.api.Test;

public class Q2 {
    @Test
    void test() {
        Assertions.assertThat(1).isEqualTo(1);
    }
}
`)
    expect(findBareJavaTest(reset).status).toBe('bare')
    expect(reset).toContain(
      'import org.junit.jupiter.api.Test;\nimport static org.assertj.core.api.Assertions.assertThat;\n',
    )
  })

  it('does not repeat an import that is already there', () => {
    expect(resetTestBody(SOLVED).match(/import static/g)).toHaveLength(1)
  })

  it('refuses a file without a test method', () => {
    expect(() => resetTestBody('package example;\n\npublic class Q3 {\n}\n')).toThrow('no @Test method')
  })
})

describe('fullyQualifiedClassName', () => {
  it('joins the package line and the file name', () => {
    expect(fullyQualifiedClassName(SOLVED, 'src/main/java/example/easy/Q1Example.java')).toBe('example.easy.Q1Example')
  })
})

describe('countExamples', () => {
  it('counts each numbered heading once', () => {
    const content = '<strong class="example">Example 1:</strong> x <strong>Example 2:</strong> see Example 1: again'
    expect(countExamples(content)).toBe(2)
  })

  it('counts a lone unnumbered heading and ignores prose', () => {
    expect(countExamples('<strong>Example:</strong> for example: this')).toBe(1)
    expect(countExamples('no headings here')).toBe(0)
  })
})

describe('countScenarios', () => {
  it('counts calls to the entry method', () => {
    const statements = [
      'assertThat(add(1, 2)).isEqualTo(3);',
      'assertThat(add (2, 2)).isEqualTo(4);',
      'int[] padded = new int[]{1};',
      'assertThat(readd(1, 1)).isEqualTo(2);',
    ]
    expect(countScenarios(statements, 'public int add(int a, int b) {', 'class Solution {}')).toBe(2)
  })

  it('counts instances of a design class, ignoring classes in comments', () => {
    const snippet = '// class Helper {}\n/* class Other {} */\nclass Cache {\n    public Cache(int size) {}\n}'
    const statements = ['Cache first = new Cache(1);', 'first.put(1);', 'Cache second = new Cache(2);']
    expect(countScenarios(statements, null, snippet)).toBe(2)
  })

  it('counts nothing when there is nothing to look for', () => {
    expect(countScenarios(['assertThat(1).isEqualTo(1);'], null, null)).toBe(0)
  })
})

describe('classifyRunnerResult', () => {
  it('passes a test that ran', () => {
    expect(classifyRunnerResult({ status: 'pass', detail: '' })).toEqual({ kind: 'pass' })
  })

  it('reports compile errors with their location and source line', () => {
    const detail = [
      '/tmp/batch/0/src/example/Q1.java:9: error: cannot find symbol',
      '        assertThat(nope());',
      '                   ^',
      '  symbol:   method nope()',
      '1 error',
    ].join('\n')
    expect(classifyRunnerResult({ status: 'compile', detail })).toEqual({
      kind: 'compile',
      details: ['Q1.java:9: error: cannot find symbol', '        assertThat(nope());', '                   ^'],
    })
  })

  it('keeps compiler output that names no error', () => {
    expect(classifyRunnerResult({ status: 'compile', detail: 'error: invalid flag\n' })).toEqual({
      kind: 'compile',
      details: ['error: invalid flag'],
    })
  })

  it('reports a failed test as one line', () => {
    const detail = 'org.opentest4j.AssertionFailedError: \nexpected: 3\n but was: 4 org.opentest4j.AssertionFailedError'
    expect(classifyRunnerResult({ status: 'failure', detail })).toEqual({
      kind: 'assertion',
      details: ['org.opentest4j.AssertionFailedError: expected: 3 but was: 4 org.opentest4j.AssertionFailedError'],
    })
  })

  it('keeps timeouts and tool errors apart', () => {
    expect(classifyRunnerResult({ status: 'timeout', detail: 'Too slow.' })).toEqual({
      kind: 'timeout',
      details: ['Too slow.'],
    })
    expect(classifyRunnerResult({ status: 'tool', detail: 'No test.' })).toEqual({
      kind: 'tool',
      details: ['No test.'],
    })
  })
})

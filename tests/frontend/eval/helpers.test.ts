import { describe, expect, it } from 'vitest'
import {
  classifyGradleRun,
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

describe('classifyGradleRun', () => {
  const run = { exitCode: 1, timedOut: false, output: '', junitXml: null }

  it('passes only when a test really ran', () => {
    expect(classifyGradleRun({ ...run, exitCode: 0, junitXml: '<testsuite name="a" tests="1" failures="0">' }))
      .toEqual({ kind: 'pass' })
    expect(classifyGradleRun({ ...run, exitCode: 0, junitXml: '<testsuite name="a" tests="0">' }).kind).toBe('tool')
    expect(classifyGradleRun({ ...run, exitCode: 0 }).kind).toBe('tool')
  })

  it('reports compile errors with their location and source line', () => {
    const output = [
      '/tmp/project/src/test/java/example/Q1.java:9: error: cannot find symbol',
      '        assertThat(nope());',
      '                   ^',
      '  symbol:   method nope()',
      "Execution failed for task ':compileTestJava'.",
    ].join('\n')
    expect(classifyGradleRun({ ...run, output })).toEqual({
      kind: 'compile',
      details: ['Q1.java:9: error: cannot find symbol', '        assertThat(nope());', '                   ^'],
    })
  })

  it('reports a failed assertion with the decoded JUnit message', () => {
    const junitXml = '<testsuite tests="1"><failure message="expected: &lt;3&gt;&#10;but was: 4 &amp; more" '
      + 'type="org.opentest4j.AssertionFailedError">trace</failure></testsuite>'
    expect(classifyGradleRun({ ...run, junitXml })).toEqual({
      kind: 'assertion',
      details: ['expected: <3> but was: 4 & more org.opentest4j.AssertionFailedError'],
    })
  })

  it('reports an exception that has no message', () => {
    const junitXml = '<testsuite tests="1"><failure type="java.lang.NullPointerException">trace</failure></testsuite>'
    expect(classifyGradleRun({ ...run, junitXml })).toEqual({
      kind: 'assertion',
      details: ['java.lang.NullPointerException'],
    })
  })

  it('blames the tool for anything else, such as an offline resolve failure', () => {
    const output = 'FAILURE: Build failed.\n* What went wrong:\nPlugin was not found.\n\n* Try:'
    expect(classifyGradleRun({ ...run, output })).toEqual({
      kind: 'tool',
      details: ['Plugin was not found.', '* Try:'],
    })
    expect(classifyGradleRun({ ...run, timedOut: true, exitCode: null }).kind).toBe('timeout')
  })
})

import { bench, describe } from 'vitest'

import {
  analyzeJavaSource,
  maskJavaCommentsAndLiterals,
  resolveJavaDefinition,
} from '../../../src/completions/source'
import { formatJavaSource, normalizeJavaWhitespace } from '../../../src/java-format'
import { planJavaStatementCompletion } from '../../../src/editor/statement-completion'

function performanceSource(methodCount = 260): string {
  const methods = Array.from({ length: methodCount }, (_, index) => `
    int helper${index}(List<Integer> values) {
        // helper${index}("ignored")
        String label = "values = ignored ${index}";
        return values.size() + ${index};
    }
`).join('')
  return `package shane.leetcode.problems.medium;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.HashMap;

class Solution {
    List<Integer> values = new ArrayList<>();
${methods}
    int target(List<Integer> input) {
        return helper${Math.floor(methodCount / 2)}(input);
    }
}
`
}

const statementSource = `${' '.repeat(4)}values.addAll(otherValues` + ' '.repeat(1400)
  + ');'
const statementPosition = statementSource.length - 1

const fixtures = [
  { name: '2,184-byte', methodCount: 12, source: performanceSource(12) },
  { name: '58,906-byte', methodCount: 360, source: performanceSource(360) },
]

describe('editor performance probes', () => {
  for (const fixture of fixtures) {
    const callName = `helper${Math.floor(fixture.methodCount / 2)}(input)`
    const callPosition = fixture.source.indexOf(callName) + 3

    bench(`mask comments and literals (${fixture.name})`, () => {
      maskJavaCommentsAndLiterals(fixture.source)
    }, { iterations: fixture.methodCount === 12 ? 50 : 10 })

    bench(`analyze completion source (${fixture.name})`, () => {
      analyzeJavaSource(fixture.source, fixture.source.length)
    }, { iterations: fixture.methodCount === 12 ? 20 : 5 })

    bench(`resolve same-file method definition (${fixture.name})`, () => {
      resolveJavaDefinition(fixture.source, callPosition)
    }, { iterations: fixture.methodCount === 12 ? 20 : 5 })

    bench(`format Java source (${fixture.name})`, () => {
      formatJavaSource(fixture.source)
    }, { iterations: fixture.methodCount === 12 ? 10 : 2 })

    bench(`normalize Java whitespace (${fixture.name})`, () => {
      normalizeJavaWhitespace(fixture.source)
    }, { iterations: fixture.methodCount === 12 ? 10 : 2 })
  }

  bench('plan statement completion', () => {
    planJavaStatementCompletion(statementSource, statementPosition)
  }, { iterations: 30 })
})

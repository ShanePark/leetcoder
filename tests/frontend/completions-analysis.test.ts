import { describe, expect, it } from 'vitest'

import {
  analyzeJavaSource,
  javaIterableCandidatesFromAnalysis,
} from '../../src/completions/source'

describe('shared Java source analysis', () => {
  it('keeps comments and literals out of the source facts used by completion', () => {
    const source = `class Solution {
      List<Integer> values = new ArrayList<>();
      void solve(List<String> input) {
        // helper(ignored)
        input.add("values = fake");
        values.add(input.size());
      }
      int helper(int value) { return value; }
    }`
    const position = source.indexOf('values.add')
    const analysis = analyzeJavaSource(source, position)

    expect(analysis.symbols
      .filter((symbol) => symbol.scopeStart <= position && position <= symbol.scopeEnd)
      .map(({ name, declaredType, kind }) => ({ name, declaredType, kind })))
      .toEqual([
        { name: 'values', declaredType: 'List<Integer>', kind: 'field' },
        { name: 'input', declaredType: 'List<String>', kind: 'parameter' },
      ])
    expect(analysis.methods.map(({ name, parameters }) => ({ name, parameters }))).toEqual([
      { name: 'solve', parameters: ['input'] },
      { name: 'helper', parameters: ['value'] },
    ])
  })

  it('produces visible iterable candidates from the shared analysis', () => {
    const source = `class Solution {
      void solve() {
        List<Integer> values = new ArrayList<>();
        int[] nums = new int[3];
        values.add(1);
        ite|
      }
    }`.replace('|', '')
    const position = source.indexOf('ite') + 3
    const analysis = analyzeJavaSource(source, position)

    expect(javaIterableCandidatesFromAnalysis(source, position, analysis)).toEqual([
      { name: 'nums', elementType: 'int', variableName: 'num' },
      { name: 'values', elementType: 'Integer', variableName: 'value' },
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { collectJavaMethods, resolveJavaDefinition } from '../../../src/completions'
import { labels } from './helpers'

describe('lightweight Java completions', () => {
it('shows fields declared later and methods from this.', () => {
    const source = `class Solution {
      void test() { this.| }
      List<Integer> later;
      int helper(int value) { return value; }
    }`
    const options = labels(source)
    expect(options).toContain('later')
    expect(options).toContain('helper(value)')
  })

it('returns Java keywords, variables, and methods for explicit Ctrl+Space', () => {
    const source = 'class Solution { int answer; int helper(int value) { return value; } void test() { } }'
    const options = labels(source, true)
    expect(options).toContain('answer')
    expect(options).toContain('helper(value)')
    expect(options).toContain('return')
    expect(options).toContain('ArrayList')
  })

it('extracts method names without treating control-flow blocks as methods', () => {
    const methods = collectJavaMethods('class Solution { int helper(int value) { if (value > 0) { return value; } return 0; } }')
    expect(methods.map((method) => method.name)).toEqual(['helper'])
  })

it('resolves a call site to the exact method declaration name', () => {
    const source = `class Solution {
      int helper(int value) { return value; }
      int solve() { return helper(3); }
    }`
    const call = source.lastIndexOf('helper(3)')
    const definition = resolveJavaDefinition(source, call + 2)
    expect(definition?.name).toBe('helper')
    expect(definition?.from).toBe(source.indexOf('helper'))
    expect(source.slice(definition?.from ?? 0, definition?.to ?? 0)).toBe('helper')
  })

it('keeps declaration navigation stable and ignores unknown, field, and constructor tokens', () => {
    const source = `class Solution {
      int field;
      Solution() { }
      int helper() { return field; }
      int solve() { return unknown + field; }
    }`
    const declaration = source.indexOf('helper()')
    expect(resolveJavaDefinition(source, declaration + 1)?.from).toBe(declaration)
    expect(resolveJavaDefinition(source, source.indexOf('unknown') + 1)).toBeNull()
    expect(resolveJavaDefinition(source, source.indexOf('field;') + 1)).toBeNull()
    expect(resolveJavaDefinition(source, source.indexOf('Solution()') + 1)).toBeNull()
  })

it('selects an overload by argument count and falls back to source order', () => {
    const source = `class Solution {
      int helper(int value) { return value; }
      int helper(int left, int right) { return left + right; }
      int solve() { return helper(1, 2); }
    }`
    const call = source.lastIndexOf('helper(1, 2)')
    const definition = resolveJavaDefinition(source, call + 1)
    expect(definition?.from).toBe(source.indexOf('helper', source.indexOf('helper') + 1))
    expect(definition?.parameters).toEqual(['left', 'right'])

    const incomplete = `${source.slice(0, call)}helper(value)${source.slice(call + 'helper(1, 2)'.length)}`
    const fallback = resolveJavaDefinition(incomplete, incomplete.lastIndexOf('helper(value)') + 2)
    expect(fallback?.parameters).toEqual(['value'])
  })

it('resolves nested calls independently and supports this-qualified calls', () => {
    const source = `class Solution {
      int inner() { return 1; }
      int outer(int value) { return value; }
      int solve() { return outer(inner()); }
      int again() { return this.inner(); }
    }`
    const nested = source.indexOf('inner())')
    expect(resolveJavaDefinition(source, nested + 2)?.from).toBe(source.indexOf('inner()'))
    const qualified = source.lastIndexOf('inner()')
    expect(resolveJavaDefinition(source, qualified + 2)?.from).toBe(source.indexOf('inner()'))
  })

it('does not treat method-shaped text in comments or literals as code', () => {
    const source = `class Solution {
      int helper() { return 1; }
      int solve() {
        String text = "helper() { not a declaration }";
        // helper()
        return helper();
      }
    }`
    const literal = source.indexOf('helper() {', source.indexOf('String text'))
    expect(resolveJavaDefinition(source, literal + 2)).toBeNull()
    const comment = source.indexOf('// helper()') + 3
    expect(resolveJavaDefinition(source, comment + 2)).toBeNull()
    const call = source.lastIndexOf('helper()')
    expect(resolveJavaDefinition(source, call + 2)?.from).toBe(source.indexOf('helper()'))
  })

it('preserves UTF-16 offsets when source contains astral characters', () => {
    const source = `class Solution {
      String emoji = "😀";
      int helper() { return 1; }
      int solve() { return helper(); }
    }`
    const call = source.lastIndexOf('helper()')
    const definition = resolveJavaDefinition(source, call + 2)
    expect(definition?.from).toBe(source.indexOf('helper()'))
    expect(source.slice(definition?.from ?? 0, definition?.to ?? 0)).toBe('helper')
  })

it('counts generic commas and masked string, char, and text-block literals as one argument', () => {
    const genericSource = `class Solution {
      int helper(int value) { return value; }
      int helper(int left, int right) { return left + right; }
      int solve() { return helper(new java.util.HashMap<String, Integer>()); }
    }`
    const genericCall = genericSource.lastIndexOf('helper(new')
    expect(resolveJavaDefinition(genericSource, genericCall + 2)?.parameters).toEqual(['value'])

    const literalSource = `class Solution {
      int literal(String value) { return 1; }
      int literal(String left, String right) { return 2; }
      int solve() {
        literal("a,b");
        literal(',');
        literal("""a,b""");
        return 0;
      }
    }`
    const stringCall = literalSource.indexOf('literal("a,b")')
    const charCall = literalSource.indexOf("literal(',')")
    const textCall = literalSource.indexOf('literal("""a,b""")')
    expect(resolveJavaDefinition(literalSource, stringCall + 2)?.parameters).toEqual(['value'])
    expect(resolveJavaDefinition(literalSource, charCall + 2)?.parameters).toEqual(['value'])
    expect(resolveJavaDefinition(literalSource, textCall + 2)?.parameters).toEqual(['value'])
  })

it('does not count commas inside comparison expressions as generic type separators', () => {
    const source = `class Solution {
      int compare(int value) { return value; }
      int compare(int left, int right) { return left + right; }
      int solve(int a, int b, int c, int d) {
        return compare(a < b, c > d);
      }
    }`
    const call = source.lastIndexOf('compare(a < b')
    expect(resolveJavaDefinition(source, call + 2)?.parameters).toEqual(['left', 'right'])
  })

it('collects fully-qualified return types and annotations', () => {
    const source = `class Solution {
      @org.junit.jupiter.api.Test
      public java.util.List<String> helper() { return null; }
      int solve() { helper(); return 0; }
    }`
    const methods = collectJavaMethods(source)
    expect(methods.map((method) => method.name)).toEqual(['helper', 'solve'])
    const call = source.lastIndexOf('helper()')
    expect(resolveJavaDefinition(source, call + 2)?.from).toBe(source.indexOf('helper()'))
  })

it('rejects non-this qualifiers while allowing this-qualified calls', () => {
    const source = `class Solution {
      int helper() { return 1; }
      Factory factory() { return null; }
      int solve() {
        factory().helper();
        obj.helper();
        return this.helper();
      }
    }`
    const factoryCall = source.indexOf('factory().helper') + 'factory().'.length
    const objectCall = source.indexOf('obj.helper') + 'obj.'.length
    const thisCall = source.indexOf('this.helper') + 'this.'.length
    expect(resolveJavaDefinition(source, factoryCall + 2)).toBeNull()
    expect(resolveJavaDefinition(source, objectCall + 2)).toBeNull()
    expect(resolveJavaDefinition(source, thisCall + 2)?.from).toBe(source.indexOf('helper()'))
  })
})

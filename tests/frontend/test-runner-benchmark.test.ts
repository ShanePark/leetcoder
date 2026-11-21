import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// @ts-expect-error The executable benchmark is plain JavaScript.
import { buildSummary, compare, extractRustString, parseArguments, summarize } from '../../scripts/performance/test-runner.mjs'

describe('test runner performance report', () => {
  it('extracts the actual production scripts and fails when their format changes', async () => {
    const runner = await readFile('src-tauri/src/runner/gradle.rs', 'utf8')
    const helpers = await readFile('src-tauri/src/java_library/helpers.rs', 'utf8')
    expect(extractRustString(runner, "pub(crate) fn build_gradle_init_script() -> &'static str {"))
      .toContain("tasks.register('leetcoderProblemTest'")
    expect(extractRustString(helpers, 'pub(super) const GRADLE_INIT_SCRIPT: &str'))
      .toContain('leetcoderPrintMainCompileClasspath')
    expect(() => extractRustString('renamed declaration', 'missing')).toThrow()
    expect(() => extractRustString('script = "ordinary string"', 'script')).toThrow()
  })

  it('reports medians, range and regressions without a machine dependent pass threshold', () => {
    expect(summarize([30, 10, 20])).toEqual({ samples: 3, medianMs: 20, minMs: 10, maxMs: 30 })
    expect(summarize([30, 10, 20, 40]).medianMs).toBe(25)
    expect(compare(100, 25)).toEqual({ speedup: 4, reductionPercent: 75 })
    expect(compare(25, 100)).toEqual({ speedup: 0.25, reductionPercent: -300 })
    expect(() => summarize([])).toThrow()
    expect(() => summarize([NaN])).toThrow()
    expect(() => compare(0, 1)).toThrow()
  })

  it('keeps background warmup cost visible and excludes first runs from repeat statistics', () => {
    const records = ['baseline', 'reuse', 'prewarmed'].flatMap((mode, modeIndex) => {
      const duration = (3 - modeIndex) * 100
      return ['warmup', 'first', 'repeat-1', 'repeat-2', 'repeat-3', 'edited'].map((label) => ({
        mode, label, totalMs: label === 'first' ? 10_000 : duration,
        firstTestMs: duration - 20, afterTestsMs: 10, testBodyMs: 10,
        stageDurations: { launchAndSettingsMs: duration - 40, afterTestsMs: 10 },
      }))
    })
    const summary = buildSummary(records)
    expect(summary.baseline.repetitions.samples).toBe(3)
    expect(summary.baseline.repetitions.medianMs).toBe(300)
    expect(summary.prewarmed.warmupMs).toBe(100)
    expect(summary.reuseVsBaseline.speedup).toBe(1.5)
    expect(summary.baseline.firstMs).toBe(10_000)
    expect(summary.reuse.stages.launchAndSettingsMs.medianMs).toBe(160)
  })

  it('accepts explicit offline installations and rejects invalid repeat counts', () => {
    expect(parseArguments(['--runs', '3', '--gradle', '/tmp/gradle', '--java-home', '/tmp/jdk']).runs).toBe(3)
    for (const args of [['--runs', '0'], ['--runs', '2'], ['--runs', '3.5'], ['--runs', '31'], ['--runs'], ['--unknown', 'x']]) {
      expect(() => parseArguments(args)).toThrow()
    }
  })
})

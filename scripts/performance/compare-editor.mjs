#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baselineRef = '87dab17'
const logPath = process.env.EDITOR_COMPARISON_LOG ?? '/tmp/leetcoder-editor-comparison.log'
const sourceFiles = ['src/completions/source.ts', 'src/java-format.ts']

function git(...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourceRecord(root, relativePath) {
  const path = join(root, relativePath)
  return {
    relativePath,
    path,
    sha256: sha256(path),
    gitBlob: git('hash-object', path),
  }
}

function quote(value) {
  return JSON.stringify(value)
}

function benchmarkTestSource(baselineRoot, currentRoot) {
  const baselineSource = join(baselineRoot, 'src/completions/source.ts')
  const currentSource = join(currentRoot, 'src/completions/source.ts')
  const baselineFormat = join(baselineRoot, 'src/java-format.ts')
  const currentFormat = join(currentRoot, 'src/java-format.ts')

  return `import { describe, expect, it } from 'vitest'
import * as baselineCompletion from ${quote(baselineSource)}
import * as currentCompletion from ${quote(currentSource)}
import * as baselineJavaFormat from ${quote(baselineFormat)}
import * as currentJavaFormat from ${quote(currentFormat)}

const WARMUP_SAMPLES = 4
const MEASUREMENT_SAMPLES = 20
let sink = 0

function performanceSource(methodCount) {
  const methods = Array.from({ length: methodCount }, (_, index) => \`
    int helper\${index}(List<Integer> values) {
        // helper\${index}("ignored")
        String label = "values = ignored \${index}";
        return values.size() + \${index};
    }
\`).join('')
  return \`package shane.leetcode.problems.medium;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.HashMap;

class Solution {
    List<Integer> values = new ArrayList<>();
\${methods}
    int target(List<Integer> input) {
        return helper\${Math.floor(methodCount / 2)}(input);
    }
}
\`
}

const fixtures = [
  { name: '2,184-byte', methodCount: 12, source: performanceSource(12) },
  { name: '58,906-byte', methodCount: 360, source: performanceSource(360) },
]

function consume(value) {
  if (typeof value === 'string') {
    return value.length + (value.charCodeAt(0) || 0)
  }
  if (value === null) return 0
  if ('maskedSource' in value) {
    return value.maskedSource.length + value.symbols.length * 13 + value.methods.length * 17
  }
  if ('parameters' in value) {
    return value.name.length + value.parameters.length * 11 + value.declaredAt
  }
  return 0
}

function measure(fn, repetitions) {
  let localSink = 0
  const started = process.hrtime.bigint()
  for (let index = 0; index < repetitions; index += 1) {
    localSink += consume(fn())
  }
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6
  sink += localSink
  return elapsedMilliseconds / repetitions
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function summarize(samples) {
  return {
    median: median(samples),
    p95: percentile(samples, 0.95),
  }
}

function formatMilliseconds(value) {
  return value.toFixed(4)
}

function runOperation(name, baselineFn, currentFn, repetitions) {
  for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
    if (index % 2 === 0) {
      measure(baselineFn, repetitions)
      measure(currentFn, repetitions)
    } else {
      measure(currentFn, repetitions)
      measure(baselineFn, repetitions)
    }
  }

  const baselineSamples = []
  const currentSamples = []
  for (let index = 0; index < MEASUREMENT_SAMPLES; index += 1) {
    if (index % 2 === 0) {
      baselineSamples.push(measure(baselineFn, repetitions))
      currentSamples.push(measure(currentFn, repetitions))
    } else {
      currentSamples.push(measure(currentFn, repetitions))
      baselineSamples.push(measure(baselineFn, repetitions))
    }
  }

  const baseline = summarize(baselineSamples)
  const current = summarize(currentSamples)
  const speedup = baseline.median / current.median
  console.log(
    \`\${name}: baseline median=\${formatMilliseconds(baseline.median)}ms p95=\${formatMilliseconds(baseline.p95)}ms; \`
      + \`current median=\${formatMilliseconds(current.median)}ms p95=\${formatMilliseconds(current.p95)}ms; \`
      + \`median speedup=\${speedup.toFixed(2)}x; samples=\${MEASUREMENT_SAMPLES}; batch=\${repetitions}\`,
  )
}

describe('editor baseline comparison', () => {
  it('compares baseline and current implementations on identical fixtures', () => {
    console.log('fixtures: UTF-16 code units and UTF-8 bytes')
    for (const fixture of fixtures) {
      const callName = \`helper\${Math.floor(fixture.methodCount / 2)}(input)\`
      const callPosition = fixture.source.indexOf(callName) + 3
      const baselineMask = baselineCompletion.maskJavaCommentsAndLiterals(fixture.source)
      const currentMask = currentCompletion.maskJavaCommentsAndLiterals(fixture.source)
      const baselineFormatted = baselineJavaFormat.formatJavaSource(fixture.source)
      const currentFormatted = currentJavaFormat.formatJavaSource(fixture.source)

      expect(currentMask).toBe(baselineMask)
      expect(currentFormatted).toBe(baselineFormatted)
      console.log(
        \`\${fixture.name}: utf16=\${fixture.source.length} utf8=\${Buffer.byteLength(fixture.source, 'utf8')} \`
          + \`mask output equal (length=\${currentMask.length}), format output equal (length=\${currentFormatted.length})\`,
      )

      const analyzeBaseline = () => baselineCompletion.analyzeJavaSource(fixture.source, fixture.source.length)
      const analyzeCurrent = () => currentCompletion.analyzeJavaSource(fixture.source, fixture.source.length)
      const resolveBaseline = () => baselineCompletion.resolveJavaDefinition(fixture.source, callPosition)
      const resolveCurrent = () => currentCompletion.resolveJavaDefinition(fixture.source, callPosition)
      const formatBaseline = () => baselineJavaFormat.formatJavaSource(fixture.source)
      const formatCurrent = () => currentJavaFormat.formatJavaSource(fixture.source)
      const maskBaseline = () => baselineCompletion.maskJavaCommentsAndLiterals(fixture.source)
      const maskCurrent = () => currentCompletion.maskJavaCommentsAndLiterals(fixture.source)

      const repetitions = fixture.methodCount === 12 ? 10 : 1
      runOperation(\`\${fixture.name} mask\`, maskBaseline, maskCurrent, repetitions)
      runOperation(\`\${fixture.name} analyze\`, analyzeBaseline, analyzeCurrent, repetitions)
      runOperation(\`\${fixture.name} resolve\`, resolveBaseline, resolveCurrent, repetitions)
      runOperation(\`\${fixture.name} format\`, formatBaseline, formatCurrent, repetitions)
    }
    console.log(\`measurement sink=\${sink}\`)
  }, 30_000)
})
`
}

const tempRoot = mkdtempSync(join(tmpdir(), 'leetcoder-editor-comparison-'))
const baselineRoot = join(tempRoot, 'baseline')
const currentRoot = join(tempRoot, 'current')
mkdirSync(baselineRoot, { recursive: true })
mkdirSync(currentRoot, { recursive: true })

let output = ''
let exitCode = 0
try {
  const baselineCommit = git('rev-parse', `${baselineRef}^{commit}`)
  const currentCommit = git('rev-parse', 'HEAD')
  const archivePath = join(tempRoot, 'baseline.tar')
  writeFileSync(archivePath, execFileSync('git', ['archive', '--format=tar', baselineCommit, 'src'], { cwd: repository }))
  execFileSync('tar', ['-xf', archivePath, '-C', baselineRoot])
  cpSync(join(repository, 'src'), join(currentRoot, 'src'), { recursive: true })

  const baselineRecords = sourceFiles.map((relativePath) => sourceRecord(baselineRoot, relativePath))
  const currentRecords = sourceFiles.map((relativePath) => sourceRecord(currentRoot, relativePath))
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const baselineRecord = baselineRecords[index]
    const currentRecord = currentRecords[index]
    const expectedBaselineBlob = git('rev-parse', `${baselineCommit}:${baselineRecord.relativePath}`)
    if (baselineRecord.gitBlob !== expectedBaselineBlob) {
      throw new Error(`baseline snapshot mismatch for ${baselineRecord.relativePath}`)
    }
    const workingTreePath = join(repository, currentRecord.relativePath)
    if (currentRecord.sha256 !== sha256(workingTreePath)) {
      throw new Error(`current snapshot mismatch for ${currentRecord.relativePath}`)
    }
  }

  symlinkSync(join(repository, 'node_modules'), join(tempRoot, 'node_modules'), 'dir')
  const testPath = join(tempRoot, 'compare-editor.test.ts')
  writeFileSync(testPath, benchmarkTestSource(baselineRoot, currentRoot))
  const vitestPath = join(repository, 'node_modules/vitest/vitest.mjs')
  if (!existsSync(vitestPath)) throw new Error(`Vitest entrypoint not found: ${vitestPath}`)

  const vitest = spawnSync(
    process.execPath,
    [vitestPath, 'run', testPath, '--root', tempRoot, '--reporter=verbose'],
    { cwd: repository, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  )
  const baselineHashLines = baselineRecords
    .map((record) => `baseline ${record.relativePath}: sha256=${record.sha256} gitBlob=${record.gitBlob}`)
    .join('\n')
  const currentHashLines = currentRecords
    .map((record) => `current ${record.relativePath}: sha256=${record.sha256} gitBlob=${record.gitBlob}`)
    .join('\n')
  output = [
    `repository=${repository}`,
    `baseline ref=${baselineRef} resolved=${baselineCommit}`,
    `current HEAD=${currentCommit} (working-tree src snapshot)`,
    baselineHashLines,
    currentHashLines,
    '',
    vitest.stdout ?? '',
    vitest.stderr ?? '',
  ].join('\n')
  exitCode = vitest.status ?? 1
} catch (error) {
  output = `${output}${output ? '\n' : ''}${error instanceof Error ? error.stack : String(error)}\n`
  exitCode = 1
} finally {
  writeFileSync(logPath, output)
  process.stdout.write(output)
  rmSync(tempRoot, { recursive: true, force: true })
}

process.exitCode = exitCode

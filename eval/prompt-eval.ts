// Scores the test-generation prompt against invented problems, reusing the app's own
// code so a pass means the app would succeed. See docs/ai-test-generation.md.
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { spawn } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { psSignatures } from '../src/app/ai-controller'
import type { DailyProblem, PsLibraryMetadata } from '../src/backend'
import { psLibraryExtension, setPsLibraryMetadata } from '../src/completions/library'
import {
  declaresJavaSolutionConstructor,
  extractJavaMethodSignature,
  renderJavaProblemSource,
} from '../src/domain'
import { applyAiTestStatements, listJavaMethodHeaders } from '../src/editor/ai-tests'
import { javaAutoImports } from '../src/editor/auto-import'
import { mutableEditorView } from '../tests/frontend/editor/helpers'
import {
  classifyGradleRun,
  countExamples,
  countScenarios,
  fullyQualifiedClassName,
  resetTestBody,
  type GradleVerdict,
} from './helpers'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CACHE_DIR = join(REPO_ROOT, 'eval/.cache')
const OUT_DIR = join(REPO_ROOT, 'eval/.out')
const PROBLEMS_DIR = join(REPO_ROOT, 'eval/problems')
const CARGO_TARGET_DIR = join(tmpdir(), 'leetcoder-prompt-eval-cargo')
const GRADLE_TIMEOUT_MS = 5 * 60 * 1000
const CARGO_TIMEOUT_MS = 2 * 60 * 60 * 1000
const TRIVIAL_STATEMENT = 'assertThat(1).isEqualTo(1);'

interface ProcessResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

interface EvalCase {
  name: string
  /** The reference solution, whose `test` method asserts every example. */
  source: string
  fqcn: string
  /** The model should return no statements, because no call can be written. */
  expectEmpty: boolean
}

/** `eval_prepare` refuses a fixture with no content. */
type FixtureProblem = DailyProblem & { content: string }

interface PrepareOutput {
  javaHome: string
  problems: Record<string, FixtureProblem>
  errors: string[]
}

interface GenerateRequest {
  selectedModelId: string | null
  problemTitle: string
  problemContent: string
  entryPoint: string | null
  javaSnippet: string | null
  methodHeaders: string[]
  psSignatures: string[]
}

interface GenerateResult {
  id: string
  outcome: string | null
  statements: string[]
  servedModel: string | null
  wrongModel: boolean
  error: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number | null
  } | null
}

interface PreparedCase {
  evalCase: EvalCase
  problem: FixtureProblem
  request: GenerateRequest
}

interface CaseReport {
  name: string
  result: string
  passed: boolean | null
  details: string[]
  coverage: string
  requestChars: number
  statements: string[]
  usage: GenerateResult['usage']
  servedModel: string | null
}

/** Every directory under `eval/problems/` is a case: its name, fixture, and reference file. */
async function discoverCases(): Promise<EvalCase[]> {
  const entries = await readdir(PROBLEMS_DIR, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  return Promise.all(names.map(readCase))
}

async function readCase(name: string): Promise<EvalCase> {
  const directory = join(PROBLEMS_DIR, name)
  const files = await readdir(directory)
  const javaFiles = files.filter((file) => file.endsWith('.java'))
  if (javaFiles.length !== 1) {
    throw new Error(`${name}: expected one Java file, found ${javaFiles.length}.`)
  }
  const sourcePath = join(directory, javaFiles[0])
  const source = await readFile(sourcePath, 'utf8')
  const meta = files.includes('meta.json')
    ? JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')) as { expectEmpty?: boolean }
    : {}
  return {
    name,
    source,
    fqcn: fullyQualifiedClassName(source, sourcePath),
    expectEmpty: meta.expectEmpty === true,
  }
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolvePromise({ exitCode, timedOut, stdout, stderr })
    })
  })
}

async function runNativeStep(testName: string, inputPath: string, outputPath: string): Promise<ProcessResult> {
  return run(
    'cargo',
    ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', `ai::eval::${testName}`, '--', '--ignored', '--exact'],
    {
      cwd: REPO_ROOT,
      env: {
        CARGO_TARGET_DIR,
        CARGO_INCREMENTAL: '0',
        LEETCODER_EVAL_INPUT: inputPath,
        LEETCODER_EVAL_OUTPUT: outputPath,
      },
      timeoutMs: CARGO_TIMEOUT_MS,
    },
  )
}

function assertNativeStep(step: string, result: ProcessResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`Native step ${step} failed:\n${`${result.stdout}\n${result.stderr}`.slice(-2000)}`)
  }
}

/** A fresh project holding the ps build and only one Java file, so the ps repo stays untouched. */
async function createProject(root: string, psRepo: string): Promise<string> {
  const project = join(root, 'project')
  await mkdir(project)
  await copyFile(join(psRepo, 'build.gradle'), join(project, 'build.gradle'))
  await copyFile(join(psRepo, 'settings.gradle'), join(project, 'settings.gradle'))
  await copyFile(join(psRepo, 'gradlew'), join(project, 'gradlew'))
  await chmod(join(project, 'gradlew'), 0o755)
  await cp(join(psRepo, 'gradle'), join(project, 'gradle'), { recursive: true })
  await writeFile(join(project, 'gradle.properties'), 'org.gradle.daemon.idletimeout=60000\n')
  return project
}

/**
 * The file goes in the test source set, not the ps repo's main one, because the
 * plain `test` task only runs the former. The app reaches main with an init script.
 */
async function runTest(project: string, javaHome: string, fqcn: string, source: string): Promise<GradleVerdict> {
  const testSources = join(project, 'src/test/java')
  await rm(testSources, { recursive: true, force: true })
  await rm(join(project, 'build'), { recursive: true, force: true })
  const path = join(testSources, `${fqcn.replaceAll('.', '/')}.java`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, source)

  const result = await run(
    './gradlew',
    ['test', '--tests', `${fqcn}.test`, '--offline', '--console=plain'],
    {
      cwd: project,
      env: {
        JAVA_HOME: javaHome,
        PATH: `${join(javaHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
      timeoutMs: GRADLE_TIMEOUT_MS,
    },
  )
  const junitXml = await readFile(join(project, `build/test-results/test/TEST-${fqcn}.xml`), 'utf8').catch(() => null)
  return classifyGradleRun({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output: `${result.stdout}\n${result.stderr}`,
    junitXml,
  })
}

/** Builds the request as `src/app/ai-controller.ts` does, over the source a new file would have. */
function buildRequest(
  problem: FixtureProblem,
  metadata: PsLibraryMetadata,
  fqcn: string,
  selectedModelId: string | null,
): GenerateRequest {
  const javaSnippet = problem.javaSnippet?.trim() ? problem.javaSnippet : null
  const signature = extractJavaMethodSignature(javaSnippet)
  const designProblem = javaSnippet !== null && (!signature || declaresJavaSolutionConstructor(javaSnippet))
  const lastDot = fqcn.lastIndexOf('.')
  const newFile = renderJavaProblemSource(fqcn.slice(0, lastDot), fqcn.slice(lastDot + 1), signature)
  return {
    selectedModelId,
    problemTitle: problem.title,
    problemContent: problem.content,
    entryPoint: designProblem ? null : signature,
    javaSnippet,
    methodHeaders: listJavaMethodHeaders(newFile),
    psSignatures: psSignatures(metadata),
  }
}

/** Applies statements with the editor's own path: validation, formatting, and auto-imports. */
function spliceStatements(
  source: string,
  statements: readonly string[],
  metadata: PsLibraryMetadata,
): { ok: true; source: string } | { ok: false; reason: string } {
  const state = EditorState.create({
    doc: resetTestBody(source),
    extensions: [java(), javaAutoImports, psLibraryExtension],
  }).update({ effects: setPsLibraryMetadata.of(metadata) }).state
  const { view, state: current } = mutableEditorView(state)
  const result = applyAiTestStatements(view, statements)
  return result.ok ? { ok: true, source: current().doc.toString() } : { ok: false, reason: result.reason }
}

function blankReport(evalCase: EvalCase): CaseReport {
  return {
    name: evalCase.name,
    result: '',
    passed: null,
    details: [],
    coverage: '-',
    requestChars: 0,
    statements: [],
    usage: null,
    servedModel: null,
  }
}

function coverageOf(prepared: PreparedCase, statements: readonly string[]): string {
  const examples = countExamples(prepared.problem.content)
  const scenarios = countScenarios(statements, prepared.request.entryPoint, prepared.request.javaSnippet)
  return `${scenarios}/${examples}${scenarios < examples ? ' short' : ''}`
}

async function scoreGenerated(
  prepared: PreparedCase,
  generated: GenerateResult,
  report: CaseReport,
  project: string,
  javaHome: string,
  metadata: PsLibraryMetadata,
): Promise<void> {
  report.statements = generated.statements
  report.usage = generated.usage
  report.servedModel = generated.servedModel
  const fail = (result: string, details: string[] = []): void => {
    report.result = result
    report.passed = false
    report.details = details
  }

  if (generated.wrongModel) {
    fail('wrong-model', [`Served ${generated.servedModel ?? 'an unknown model'}.`])
    return
  }
  if (generated.error !== null) {
    fail('error', [generated.error])
    return
  }
  if (generated.outcome !== 'ok') {
    fail(generated.outcome ?? 'error')
    return
  }
  if (prepared.evalCase.expectEmpty) {
    if (generated.statements.length === 0) {
      report.result = 'empty as expected'
      report.passed = true
    } else {
      fail('expected empty', generated.statements)
    }
    return
  }
  if (generated.statements.length === 0) {
    fail('empty')
    return
  }

  report.coverage = coverageOf(prepared, generated.statements)
  const spliced = spliceStatements(prepared.evalCase.source, generated.statements, metadata)
  if (!spliced.ok) {
    fail(`rejected: ${spliced.reason}`)
    return
  }
  const verdict = await runTest(project, javaHome, prepared.evalCase.fqcn, spliced.source)
  if (verdict.kind === 'pass') {
    report.result = 'pass'
    report.passed = true
    return
  }
  fail(verdict.kind, verdict.details)
}

function printTable(reports: readonly CaseReport[], dry: boolean): void {
  const rows = reports.map((report) => [
    report.name,
    report.result,
    dry ? (report.requestChars > 0 ? String(report.requestChars) : '-') : report.coverage,
    report.usage ? `${report.usage.inputTokens}/${report.usage.outputTokens}` : '-',
    report.usage ? String(report.usage.cacheWriteTokens) : '-',
    report.usage ? String(report.usage.cacheReadTokens) : '-',
    report.usage?.costUsd != null ? `$${report.usage.costUsd.toFixed(4)}` : '-',
  ])
  const header = ['case', 'result', dry ? 'request chars' : 'coverage', 'tokens in/out', 'cache write', 'cache read', 'cost']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)))
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  console.log(['', line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n'))
  for (const report of reports.filter((candidate) => candidate.details.length > 0)) {
    console.log(`\n${report.name} ${report.result}:\n  ${report.details.join('\n  ')}`)
  }
  const passed = reports.filter((report) => report.passed === true).length
  const failed = reports.filter((report) => report.passed === false).length
  const excluded = reports.filter((report) => report.passed === null).length
  const totalCost = reports.reduce((total, report) => total + (report.usage?.costUsd ?? 0), 0)
  const totalIn = reports.reduce((total, report) => total + (report.usage?.inputTokens ?? 0), 0)
  const totalOut = reports.reduce((total, report) => total + (report.usage?.outputTokens ?? 0), 0)
  const totalWrite = reports.reduce((total, report) => total + (report.usage?.cacheWriteTokens ?? 0), 0)
  const totalRead = reports.reduce((total, report) => total + (report.usage?.cacheReadTokens ?? 0), 0)
  console.log(
    `\nTotal: ${passed} passed, ${failed} failed, ${excluded} excluded; `
    + `tokens ${totalIn}/${totalOut}; cache write ${totalWrite}, read ${totalRead}; `
    + `prompt ${totalIn + totalWrite + totalRead}; $${totalCost.toFixed(4)}`,
  )
}

it('scores the test generation prompt', async () => {
  const dry = process.env.EVAL_DRY === '1'
  const model = process.env.EVAL_MODEL?.trim() || null
  if (!dry && !model) {
    throw new Error('Set EVAL_MODEL, or EVAL_DRY=1 for a run without model calls.')
  }
  const wanted = process.env.EVAL_CASES?.split(',').map((name) => name.trim()).filter(Boolean)
  const allCases = await discoverCases()
  const cases = wanted ? allCases.filter((evalCase) => wanted.includes(evalCase.name)) : allCases
  if (cases.length === 0) {
    throw new Error(`No case matches EVAL_CASES=${process.env.EVAL_CASES ?? ''}.`)
  }
  const psRepo = resolve(REPO_ROOT, process.env.EVAL_PS_REPO ?? '../ps')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runName = `${dry ? 'dry' : model}-${stamp}`
  await mkdir(OUT_DIR, { recursive: true })

  const root = await mkdtemp(join(tmpdir(), 'leetcoder-prompt-eval-'))
  const toolErrors: string[] = []
  const reports: CaseReport[] = []
  try {
    console.log('Parsing fixtures and building the native steps...')
    const prepareInput = join(root, 'prepare-input.json')
    const prepareOutput = join(root, 'prepare-output.json')
    await writeFile(prepareInput, JSON.stringify({
      fixtures: cases.map((evalCase) => ({
        name: evalCase.name,
        path: join(PROBLEMS_DIR, evalCase.name, 'problem.json'),
      })),
      psRepo,
      cacheDir: CACHE_DIR,
    }))
    assertNativeStep('eval_prepare', await runNativeStep('eval_prepare', prepareInput, prepareOutput))
    const native = JSON.parse(await readFile(prepareOutput, 'utf8')) as PrepareOutput
    toolErrors.push(...native.errors)
    const metadata = JSON.parse(
      await readFile(join(CACHE_DIR, 'ps-metadata.json'), 'utf8'),
    ) as PsLibraryMetadata

    const project = await createProject(root, psRepo)
    const prepared = new Map<string, PreparedCase>()
    for (const evalCase of cases) {
      const report = blankReport(evalCase)
      reports.push(report)
      const problem = native.problems[evalCase.name]
      if (!problem) {
        // The native step already reported why, as a tool error.
        report.result = 'excluded: fixture'
        continue
      }
      const request = buildRequest(problem, metadata, evalCase.fqcn, model)
      report.requestChars = JSON.stringify(request).length

      // Free, and before any call, so a broken case is never charged.
      const baseline = await runTest(project, native.javaHome, evalCase.fqcn, evalCase.source)
      if (baseline.kind !== 'pass') {
        report.result = `excluded: baseline ${baseline.kind}`
        report.details = baseline.details
        if (baseline.kind === 'tool') {
          toolErrors.push(`${evalCase.name} baseline: ${baseline.details.join(' ')}`)
        }
        continue
      }
      report.result = 'baseline ok'
      console.log(`${evalCase.name}: baseline passed`)
      prepared.set(evalCase.name, { evalCase, problem, request })
    }

    if (dry) {
      for (const report of reports) {
        const current = prepared.get(report.name)
        if (!current) continue
        const spliced = spliceStatements(current.evalCase.source, [TRIVIAL_STATEMENT], metadata)
        if (!spliced.ok) {
          report.result = `splice rejected: ${spliced.reason}`
          report.passed = false
          toolErrors.push(`${report.name} splice: ${spliced.reason}`)
          continue
        }
        const verdict = await runTest(project, native.javaHome, current.evalCase.fqcn, spliced.source)
        report.passed = verdict.kind === 'pass'
        report.result = verdict.kind === 'pass' ? 'baseline+splice+gradle ok' : `trivial ${verdict.kind}`
        if (verdict.kind !== 'pass') {
          report.details = verdict.details
          toolErrors.push(`${report.name} trivial run: ${verdict.details.join(' ')}`)
        }
        console.log(`${report.name}: ${report.result}`)
      }
    } else if (toolErrors.length === 0) {
      const generateInput = join(root, 'generate-input.json')
      // Kept in the ignored output directory, since these calls are paid for.
      const generateOutput = join(OUT_DIR, `${runName}.generate.json`)
      await writeFile(generateInput, JSON.stringify(
        [...prepared.values()].map(({ evalCase, request }) => ({ id: evalCase.name, request })),
      ))
      console.log(`Generating ${prepared.size} cases with ${model}...`)
      const generated = await runNativeStep('eval_generate', generateInput, generateOutput)
      if (generated.exitCode !== 0) {
        toolErrors.push(`eval_generate failed:\n${`${generated.stdout}\n${generated.stderr}`.slice(-2000)}`)
      }
      const results = JSON.parse(await readFile(generateOutput, 'utf8').catch(() => '[]')) as GenerateResult[]
      const byId = new Map(results.map((result) => [result.id, result]))
      for (const report of reports) {
        const current = prepared.get(report.name)
        if (!current) continue
        const result = byId.get(report.name)
        if (!result) {
          report.result = 'not called'
          continue
        }
        await scoreGenerated(current, result, report, project, native.javaHome, metadata)
        console.log(`${report.name}: ${report.result}`)
        if (result.wrongModel) {
          toolErrors.push(`${report.name}: wrong model, ${report.details.join(' ')} The run stopped.`)
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    printTable(reports, dry)
    const outputPath = join(OUT_DIR, `${runName}.json`)
    await writeFile(outputPath, `${JSON.stringify({ model, dry, reports, toolErrors }, null, 2)}\n`)
    console.log(`Details: ${outputPath}`)
  }

  // Model failures are data. Only a broken tool or a wrong model fails the run.
  expect(toolErrors).toEqual([])
})

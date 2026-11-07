// Scores the test-generation prompt against invented problems, reusing the app's own
// code so a pass means the app would succeed. See docs/ai-test-generation.md.
import { java } from '@codemirror/lang-java'
import { EditorState } from '@codemirror/state'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  classifyRunnerResult,
  countExamples,
  countScenarios,
  fullyQualifiedClassName,
  resetTestBody,
  type RunnerResult,
  type Verdict,
} from './helpers'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CACHE_DIR = join(REPO_ROOT, 'eval/.cache')
const OUT_DIR = join(REPO_ROOT, 'eval/.out')
const PROBLEMS_DIR = join(REPO_ROOT, 'eval/problems')
const CARGO_TARGET_DIR = join(tmpdir(), 'leetcoder-prompt-eval-cargo')
const RUNNER_SOURCE = join(REPO_ROOT, 'eval/JavaGradeRunner.java')
const CLASSPATH_CACHE = join(CACHE_DIR, 'java-classpath.json')
const CLASSPATH_MARKER = 'LEETCODER_EVAL_CLASSPATH:'
// Files that decide the classpath and compiler levels, relative to the ps repo.
const PS_PROJECT_FILES = ['build.gradle', 'settings.gradle', 'gradle.properties']
const PS_BUILD_FILES = [...PS_PROJECT_FILES, 'gradle/wrapper/gradle-wrapper.properties']
const GRADLE_TIMEOUT_MS = 5 * 60 * 1000
const CARGO_TIMEOUT_MS = 2 * 60 * 60 * 1000
// This machine has been overloaded by rebuilds of the native steps.
const CARGO_BUILD_JOBS = '4'
const TEST_TIMEOUT_MS = 30 * 1000
const COMPILE_ALLOWANCE_MS = 10 * 1000
const RUNNER_STARTUP_ALLOWANCE_MS = 60 * 1000
// The heap and assertions are what Gradle's test task defaults to. The rest keeps the
// JVM off the other cores, since the batch runs one case at a time.
const RUNNER_JVM_FLAGS = ['-Xmx512m', '-ea', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1']
const CLASSPATH_INIT_SCRIPT = `
import groovy.json.JsonOutput

allprojects {
    plugins.withId('java') {
        if (project == rootProject) {
            tasks.register('leetcoderPrintEvalClasspath') {
                doLast {
                    println('${CLASSPATH_MARKER}' + JsonOutput.toJson([
                        compile: configurations.testCompileClasspath.files*.canonicalPath,
                        runtime: configurations.testRuntimeClasspath.files*.canonicalPath,
                        source: compileTestJava.sourceCompatibility.toString(),
                        target: compileTestJava.targetCompatibility.toString(),
                    ]))
                }
            }
        }
    }
}
`
const TRIVIAL_STATEMENT = 'assertThat(1).isEqualTo(1);'

interface ProcessResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** How the ps build compiles and runs its tests. */
interface JavaBuild {
  compile: string[]
  runtime: string[]
  source: string
  target: string
}

interface GradeItem {
  id: string
  fqcn: string
  source: string
}

/** A further correct solution, which returns a different valid answer from the examples' output. */
interface Alternative {
  name: string
  source: string
}

/** What one case grades on: the reference and its alternatives, as they are or spliced. */
interface CaseSources extends GradeItem {
  alternatives: Alternative[]
}

/** `alternative` names the alternative that failed, when the reference did not. */
type CaseVerdict = Verdict & { alternative?: string }

interface EvalCase {
  name: string
  /** The reference solution, whose `test` method asserts every example. */
  source: string
  fqcn: string
  /** The model should return no statements, because no call can be written. */
  expectEmpty: boolean
  alternatives: Alternative[]
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
  report: CaseReport
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
    alternatives: files.includes('alternatives') ? await readAlternatives(join(directory, 'alternatives')) : [],
  }
}

/** Each file declares the reference's class, so its own name is free to say what it does differently. */
async function readAlternatives(directory: string): Promise<Alternative[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.java')).sort()
  return Promise.all(files.map(async (file) => ({
    name: file.replace(/\.java$/, ''),
    source: await readFile(join(directory, file), 'utf8'),
  })))
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
        CARGO_BUILD_JOBS,
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

/** Gradle runs once per change to the ps build files, over a copy of them so the ps repo stays untouched. */
async function resolveJavaBuild(psRepo: string, javaHome: string, root: string): Promise<JavaBuild> {
  const contents = await Promise.all(PS_BUILD_FILES.map((file) => readFile(join(psRepo, file), 'utf8').catch(() => '')))
  const key = createHash('sha256').update(JSON.stringify([javaHome, ...contents])).digest('hex')
  const cached = JSON.parse(await readFile(CLASSPATH_CACHE, 'utf8').catch(() => 'null')) as
    (JavaBuild & { key: string }) | null
  if (cached?.key === key && await allExist([...cached.compile, ...cached.runtime])) {
    return cached
  }

  console.log('Resolving the Java classpath with Gradle...')
  const project = join(root, 'classpath-project')
  await mkdir(project)
  // Not every one of them has to exist, and Gradle reports the ones it needs.
  await Promise.all(PS_PROJECT_FILES.map((file) => copyFile(join(psRepo, file), join(project, file)).catch(() => undefined)))
  const initScript = join(root, 'classpath.init.gradle')
  await writeFile(initScript, CLASSPATH_INIT_SCRIPT)
  const result = await run(
    join(psRepo, 'gradlew'),
    ['-p', project, '--init-script', initScript, '--offline', '--no-daemon', '--console=plain', '--quiet', 'leetcoderPrintEvalClasspath'],
    { cwd: project, env: { JAVA_HOME: javaHome }, timeoutMs: GRADLE_TIMEOUT_MS },
  )
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(CLASSPATH_MARKER))
  if (result.exitCode !== 0 || !line) {
    throw new Error(`Could not resolve the Java classpath:\n${`${result.stdout}\n${result.stderr}`.slice(-2000)}`)
  }
  const build = JSON.parse(line.slice(CLASSPATH_MARKER.length)) as JavaBuild
  await writeFile(CLASSPATH_CACHE, `${JSON.stringify({ key, ...build }, null, 2)}\n`)
  return build
}

/** Gradle can clean a jar out of its cache after the classpath was saved. */
async function allExist(paths: readonly string[]): Promise<boolean> {
  const checks = await Promise.all(paths.map((path) => access(path).then(() => true, () => false)))
  return checks.every(Boolean)
}

/** Grades the items in one JVM, in order, and returns their verdicts in that order. */
async function gradeBatch(
  batchDir: string,
  javaHome: string,
  build: JavaBuild,
  items: readonly GradeItem[],
): Promise<Verdict[]> {
  if (items.length === 0) return []
  const rows = await Promise.all(items.map(async ({ id, fqcn, source }, index) => {
    const directory = join(batchDir, String(index))
    const path = join(directory, 'src', `${fqcn.replaceAll('.', '/')}.java`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
    return `${id}\t${fqcn}\t${directory}\n`
  }))
  await writeFile(join(batchDir, 'cases.tsv'), rows.join(''))

  const result = await run(
    join(javaHome, 'bin', 'java'),
    [
      ...RUNNER_JVM_FLAGS,
      '-cp', build.runtime.join(delimiter),
      RUNNER_SOURCE,
      batchDir,
      String(TEST_TIMEOUT_MS),
      build.source,
      build.target,
      build.compile.join(delimiter),
    ],
    {
      cwd: batchDir,
      timeoutMs: RUNNER_STARTUP_ALLOWANCE_MS + items.length * (TEST_TIMEOUT_MS + COMPILE_ALLOWANCE_MS),
    },
  )
  const lines = await readFile(join(batchDir, 'results.jsonl'), 'utf8').catch(() => '')
  const results = lines.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunnerResult & { id: string })
  const byId = new Map(results.map((entry) => [entry.id, entry]))
  return items.map(({ id }) => {
    const entry = byId.get(id)
    if (entry) return classifyRunnerResult(entry)
    const ending = result.timedOut ? 'timed out' : `exited with ${result.exitCode}`
    return { kind: 'tool', details: [`The runner ${ending} before this case. ${result.stderr.slice(-500)}`.trim()] }
  })
}

/**
 * Grades every reference and alternative in one batch, and returns one verdict per case.
 * A failed reference outranks its alternatives, so only a failure the reference does not
 * share is reported as the alternative's.
 */
async function gradeCases(
  batchDir: string,
  javaHome: string,
  build: JavaBuild,
  cases: readonly CaseSources[],
): Promise<CaseVerdict[]> {
  const verdicts = await gradeBatch(batchDir, javaHome, build, cases.flatMap(({ id, fqcn, source, alternatives }) => [
    { id, fqcn, source },
    ...alternatives.map((alternative) => ({ id: `${id}/${alternative.name}`, fqcn, source: alternative.source })),
  ]))
  let next = 0
  return cases.map(({ alternatives }) => {
    const reference = verdicts[next++]
    const failures: CaseVerdict[] = []
    for (const { name } of alternatives) {
      const verdict = verdicts[next++]
      if (verdict.kind !== 'pass') {
        failures.push({ ...verdict, alternative: name, details: [`Alternative ${name}:`, ...verdict.details] })
      }
    }
    return reference.kind === 'pass' && failures.length > 0 ? failures[0] : reference
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

/** Splices into the reference and every alternative, since all of them must accept the statements. */
function spliceCase(
  evalCase: EvalCase,
  statements: readonly string[],
  metadata: PsLibraryMetadata,
): { ok: true; sources: CaseSources } | { ok: false; reason: string } {
  const reference = spliceStatements(evalCase.source, statements, metadata)
  if (!reference.ok) return reference
  const alternatives: Alternative[] = []
  for (const { name, source } of evalCase.alternatives) {
    const spliced = spliceStatements(source, statements, metadata)
    if (!spliced.ok) return { ok: false, reason: `${spliced.reason} on alternative ${name}` }
    alternatives.push({ name, source: spliced.source })
  }
  return { ok: true, sources: { id: evalCase.name, fqcn: evalCase.fqcn, source: reference.source, alternatives } }
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

/** Settles the report unless the reply has statements to run, and then returns the sources to grade. */
function spliceGenerated(
  prepared: PreparedCase,
  generated: GenerateResult,
  report: CaseReport,
  metadata: PsLibraryMetadata,
): CaseSources | null {
  report.statements = generated.statements
  report.usage = generated.usage
  report.servedModel = generated.servedModel
  const fail = (result: string, details: string[] = []): null => {
    report.result = result
    report.passed = false
    report.details = details
    return null
  }

  if (generated.wrongModel) {
    return fail('wrong-model', [`Served ${generated.servedModel ?? 'an unknown model'}.`])
  }
  if (generated.error !== null) {
    return fail('error', [generated.error])
  }
  if (generated.outcome !== 'ok') {
    return fail(generated.outcome ?? 'error')
  }
  if (prepared.evalCase.expectEmpty) {
    if (generated.statements.length === 0) {
      report.result = 'empty as expected'
      report.passed = true
      return null
    }
    return fail('expected empty', generated.statements)
  }
  if (generated.statements.length === 0) {
    return fail('empty')
  }

  report.coverage = coverageOf(prepared, generated.statements)
  const spliced = spliceCase(prepared.evalCase, generated.statements, metadata)
  return spliced.ok ? spliced.sources : fail(`rejected: ${spliced.reason}`)
}

function alternativeFailure(kind: Verdict['kind']): string {
  return kind === 'assertion' ? 'fail: alternative rejects a valid answer' : `fail: alternative ${kind}`
}

function applyVerdict(report: CaseReport, verdict: CaseVerdict): void {
  report.passed = verdict.kind === 'pass'
  report.result = verdict.alternative ? alternativeFailure(verdict.kind) : verdict.kind
  report.details = verdict.kind === 'pass' ? [] : verdict.details
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
  const short = reports.filter((report) => report.coverage.endsWith(' short')).length
  const totalCost = reports.reduce((total, report) => total + (report.usage?.costUsd ?? 0), 0)
  const totalIn = reports.reduce((total, report) => total + (report.usage?.inputTokens ?? 0), 0)
  const totalOut = reports.reduce((total, report) => total + (report.usage?.outputTokens ?? 0), 0)
  const totalWrite = reports.reduce((total, report) => total + (report.usage?.cacheWriteTokens ?? 0), 0)
  const totalRead = reports.reduce((total, report) => total + (report.usage?.cacheReadTokens ?? 0), 0)
  console.log(
    `\nTotal: ${passed} passed, ${failed} failed, ${excluded} excluded, ${short} short on coverage; `
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

    const javaBuild = await resolveJavaBuild(psRepo, native.javaHome, root)
    const candidates: PreparedCase[] = []
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
      candidates.push({ evalCase, problem, request, report })
    }

    // Free, and before any call, so a broken case is never charged.
    console.log(`Grading ${candidates.length} baselines...`)
    const baselines = await gradeCases(
      join(root, 'baselines'),
      native.javaHome,
      javaBuild,
      candidates.map(({ evalCase: { name, fqcn, source, alternatives } }) => ({ id: name, fqcn, source, alternatives })),
    )
    const prepared = candidates.filter(({ evalCase, report }, index) => {
      const baseline = baselines[index]
      if (baseline.kind === 'pass') {
        console.log(`${evalCase.name}: baseline passed`)
        report.result = 'baseline ok'
        return true
      }
      report.result = `excluded: ${baseline.alternative ? 'alternative ' : ''}baseline ${baseline.kind}`
      report.details = baseline.details
      if (baseline.kind === 'tool') {
        toolErrors.push(`${evalCase.name} baseline: ${baseline.details.join(' ')}`)
      }
      return false
    })

    if (dry) {
      const items: (CaseSources & { report: CaseReport })[] = []
      for (const { evalCase, report } of prepared) {
        const spliced = spliceCase(evalCase, [TRIVIAL_STATEMENT], metadata)
        if (spliced.ok) {
          items.push({ ...spliced.sources, report })
        } else {
          report.result = `splice rejected: ${spliced.reason}`
          report.passed = false
          toolErrors.push(`${report.name} splice: ${spliced.reason}`)
        }
      }
      console.log(`Grading ${items.length} spliced sources...`)
      const verdicts = await gradeCases(join(root, 'trivial'), native.javaHome, javaBuild, items)
      items.forEach(({ report }, index) => {
        const verdict = verdicts[index]
        report.passed = verdict.kind === 'pass'
        report.result = verdict.kind === 'pass'
          ? 'baseline+splice+run ok'
          : `trivial ${verdict.alternative ? 'alternative ' : ''}${verdict.kind}`
        console.log(`${report.name}: ${report.result}`)
        if (verdict.kind === 'pass') return
        report.details = verdict.details
        toolErrors.push(`${report.name} trivial run: ${verdict.details.join(' ')}`)
      })
    } else if (toolErrors.length === 0) {
      const generateInput = join(root, 'generate-input.json')
      // Kept in the ignored output directory, since these calls are paid for.
      const generateOutput = join(OUT_DIR, `${runName}.generate.json`)
      await writeFile(generateInput, JSON.stringify(
        prepared.map(({ evalCase, request }) => ({ id: evalCase.name, request })),
      ))
      console.log(`Generating ${prepared.length} cases with ${model}...`)
      const generated = await runNativeStep('eval_generate', generateInput, generateOutput)
      if (generated.exitCode !== 0) {
        toolErrors.push(`eval_generate failed:\n${`${generated.stdout}\n${generated.stderr}`.slice(-2000)}`)
      }
      const results = JSON.parse(await readFile(generateOutput, 'utf8').catch(() => '[]')) as GenerateResult[]
      const byId = new Map(results.map((result) => [result.id, result]))
      const items: (CaseSources & { report: CaseReport })[] = []
      for (const current of prepared) {
        const { report } = current
        const result = byId.get(report.name)
        if (!result) {
          report.result = 'not called'
          continue
        }
        const sources = spliceGenerated(current, result, report, metadata)
        if (sources !== null) {
          items.push({ ...sources, report })
        }
        if (result.wrongModel) {
          toolErrors.push(`${report.name}: wrong model, ${report.details.join(' ')} The run stopped.`)
        }
      }
      console.log(`Grading ${items.length} generated tests...`)
      const verdicts = await gradeCases(join(root, 'scored'), native.javaHome, javaBuild, items)
      items.forEach(({ report }, index) => applyVerdict(report, verdicts[index]))
      for (const { report } of prepared) {
        console.log(`${report.name}: ${report.result}`)
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

#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const testClass = 'shane.leetcode.problems.easy.BenchmarkProblem'
const testMarker = 'LEETCODER_TEST_EVENT_V1:'
const stageMarker = 'LEETCODER_BENCHMARK_STAGE:'
const junitArtifacts = [
  ['org.junit.jupiter', 'junit-jupiter-api', '5.9.2'],
  ['org.junit.jupiter', 'junit-jupiter-params', '5.9.2'],
  ['org.junit.jupiter', 'junit-jupiter-engine', '5.9.2'],
  ['org.junit.platform', 'junit-platform-commons', '1.9.2'],
  ['org.junit.platform', 'junit-platform-engine', '1.9.2'],
  ['org.apiguardian', 'apiguardian-api', '1.1.2'],
  ['org.opentest4j', 'opentest4j', '1.2.0'],
]

export function extractRustString(source, anchor) {
  const start = source.indexOf(anchor)
  assert(start >= 0, `Cannot find production script declaration ${anchor}`)
  const match = source.slice(start + anchor.length).match(/^\s*(?:=\s*)?r#"([\s\S]*?)"#/)
  assert(match, `Cannot extract production script ${anchor}; update the benchmark extractor`)
  return match[1]
}

export function summarize(values) {
  assert(values.length > 0 && values.every(Number.isFinite), 'Expected finite timing samples')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return { samples: values.length, medianMs: median, minMs: sorted[0], maxMs: sorted.at(-1) }
}

export function compare(baseline, improved) {
  assert(baseline > 0 && improved > 0, 'Comparison requires positive timings')
  return { speedup: baseline / improved, reductionPercent: 100 * (1 - improved / baseline) }
}

export function parseArguments(args) {
  const options = { runs: 5, gradle: null, javaHome: null, cache: path.join(homedir(), '.gradle'), output: null }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    assert(value && !value.startsWith('--'), `Missing value for ${flag}`)
    if (flag === '--runs') options.runs = Number(value)
    else if (flag === '--gradle') options.gradle = path.resolve(value)
    else if (flag === '--java-home') options.javaHome = path.resolve(value)
    else if (flag === '--cache') options.cache = path.resolve(value)
    else if (flag === '--output') options.output = path.resolve(value)
    else throw new Error(`Unknown argument ${flag}`)
  }
  assert(Number.isInteger(options.runs) && options.runs >= 3 && options.runs <= 30, '--runs must be between 3 and 30')
  return options
}

async function directories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function findGradle(cache) {
  for (const distribution of await directories(path.join(cache, 'wrapper', 'dists', 'gradle-7.3.3-bin'))) {
    const executable = path.join(distribution, 'gradle-7.3.3', 'bin', 'gradle')
    try { await access(executable); return executable } catch { /* Try the next cached distribution. */ }
  }
  throw new Error('Gradle 7.3.3 is not installed locally. Pass --gradle /path/to/gradle-7.3.3/bin/gradle. The benchmark never downloads it.')
}

async function findJava() {
  const candidates = [process.env.JAVA_HOME, ...await directories(path.join(homedir(), '.sdkman/candidates/java')),
    ...await directories('/usr/lib/jvm'), ...await directories('/Library/Java/JavaVirtualMachines')]
    .filter(Boolean)
  for (const candidate of candidates) {
    for (const home of [candidate, path.join(candidate, 'Contents/Home')]) {
      try {
        const release = await readFile(path.join(home, 'release'), 'utf8')
        if (/^JAVA_VERSION="17\./m.test(release)) { await access(path.join(home, 'bin/javac')); return home }
      } catch { /* Try the next installed JDK. */ }
    }
  }
  throw new Error('No local JDK 17 found. Pass --java-home /path/to/jdk17.')
}

async function cachedJar(cache, [group, artifact, version]) {
  const root = path.join(cache, 'caches/modules-2/files-2.1', group, artifact, version)
  for (const directory of await directories(root)) {
    const jar = path.join(directory, `${artifact}-${version}.jar`)
    try { await access(jar); return jar } catch { /* Try the next cached artifact. */ }
  }
  throw new Error(`Missing cached ${group}:${artifact}:${version}. Pass --cache with a populated Gradle cache. No network request was made.`)
}

function problemSource(revision) {
  return `package shane.leetcode.problems.easy;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.junit.jupiter.api.Assertions.assertEquals;
import benchmark.Shared;
public class BenchmarkProblem {
    @Test void currentSourceIsCompiled() {
        assertEquals(${revision}, revision());
        System.out.println("BENCHMARK_REVISION=" + revision());
    }
    private int revision() { return ${revision}; }
    @ParameterizedTest @ValueSource(ints = {1, 2})
    void selectedCases(int value) { assertEquals(value + 1, Shared.increment(value)); }
}
`
}

const probeScript = `import groovy.json.JsonOutput
def emitBenchmarkStage = { stage ->
    println('${stageMarker}' + JsonOutput.toJson([
        stage: stage, atMs: System.currentTimeMillis(),
        daemon: java.lang.management.ManagementFactory.runtimeMXBean.name
    ]))
}
gradle.settingsEvaluated { emitBenchmarkStage('settingsReady') }
gradle.projectsEvaluated {
    emitBenchmarkStage('projectsReady')
    allprojects {
        tasks.withType(Test).matching { it.name == 'leetcoderProblemTest' }.configureEach {
            beforeTest { descriptor ->
                if (!descriptor.composite) emitBenchmarkStage('testCaseStarted')
            }
            afterTest { descriptor, result ->
                if (!descriptor.composite) emitBenchmarkStage('testCaseFinished')
            }
        }
    }
}
gradle.taskGraph.beforeTask { task ->
    if (task.name.startsWith('leetcoder')) emitBenchmarkStage(task.name)
}
`

async function waitForLoad() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (loadavg()[0] <= availableParallelism()) return
    console.log(`Waiting for host load ${loadavg()[0].toFixed(2)} to fall below ${availableParallelism()} CPUs`)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  throw new Error('Host load remained above the CPU count for two minutes. Retry when the machine is quieter.')
}

async function runGradle(context, mode, label, task, extraArguments = []) {
  await waitForLoad()
  const runDirectory = path.join(context.output, 'workspace', mode, label)
  await mkdir(runDirectory, { recursive: true })
  const initPath = path.join(runDirectory, 'init.gradle')
  await writeFile(initPath, task === 'leetcoderPrintMainCompileClasspath' ? context.warmupScript : context.runnerScript)
  const args = ['--offline', '--console=plain', '--max-workers=4', '--gradle-user-home', context.homes[mode],
    mode === 'baseline' ? '--no-daemon' : '--daemon', '--init-script', initPath, '--init-script', context.probePath,
    `-DleetcoderResultDir=${path.join(runDirectory, 'results')}`,
    `-DleetcoderClassesDir=${path.join(context.projects[mode], 'build/benchmark/problem')}`,
    `-DleetcoderSharedClassesDir=${path.join(context.projects[mode], 'build/benchmark/shared')}`,
    `-DleetcoderProblemClass=${testClass}`, task, ...extraArguments]
  const started = performance.now()
  const startedEpochMs = Date.now()
  const record = { mode, label, task, args, load: loadavg(), stages: {}, tests: [], tasks: [], daemon: null }
  let stdout = ''
  let stderr = ''
  let pending = ''
  let parseError = null
  let forceStopTimer = null
  const child = spawn(context.gradle, args, { cwd: context.projects[mode],
    detached: process.platform !== 'win32',
    env: { ...process.env, JAVA_HOME: context.javaHome, GRADLE_USER_HOME: context.homes[mode] } })
  const onLine = (line) => {
    const elapsed = performance.now() - started
    if (line.startsWith(stageMarker)) {
      const stage = JSON.parse(line.slice(stageMarker.length))
      // Task logging can buffer println output. Timestamp inside Gradle so
      // delivery delay cannot be misreported as compile or worker startup.
      assert(Number.isFinite(stage.atMs), 'Stage probe requires a source timestamp')
      if (stage.stage !== 'testCaseStarted' || record.stages.testCaseStarted === undefined) {
        record.stages[stage.stage] = stage.atMs - startedEpochMs
      }
      record.daemon = stage.daemon
    }
    if (line.startsWith(testMarker)) {
      const test = JSON.parse(line.slice(testMarker.length))
      if (test.kind === 'started') record.firstTestMs ??= elapsed
      if (test.kind === 'finished') { record.tests.push(test); record.lastTestMs = elapsed }
    }
    if (line.startsWith('> Task ')) record.tasks.push(line.slice(7))
  }
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    const lines = (pending + chunk).split(/\r?\n/)
    pending = lines.pop()
    for (const line of lines) {
      try { onLine(line) } catch (error) { parseError ??= error }
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const watchdog = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') parseError ??= error
    }
    forceStopTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') parseError ??= error
      }
    }, 200)
  }, 120_000)
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (pending) { try { onLine(pending) } catch (error) { parseError ??= error } }
    record.totalMs = performance.now() - started
    const logPath = path.join(context.output, `${mode}-${label}.log`)
    await writeFile(logPath, `${stdout}\n${stderr}`)
    assert(!parseError, `Could not parse ${mode}/${label}: ${parseError?.message}. See ${logPath}`)
    assert.equal(exitCode, 0, `${mode}/${label} failed. See ${logPath}`)
    assert(record.daemon, `${mode}/${label} emitted no Gradle lifecycle events`)
    if (task === 'leetcoderProblemTest') {
      assert.equal(record.tests.length, 3, 'The selected fixture must execute all three test cases')
      assert(record.tests.every((test) => test.status === 'passed'), 'Every fixture test must pass')
      assert(stdout.includes(`BENCHMARK_REVISION=${label === 'edited' ? 2 : 1}`), 'Test output must reflect the latest saved source')
      const reports = await readdir(path.join(runDirectory, 'results'))
      const reportName = reports.find((name) => name === `TEST-${testClass}.xml`)
      assert(reportName, 'Expected selected-class JUnit report')
      const xml = await readFile(path.join(runDirectory, 'results', reportName), 'utf8')
      assert(/tests="3"/.test(xml) && /failures="0"/.test(xml) && /errors="0"/.test(xml), 'JUnit XML must confirm all three passing cases')
      record.testBodyMs = record.tests.reduce((total, test) => total + test.durationMs, 0)
      record.afterLastMarkerMs = record.totalMs - record.lastTestMs
      record.afterTestsMs = record.totalMs - record.stages.testCaseFinished
      record.stageDurations = {
        launchAndSettingsMs: record.stages.settingsReady,
        projectConfigurationMs: record.stages.projectsReady - record.stages.settingsReady,
        taskGraphMs: record.stages.leetcoderSharedCompile - record.stages.projectsReady,
        sharedCompileMs: record.stages.leetcoderProblemCompile - record.stages.leetcoderSharedCompile,
        problemCompileMs: record.stages.leetcoderProblemTest - record.stages.leetcoderProblemCompile,
        testWorkerStartupMs: record.stages.testCaseStarted - record.stages.leetcoderProblemTest,
        testExecutionWindowMs: record.stages.testCaseFinished - record.stages.testCaseStarted,
        afterTestsMs: record.afterTestsMs,
        progressDeliveryLagMs: Math.max(0, record.firstTestMs - record.stages.testCaseStarted),
      }
      assert(Object.values(record.stageDurations).every((duration) => Number.isFinite(duration) && duration >= 0),
        'Every expected lifecycle stage must be present and ordered')
    } else {
      assert(stdout.includes('LEETCODER_PS_CLASSPATH_V1:'), 'Warmup must resolve the production classpath task')
    }
    console.log(`${mode.padEnd(9)} ${label.padEnd(12)} ${Math.round(record.totalMs)}ms total${record.firstTestMs ? `, ${Math.round(record.firstTestMs)}ms to first test` : ''}`)
    return record
  } finally {
    clearTimeout(watchdog)
    clearTimeout(forceStopTimer)
  }
}

export function buildSummary(records) {
  const summary = {}
  for (const mode of ['baseline', 'reuse', 'prewarmed']) {
    const runs = records.filter((record) => record.mode === mode && record.label.startsWith('repeat-'))
    const first = records.find((record) => record.mode === mode && record.label === 'first')
    const edited = records.find((record) => record.mode === mode && record.label === 'edited')
    const warmup = records.find((record) => record.mode === mode && record.label === 'warmup')
    summary[mode] = { firstMs: first.totalMs, firstTestMs: first.firstTestMs, editedMs: edited.totalMs,
      warmupMs: warmup?.totalMs ?? 0, repetitions: summarize(runs.map((run) => run.totalMs)),
      toFirstTest: summarize(runs.map((run) => run.firstTestMs)),
      afterTests: summarize(runs.map((run) => run.afterTestsMs)),
      testBody: summarize(runs.map((run) => run.testBodyMs)),
      stages: Object.fromEntries(Object.keys(runs[0].stageDurations)
        .map((stage) => [stage, summarize(runs.map((run) => run.stageDurations[stage]))])) }
  }
  summary.reuseVsBaseline = compare(summary.baseline.repetitions.medianMs, summary.reuse.repetitions.medianMs)
  summary.prewarmedFirstVsBaseline = compare(summary.baseline.firstMs, summary.prewarmed.firstMs)
  return summary
}

async function main(args) {
  const options = parseArguments(args)
  const [gradle, javaHome, jars, runnerSource, helperSource] = await Promise.all([
    options.gradle ?? findGradle(options.cache), options.javaHome ?? findJava(),
    Promise.all(junitArtifacts.map((artifact) => cachedJar(options.cache, artifact))),
    readFile(path.join(repositoryRoot, 'src-tauri/src/runner/gradle.rs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'src-tauri/src/java_library/helpers.rs'), 'utf8'),
  ])
  const runnerScript = extractRustString(runnerSource, "pub(crate) fn build_gradle_init_script() -> &'static str {")
  const warmupScript = extractRustString(helperSource, 'pub(super) const GRADLE_INIT_SCRIPT: &str')
  const output = options.output ?? await mkdtemp(path.join(tmpdir(), 'leetcoder-runner-benchmark-'))
  await mkdir(output, { recursive: true })
  const workspace = path.join(output, 'workspace')
  await mkdir(workspace)
  const context = { output, gradle, javaHome, runnerScript, warmupScript, projects: {}, homes: {},
    probePath: path.join(workspace, 'probe.gradle') }
  await writeFile(context.probePath, probeScript)
  const records = []
  try {
    for (const mode of ['baseline', 'reuse', 'prewarmed']) {
      const project = path.join(workspace, mode, 'project')
      context.projects[mode] = project
      context.homes[mode] = path.join(workspace, mode, 'gradle-home')
      await mkdir(path.join(project, 'src/main/java/shane/leetcode/problems/easy'), { recursive: true })
      await mkdir(path.join(project, 'src/main/java/benchmark'), { recursive: true })
      await writeFile(path.join(project, 'settings.gradle'), "rootProject.name = 'runner-benchmark'\n")
      await writeFile(path.join(project, 'build.gradle'), `plugins { id 'java' }\nsourceCompatibility = 11\ntargetCompatibility = 11\ndependencies { implementation files(${jars.map((jar) => JSON.stringify(jar)).join(', ')}) }\n`)
      await writeFile(path.join(project, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx512m\norg.gradle.daemon.idletimeout=600000\n')
      await writeFile(path.join(project, 'src/main/java/benchmark/Shared.java'), 'package benchmark; public class Shared { public static int increment(int value) { return value + 1; } }\n')
      await writeFile(path.join(project, 'src/main/java/shane/leetcode/problems/easy/BenchmarkProblem.java'), problemSource(1))
    }
    console.log(`Offline fixture benchmark. Logs and report in ${output}`)
    // First runs include empty project/build caches. Prewarming cost is reported separately.
    records.push(await runGradle(context, 'baseline', 'first', 'leetcoderProblemTest', ['--tests', testClass]))
    records.push(await runGradle(context, 'reuse', 'first', 'leetcoderProblemTest', ['--tests', testClass]))
    records.push(await runGradle(context, 'prewarmed', 'warmup', 'leetcoderPrintMainCompileClasspath'))
    records.push(await runGradle(context, 'prewarmed', 'first', 'leetcoderProblemTest', ['--tests', testClass]))
    for (let index = 0; index < options.runs; index += 1) {
      const modes = index % 2 ? ['prewarmed', 'reuse', 'baseline'] : ['baseline', 'reuse', 'prewarmed']
      for (const mode of modes) {
        records.push(await runGradle(context, mode, `repeat-${index + 1}`, 'leetcoderProblemTest', ['--tests', testClass]))
      }
    }
    for (const mode of ['baseline', 'reuse', 'prewarmed']) {
      await writeFile(path.join(context.projects[mode], 'src/main/java/shane/leetcode/problems/easy/BenchmarkProblem.java'), problemSource(2))
      records.push(await runGradle(context, mode, 'edited', 'leetcoderProblemTest', ['--tests', testClass]))
      const repeated = records.filter((record) => record.mode === mode && record.label.startsWith('repeat-'))
      assert(repeated.every((record) => record.tasks.some((task) => task.includes('leetcoderProblemCompile UP-TO-DATE'))), 'Unchanged source must reuse compiled classes')
      const edited = records.at(-1)
      assert(edited.tasks.some((task) => /leetcoderProblemCompile$/.test(task)), 'Edited source must compile again')
      if (mode !== 'baseline') {
        const daemonIds = records.filter((record) => record.mode === mode).map((record) => record.daemon)
        assert.equal(new Set(daemonIds).size, 1, `${mode} must reuse one daemon throughout`)
      } else {
        const daemonIds = records.filter((record) => record.mode === mode).map((record) => record.daemon)
        assert.equal(new Set(daemonIds).size, daemonIds.length, 'Baseline must start a new single-use daemon for every run')
      }
    }
    const summary = buildSummary(records)
    const report = { generatedAt: new Date().toISOString(), options: { ...options, gradle, javaHome },
      cpuCount: availableParallelism(), scripts: { runnerSha256: createHash('sha256').update(runnerScript).digest('hex'),
        warmupSha256: createHash('sha256').update(warmupScript).digest('hex') }, jars, summary, records,
      timingDefinitions: {
        totalMs: 'Monotonic time from spawning the Gradle client to captured process completion.',
        firstTestMs: 'Monotonic time until the first production test-start marker reaches the client, including Gradle output buffering.',
        stages: 'Durations from callback timestamps inside the local Gradle JVM. Launch/settings also includes client startup. All stage deltas use one run on one host.',
        testExecutionWindowMs: 'First beforeTest callback through the final afterTest callback, including framework gaps between cases.',
        afterTestsMs: 'Final afterTest callback through captured Gradle client completion, including reporting, worker teardown and output delivery.',
        progressDeliveryLagMs: 'First production test-start marker delivery minus first beforeTest probe timestamp, clamped to zero for timestamp resolution and listener ordering.',
      },
      scope: 'Offline Java/JUnit fixture using production init scripts. Excludes app IPC, save, JDK discovery, Kotlin plugins and the user repository. First runs have fresh Gradle caches, but OS file caches are shared. Prewarm duration is startup work, not eliminated work. Timing ratios are observations, not pass/fail thresholds.' }
    await writeFile(path.join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.table(['baseline', 'reuse', 'prewarmed'].map((mode) => ({
      mode, firstMs: Math.round(summary[mode].firstMs), warmupMs: Math.round(summary[mode].warmupMs),
      repeatMedianMs: Math.round(summary[mode].repetitions.medianMs),
      repeatMinMs: Math.round(summary[mode].repetitions.minMs),
      repeatMaxMs: Math.round(summary[mode].repetitions.maxMs), editedMs: Math.round(summary[mode].editedMs),
    })))
    console.log(`Repeated daemon reuse: ${summary.reuseVsBaseline.speedup.toFixed(2)}x speedup, ${summary.reuseVsBaseline.reductionPercent.toFixed(1)}% reduction.`)
    console.log(`Prewarmed first test: ${summary.prewarmedFirstVsBaseline.speedup.toFixed(2)}x speedup, ${summary.prewarmedFirstVsBaseline.reductionPercent.toFixed(1)}% reduction. Startup warmup cost is shown separately.`)
    console.table(Object.entries(summary.reuse.stages).map(([stage, timing]) => ({ stage, medianMs: Math.round(timing.medianMs) }))
      .sort((left, right) => right.medianMs - left.medianMs))
    console.log('Use stage timings to distinguish project setup, compilation/test startup, test bodies and post-test shutdown. Repeat on an idle machine before drawing conclusions from small differences.')
  } finally {
    // Each registry is private to this fixture, so cleanup cannot stop an interactive daemon.
    for (const mode of ['reuse', 'prewarmed']) {
      if (!context.homes[mode]) continue
      await new Promise((resolve) => {
        const child = spawn(gradle, ['--gradle-user-home', context.homes[mode], '--stop'], {
          env: { ...process.env, JAVA_HOME: javaHome }, stdio: 'ignore',
        })
        child.on('error', resolve)
        child.on('close', resolve)
      })
    }
    await rm(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}

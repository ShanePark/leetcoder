#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const bundleRoot = path.join(repositoryRoot, 'src-tauri', 'target', 'release', 'bundle')
const logPath = path.join(tmpdir(), 'leetcoder-rebuild.log')
const UPDATE_STAGE_PREFIX = 'LEETCODER_UPDATE_STAGE:'
const UPDATE_OLD_PID_ENV = 'LEETCODER_UPDATE_OLD_PID'
const EXPECTED_COMMIT_ENV = 'LEETCODER_EXPECTED_COMMIT'
const PROCESS_STOP_TIMEOUT_MS = 10_000
const PROCESS_STOP_POLL_MS = 50

/** Parse the updater PID without ever falling back to a broad process match. */
export function parseUpdateOldPid(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`${UPDATE_OLD_PID_ENV} must be a positive process ID.`)
  }
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${UPDATE_OLD_PID_ENV} must be a positive process ID.`)
  }
  return pid
}

/** Describe the process-stop behavior so it can be tested without side effects. */
export function stopRunningAppStrategy(oldPidValue) {
  const pid = parseUpdateOldPid(oldPidValue)
  return pid === null
    ? { kind: 'all', args: ['-x', 'leetcoder'] }
    : { kind: 'pid', pid }
}

/** lstat-backed artifact validation must reject symlinks, even when they resolve to files. */
export function isRegularNonSymlink(fileStats) {
  return Boolean(fileStats) && fileStats.isFile() && !fileStats.isSymbolicLink()
}

export function appImageCandidateNames(entries) {
  return entries
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.AppImage'))
    .sort((left, right) => left.localeCompare(right))
}

/** A rebuild must not guess between stale and freshly-created AppImages. */
export function selectUniqueAppImageName(entries) {
  const candidates = appImageCandidateNames(entries)
  if (candidates.length === 0) throw new Error('No AppImage was produced in the bundle directory.')
  if (candidates.length > 1) {
    throw new Error(`Expected exactly one AppImage, found: ${candidates.join(', ')}`)
  }
  return candidates[0]
}

export function isLeetcoderOwnedLegacyLauncher(contents) {
  return typeof contents === 'string' && contents.includes('# Launch the installed leetcoder build')
}

export function isLeetcoderOwnedLegacyDesktopEntry(contents) {
  return typeof contents === 'string'
    && /^\[Desktop Entry\]\s*$/m.test(contents)
    && /^Name=leetcoder Dev\s*$/m.test(contents)
}

const REBUILD_MODES = {
  '--stage-only': 'stage',
  '--apply-staged': 'apply',
}

/** No argument keeps the original build, install, and relaunch flow. */
export function parseRebuildMode(args) {
  if (args.length === 0) return 'full'
  if (args.length === 1 && Object.hasOwn(REBUILD_MODES, args[0])) return REBUILD_MODES[args[0]]
  throw new Error(`Unsupported rebuild arguments: ${args.join(' ')}. Use --stage-only or --apply-staged.`)
}

/**
 * The staged build sits next to the installed app so the final rename stays on
 * one filesystem; the leading dot keeps it out of launchers and file browsers.
 */
export function stagedUpdatePaths(installedApp) {
  const stagedApp = path.join(path.dirname(installedApp), `.${path.basename(installedApp)}.staged`)
  return { stagedApp, stagedManifest: `${stagedApp}.json` }
}

/** The file whose hash identifies an app: the AppImage itself, or the macOS executable. */
export function appBinaryPath(platform, appPath) {
  return platform === 'darwin' ? path.join(appPath, 'Contents', 'MacOS', 'leetcoder') : appPath
}

export function requireExpectedCommit(value) {
  const commit = typeof value === 'string' ? value.trim() : ''
  if (!commit) throw new Error(`${EXPECTED_COMMIT_ENV} is required to apply a staged update.`)
  return commit
}

/** Reject a staged build unless it is exactly the build the caller decided to install. */
export function validateStagedManifest(manifest, { expectedCommit, platform, sha256: actualSha256 }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The staged update manifest is malformed.')
  }
  if (manifest.platform !== platform) {
    throw new Error(`The staged update was built for ${String(manifest.platform)}, not ${platform}.`)
  }
  if (typeof manifest.commit !== 'string' || manifest.commit !== expectedCommit) {
    throw new Error('The staged update was built from a different commit. Build the update again.')
  }
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error('The staged update manifest has an invalid checksum.')
  }
  if (manifest.sha256 !== actualSha256) {
    throw new Error('The staged update does not match its manifest. Build the update again.')
  }
  return manifest
}

export function rebuildPlan(platform, userHome = homedir()) {
  if (platform === 'darwin') {
    const installedApp = '/Applications/leetcoder.app'
    return {
      bundleKind: 'app',
      artifact: path.join(bundleRoot, 'macos', 'leetcoder.app'),
      installedApp,
      ...stagedUpdatePaths(installedApp),
    }
  }
  if (platform === 'linux') {
    const applicationDirectory = path.join(userHome, '.local', 'lib', 'leetcoder')
    const installedApp = path.join(applicationDirectory, 'leetcoder.AppImage')
    return {
      bundleKind: 'appimage',
      artifactDirectory: path.join(bundleRoot, 'appimage'),
      installedApp,
      ...stagedUpdatePaths(installedApp),
      desktopEntry: path.join(userHome, '.local', 'share', 'applications', 'leetcoder.desktop'),
      installedIcon: path.join(userHome, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'leetcoder.png'),
      // Older launcher favorites use these paths. Keep them pointed at the
      // current AppImage so an update cannot be followed by a stale binary.
      legacyLauncher: path.join(userHome, '.local', 'bin', 'leetcoder'),
      legacyDesktopEntry: path.join(userHome, '.local', 'share', 'applications', 'dev.shanepark.leetcoder.desktop'),
    }
  }
  throw new Error(`Unsupported operating system: ${platform}. leetcoder rebuild supports macOS and Linux.`)
}

async function pathExists(target) {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function commandOutput(command, args, { cwd = repositoryRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(`${command} exited with status ${code}: ${stderr.trim()}`))
      }
    })
  })
}

async function verifyExpectedCommit() {
  const expected = process.env[EXPECTED_COMMIT_ENV]?.trim()
  if (!expected) return
  const actual = await commandOutput('git', ['rev-parse', '--verify', 'HEAD'])
  if (actual !== expected) {
    throw new Error('The source HEAD changed while building. Retry the update.')
  }
  const status = await commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) {
    throw new Error('The source worktree changed while building. Commit or remove the changes before updating.')
  }
}

// The updating app reads these pipes and is stopped mid-install, so later
// writes must not crash the script before the new build is in place. A stage
// build keeps the default instead: if the app dies without cancelling it, the
// first write to the closed pipe ends the orphaned build.
function ignoreBrokenPipe(stream) {
  stream.on('error', (error) => {
    if (error?.code !== 'EPIPE') throw error
  })
}

function emitUpdateStage(stage) {
  process.stdout.write(`${UPDATE_STAGE_PREFIX}${stage}\n`)
}

async function appendLog(message) {
  await writeFile(logPath, `${message}\n`, { flag: 'a' })
}

async function runCommand(command, args, { allowExitCodes = [0], cwd = repositoryRoot } = {}) {
  await appendLog(`$ ${command} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const logStream = createWriteStream(logPath, { flags: 'a' })
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      logStream.write(chunk)
    })
    child.on('error', (error) => {
      logStream.end()
      reject(error)
    })
    child.on('close', (code) => {
      logStream.end()
      if (allowExitCodes.includes(code ?? -1)) resolve(code)
      else reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

async function sha256(target) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(target)) hash.update(chunk)
  return hash.digest('hex')
}

async function atomicReplace(staged, installed) {
  const backup = `${installed}.backup-${process.pid}`
  // A stale backup belongs to an interrupted rebuild. The current process ID
  // makes this path private to this invocation, so removing only this exact
  // path cannot discard a backup created by another running rebuild.
  await rm(backup, { recursive: true, force: true })
  const hadInstalledApp = await pathExists(installed)
  if (hadInstalledApp) await rename(installed, backup)
  try {
    await rename(staged, installed)
  } catch (error) {
    if (hadInstalledApp && await pathExists(backup)) await rename(backup, installed)
    throw error
  }

  let state = 'active'
  return {
    backup,
    hadInstalledApp,
    async commit() {
      if (state !== 'active') return
      await rm(backup, { recursive: true, force: true })
      state = 'committed'
    },
    async rollback() {
      if (state !== 'active') return
      if (hadInstalledApp && !(await pathExists(backup))) {
        throw new Error(`Cannot roll back ${installed}: its backup is missing.`)
      }
      await rm(installed, { recursive: true, force: true })
      if (hadInstalledApp) await rename(backup, installed)
      state = 'rolled-back'
    },
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS
  while (true) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return
      if (error?.code !== 'EPERM') throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for process ${pid} to exit.`)
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_POLL_MS))
  }
}

async function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'ESRCH') return
    throw error
  }
  await waitForProcessExit(pid)
}

async function stopRunningApp() {
  const strategy = stopRunningAppStrategy(process.env[UPDATE_OLD_PID_ENV])
  if (strategy.kind === 'pid') {
    await appendLog(`Stopping update source process ${strategy.pid}`)
    await stopProcess(strategy.pid)
    return
  }
  await runCommand('pkill', strategy.args, { allowExitCodes: [0, 1] })
}

async function assertRegularArtifact(target, description) {
  const fileStats = await lstat(target)
  if (!isRegularNonSymlink(fileStats)) {
    throw new Error(`${description} must be a regular, non-symlink file: ${target}`)
  }
}

async function assertBundleDirectory(target, description) {
  const directoryStats = await lstat(target)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`${description} must be a non-symlink directory: ${target}`)
  }
}

async function relaunchMac(installedApp) {
  await runCommand('/usr/bin/open', [installedApp])
}

async function relaunchLinux(installedApp) {
  await new Promise((resolve, reject) => {
    const child = spawn(installedApp, [], {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    })
    const onError = (error) => reject(error)
    child.once('error', onError)
    child.once('spawn', () => {
      child.removeListener('error', onError)
      child.unref()
      resolve()
    })
  })
  await appendLog(`Launched ${installedApp}`)
}

async function rollbackAndRelaunch(transaction, relaunch) {
  await transaction.rollback()
  if (transaction.hadInstalledApp) await relaunch()
}

async function assertMacBundle(appPath, description) {
  await assertBundleDirectory(appPath, `${description} application bundle`)
  await assertBundleDirectory(path.join(appPath, 'Contents'), `${description} Contents directory`)
  await assertBundleDirectory(path.join(appPath, 'Contents', 'MacOS'), `${description} executable directory`)
  await assertRegularArtifact(appBinaryPath('darwin', appPath), `${description} executable`)
}

/** Copy the built bundle to `destination` and return the built executable's hash. */
async function stageMacArtifact(plan, destination) {
  await assertMacBundle(plan.artifact, 'The built macOS')
  await rm(destination, { recursive: true, force: true })
  await cp(plan.artifact, destination, { recursive: true, preserveTimestamps: true })
  return sha256(appBinaryPath('darwin', plan.artifact))
}

/** Stop the running app, swap `staged` into place, and relaunch, rolling back on failure. */
async function activateMac(plan, staged, expectedSha256) {
  await stopRunningApp()
  const transaction = await atomicReplace(staged, plan.installedApp)
  try {
    const installedBinary = appBinaryPath('darwin', plan.installedApp)
    await assertBundleDirectory(plan.installedApp, 'The installed macOS application bundle')
    await assertRegularArtifact(installedBinary, 'The installed macOS executable')
    if (expectedSha256 !== await sha256(installedBinary)) {
      throw new Error('Installed macOS application does not match the freshly built bundle.')
    }
    await relaunchMac(plan.installedApp)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await runCommand('pgrep', ['-x', 'leetcoder'])
    await transaction.commit()
  } catch (error) {
    try {
      await rollbackAndRelaunch(transaction, () => relaunchMac(plan.installedApp))
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

async function installMac(plan) {
  const staged = `${plan.installedApp}.installing-${process.pid}`
  const artifactSha256 = await stageMacArtifact(plan, staged)
  await activateMac(plan, staged, artifactSha256)
}

async function newestAppImage(directory) {
  await assertBundleDirectory(directory, 'The AppImage bundle directory')
  const selectedName = selectUniqueAppImageName(await readdir(directory))
  const candidate = path.join(directory, selectedName)
  await assertRegularArtifact(candidate, 'The selected AppImage')
  return candidate
}

function desktopEntry(executable, icon) {
  const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `[Desktop Entry]\nType=Application\nName=leetcoder\nExec="${escape(executable)}"\nIcon=${icon}\nTerminal=false\nCategories=Development;IDE;\n`
}

async function replaceStagedFile(staged, target) {
  const transaction = await atomicReplace(staged, target)
  try {
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}

async function installDesktopEntry(target, executable, icon, { legacy = false } = {}) {
  if (legacy) {
    let currentContents
    try {
      const currentStats = await lstat(target)
      // Do not follow or replace a symlink that may belong to another app.
      if (currentStats.isSymbolicLink() || !currentStats.isFile()) return false
      currentContents = await readFile(target, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (currentContents !== undefined && !isLeetcoderOwnedLegacyDesktopEntry(currentContents)) return false
  }

  await mkdir(path.dirname(target), { recursive: true })
  const staged = `${target}.installing-${process.pid}`
  await rm(staged, { recursive: true, force: true })
  await writeFile(staged, desktopEntry(executable, icon))
  await replaceStagedFile(staged, target)
  return true
}

async function installLinuxLegacyLauncher(plan) {
  let shouldReplace = true
  try {
    const currentStats = await lstat(plan.legacyLauncher)
    if (currentStats.isSymbolicLink()) {
      const linkTarget = await readlink(plan.legacyLauncher)
      shouldReplace = path.resolve(path.dirname(plan.legacyLauncher), linkTarget) === path.resolve(plan.installedApp)
    } else if (currentStats.isFile()) {
      shouldReplace = isLeetcoderOwnedLegacyLauncher(await readFile(plan.legacyLauncher, 'utf8'))
    } else {
      shouldReplace = false
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!shouldReplace) return false

  await mkdir(path.dirname(plan.legacyLauncher), { recursive: true })
  const staged = `${plan.legacyLauncher}.installing-${process.pid}`
  await rm(staged, { recursive: true, force: true })
  await symlink(plan.installedApp, staged)
  await replaceStagedFile(staged, plan.legacyLauncher)
  return true
}

/** Copy the built AppImage to `destination` and return the built AppImage's hash. */
async function stageLinuxArtifact(plan, destination) {
  const artifact = await newestAppImage(plan.artifactDirectory)
  await mkdir(path.dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await cp(artifact, destination)
  await chmod(destination, 0o755)
  return sha256(artifact)
}

/** Stop the running app, swap `staged` into place, and relaunch, rolling back on failure. */
async function activateLinux(plan, staged, expectedSha256) {
  await stopRunningApp()
  const transaction = await atomicReplace(staged, plan.installedApp)
  try {
    await assertRegularArtifact(plan.installedApp, 'The installed AppImage')
    if (expectedSha256 !== await sha256(plan.installedApp)) {
      throw new Error('Installed AppImage does not match the freshly built bundle.')
    }

    await mkdir(path.dirname(plan.installedIcon), { recursive: true })
    await cp(path.join(repositoryRoot, 'src-tauri', 'icons', '128x128.png'), plan.installedIcon)
    await installLinuxLegacyLauncher(plan)
    await installDesktopEntry(plan.desktopEntry, plan.installedApp, plan.installedIcon)
    await installDesktopEntry(plan.legacyDesktopEntry, plan.legacyLauncher, plan.installedIcon, { legacy: true })

    await relaunchLinux(plan.installedApp)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await runCommand('pgrep', ['-f', plan.installedApp])
    await transaction.commit()
  } catch (error) {
    try {
      await rollbackAndRelaunch(transaction, () => relaunchLinux(plan.installedApp))
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

async function installLinux(plan) {
  const staged = `${plan.installedApp}.installing-${process.pid}`
  const artifactSha256 = await stageLinuxArtifact(plan, staged)
  await activateLinux(plan, staged, artifactSha256)
}

async function buildRelease(plan) {
  await verifyExpectedCommit()
  emitUpdateStage('building')
  await runCommand('npm', ['run', 'tauri', '--', 'build', '--bundles', plan.bundleKind])
  await verifyExpectedCommit()
}

async function clearStagedUpdate(plan) {
  // Remove the manifest first so a half-removed stage can never validate.
  await rm(plan.stagedManifest, { force: true })
  await rm(plan.stagedApp, { recursive: true, force: true })
}

export async function rebuildAndInstall(platform = process.platform) {
  const plan = rebuildPlan(platform)
  await writeFile(logPath, `leetcoder rebuild started on ${platform}\n`)
  await buildRelease(plan)
  emitUpdateStage('preparing')
  if (platform === 'darwin') await installMac(plan)
  else await installLinux(plan)
  emitUpdateStage('restarting')
  // A staged build is older than what was just installed. Failing to remove it
  // must not report the successful install as failed.
  try {
    await clearStagedUpdate(plan)
  } catch (error) {
    await appendLog(`Could not remove the stale staged update: ${error instanceof Error ? error.message : String(error)}`)
  }
  await appendLog('Build, install, and relaunch completed successfully.')
  return { logPath, plan }
}

/** Build and stage a release for a later --apply-staged run without touching the running app. */
export async function stageRebuild(platform = process.platform) {
  const plan = rebuildPlan(platform)
  await writeFile(logPath, `leetcoder staged rebuild started on ${platform}\n`)
  const commit = process.env[EXPECTED_COMMIT_ENV]?.trim()
    || await commandOutput('git', ['rev-parse', '--verify', 'HEAD'])
  await buildRelease(plan)
  emitUpdateStage('staging')

  const temporary = `${plan.stagedApp}.installing-${process.pid}`
  const artifactSha256 = platform === 'darwin'
    ? await stageMacArtifact(plan, temporary)
    : await stageLinuxArtifact(plan, temporary)
  if (await sha256(appBinaryPath(platform, temporary)) !== artifactSha256) {
    await rm(temporary, { recursive: true, force: true })
    throw new Error('The staged update does not match the freshly built bundle.')
  }
  // The manifest is written last, so it only ever describes a complete stage.
  await clearStagedUpdate(plan)
  await rename(temporary, plan.stagedApp)
  const manifestTemporary = `${plan.stagedManifest}.installing-${process.pid}`
  await writeFile(manifestTemporary, `${JSON.stringify({ commit, sha256: artifactSha256, platform })}\n`)
  await rename(manifestTemporary, plan.stagedManifest)
  await appendLog(`Staged ${commit} at ${plan.stagedApp}`)
  return { logPath, plan, commit }
}

async function readStagedManifest(plan) {
  let text
  try {
    text = await readFile(plan.stagedManifest, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('No staged update build was found. Build the update again.')
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The staged update manifest is malformed.')
  }
}

/** Install the staged build. The source tree may have moved on since it was built, so git is not consulted. */
export async function applyStagedRebuild(platform = process.platform) {
  const plan = rebuildPlan(platform)
  await writeFile(logPath, `leetcoder staged install started on ${platform}\n`)
  const expectedCommit = requireExpectedCommit(process.env[EXPECTED_COMMIT_ENV])
  const manifest = await readStagedManifest(plan)
  try {
    if (platform === 'darwin') await assertMacBundle(plan.stagedApp, 'The staged macOS')
    else await assertRegularArtifact(plan.stagedApp, 'The staged AppImage')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The staged update build is missing. Build the update again.')
    throw error
  }
  const stagedSha256 = await sha256(appBinaryPath(platform, plan.stagedApp))
  validateStagedManifest(manifest, { expectedCommit, platform, sha256: stagedSha256 })

  emitUpdateStage('preparing')
  if (platform === 'darwin') await activateMac(plan, plan.stagedApp, stagedSha256)
  else await activateLinux(plan, plan.stagedApp, stagedSha256)
  // The new app is already running; a leftover manifest only fails the next
  // apply's checksum check, so it must not report this install as failed.
  try {
    await rm(plan.stagedManifest, { force: true })
  } catch (error) {
    await appendLog(`Could not remove the staged update manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  emitUpdateStage('restarting')
  await appendLog(`Installed staged ${expectedCommit} and relaunched successfully.`)
  return { logPath, plan }
}

const MODE_RUNNERS = {
  full: { run: rebuildAndInstall, done: 'leetcoder was rebuilt, installed, and relaunched.' },
  stage: { run: stageRebuild, done: 'leetcoder update was built and staged.' },
  apply: { run: applyStagedRebuild, done: 'leetcoder staged update was installed and relaunched.' },
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  Promise.resolve().then(() => {
    const mode = parseRebuildMode(process.argv.slice(2))
    if (mode !== 'stage') {
      ignoreBrokenPipe(process.stdout)
      ignoreBrokenPipe(process.stderr)
    }
    const runner = MODE_RUNNERS[mode]
    return runner.run().then((result) => ({ ...result, done: runner.done }))
  }).then(({ logPath: completedLog, done }) => {
    console.log(`${done} Log: ${completedLog}`)
  }).catch(async (error) => {
    await appendLog(error instanceof Error ? error.stack ?? error.message : String(error))
    console.error(`leetcoder rebuild failed. Log: ${logPath}`)
    console.error(error)
    process.exitCode = 1
  })
}

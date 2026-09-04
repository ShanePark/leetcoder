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

export function rebuildPlan(platform, userHome = homedir()) {
  if (platform === 'darwin') {
    return {
      bundleKind: 'app',
      artifact: path.join(bundleRoot, 'macos', 'leetcoder.app'),
      installedApp: '/Applications/leetcoder.app',
    }
  }
  if (platform === 'linux') {
    const applicationDirectory = path.join(userHome, '.local', 'lib', 'leetcoder')
    return {
      bundleKind: 'appimage',
      artifactDirectory: path.join(bundleRoot, 'appimage'),
      installedApp: path.join(applicationDirectory, 'leetcoder.AppImage'),
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
  const expected = process.env.LEETCODER_EXPECTED_COMMIT?.trim()
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

async function installMac(plan) {
  const artifactBinary = path.join(plan.artifact, 'Contents', 'MacOS', 'leetcoder')
  await assertBundleDirectory(plan.artifact, 'The built macOS application bundle')
  await assertBundleDirectory(path.join(plan.artifact, 'Contents'), 'The built macOS Contents directory')
  await assertBundleDirectory(path.join(plan.artifact, 'Contents', 'MacOS'), 'The built macOS executable directory')
  await assertRegularArtifact(artifactBinary, 'The built macOS executable')
  const staged = `${plan.installedApp}.installing-${process.pid}`
  await rm(staged, { recursive: true, force: true })
  await cp(plan.artifact, staged, { recursive: true, preserveTimestamps: true })

  await stopRunningApp()
  const transaction = await atomicReplace(staged, plan.installedApp)
  try {
    const installedBinary = path.join(plan.installedApp, 'Contents', 'MacOS', 'leetcoder')
    await assertBundleDirectory(plan.installedApp, 'The installed macOS application bundle')
    await assertRegularArtifact(installedBinary, 'The installed macOS executable')
    if (await sha256(artifactBinary) !== await sha256(installedBinary)) {
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

async function installLinux(plan) {
  const artifact = await newestAppImage(plan.artifactDirectory)
  await mkdir(path.dirname(plan.installedApp), { recursive: true })
  const staged = `${plan.installedApp}.installing-${process.pid}`
  await rm(staged, { recursive: true, force: true })
  await cp(artifact, staged)
  await chmod(staged, 0o755)

  await stopRunningApp()
  const transaction = await atomicReplace(staged, plan.installedApp)
  try {
    await assertRegularArtifact(plan.installedApp, 'The installed AppImage')
    if (await sha256(artifact) !== await sha256(plan.installedApp)) {
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

export async function rebuildAndInstall(platform = process.platform) {
  const plan = rebuildPlan(platform)
  await writeFile(logPath, `leetcoder rebuild started on ${platform}\n`)
  await verifyExpectedCommit()
  emitUpdateStage('building')
  await runCommand('npm', ['run', 'tauri', '--', 'build', '--bundles', plan.bundleKind])
  await verifyExpectedCommit()
  emitUpdateStage('preparing')
  if (platform === 'darwin') await installMac(plan)
  else await installLinux(plan)
  emitUpdateStage('restarting')
  await appendLog('Build, install, and relaunch completed successfully.')
  return { logPath, plan }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  rebuildAndInstall().then(({ logPath: completedLog }) => {
    console.log(`leetcoder was rebuilt, installed, and relaunched. Log: ${completedLog}`)
  }).catch(async (error) => {
    await appendLog(error instanceof Error ? error.stack ?? error.message : String(error))
    console.error(`leetcoder rebuild failed. Log: ${logPath}`)
    console.error(error)
    process.exitCode = 1
  })
}

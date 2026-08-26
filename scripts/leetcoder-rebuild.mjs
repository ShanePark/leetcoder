#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')
const bundleRoot = path.join(repositoryRoot, 'src-tauri', 'target', 'release', 'bundle')
const logPath = path.join(tmpdir(), 'leetcoder-rebuild.log')

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
    }
  }
  throw new Error(`Unsupported operating system: ${platform}. leetcoder rebuild supports macOS and Linux.`)
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
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
  await rm(backup, { recursive: true, force: true })
  const hadInstalledApp = await pathExists(installed)
  if (hadInstalledApp) await rename(installed, backup)
  try {
    await rename(staged, installed)
  } catch (error) {
    if (hadInstalledApp && await pathExists(backup)) await rename(backup, installed)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

async function stopRunningApp() {
  await runCommand('pkill', ['-x', 'leetcoder'], { allowExitCodes: [0, 1] })
}

async function installMac(plan) {
  const artifactBinary = path.join(plan.artifact, 'Contents', 'MacOS', 'leetcoder')
  await access(artifactBinary)
  const staged = `${plan.installedApp}.installing-${process.pid}`
  await rm(staged, { recursive: true, force: true })
  await cp(plan.artifact, staged, { recursive: true, preserveTimestamps: true })

  await stopRunningApp()
  await atomicReplace(staged, plan.installedApp)

  const installedBinary = path.join(plan.installedApp, 'Contents', 'MacOS', 'leetcoder')
  if (await sha256(artifactBinary) !== await sha256(installedBinary)) {
    throw new Error('Installed macOS application does not match the freshly built bundle.')
  }
  await runCommand('/usr/bin/open', [plan.installedApp])
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  await runCommand('pgrep', ['-x', 'leetcoder'])
}

async function newestAppImage(directory) {
  const candidates = (await readdir(directory))
    .filter((name) => name.endsWith('.AppImage'))
    .map((name) => path.join(directory, name))
  if (candidates.length === 0) throw new Error(`No AppImage was produced in ${directory}`)
  const withTimes = await Promise.all(candidates.map(async (candidate) => ({ candidate, modified: (await stat(candidate)).mtimeMs })))
  return withTimes.sort((left, right) => right.modified - left.modified)[0].candidate
}

function desktopEntry(executable, icon) {
  const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `[Desktop Entry]\nType=Application\nName=leetcoder\nExec="${escape(executable)}"\nIcon=${icon}\nTerminal=false\nCategories=Development;IDE;\n`
}

async function installLinux(plan) {
  const artifact = await newestAppImage(plan.artifactDirectory)
  await mkdir(path.dirname(plan.installedApp), { recursive: true })
  const staged = `${plan.installedApp}.installing-${process.pid}`
  await rm(staged, { force: true })
  await cp(artifact, staged)
  await chmod(staged, 0o755)

  await stopRunningApp()
  await atomicReplace(staged, plan.installedApp)
  if (await sha256(artifact) !== await sha256(plan.installedApp)) {
    throw new Error('Installed AppImage does not match the freshly built bundle.')
  }

  await mkdir(path.dirname(plan.installedIcon), { recursive: true })
  await cp(path.join(repositoryRoot, 'src-tauri', 'icons', '128x128.png'), plan.installedIcon)
  await mkdir(path.dirname(plan.desktopEntry), { recursive: true })
  const stagedDesktopEntry = `${plan.desktopEntry}.installing-${process.pid}`
  await writeFile(stagedDesktopEntry, desktopEntry(plan.installedApp, plan.installedIcon))
  await rename(stagedDesktopEntry, plan.desktopEntry)

  const child = spawn(plan.installedApp, [], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  })
  child.unref()
  await appendLog(`Launched ${plan.installedApp}`)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  await runCommand('pgrep', ['-f', plan.installedApp])
}

export async function rebuildAndInstall(platform = process.platform) {
  const plan = rebuildPlan(platform)
  await writeFile(logPath, `leetcoder rebuild started on ${platform}\n`)
  await runCommand('npm', ['run', 'tauri', '--', 'build', '--bundles', plan.bundleKind])
  if (platform === 'darwin') await installMac(plan)
  else await installLinux(plan)
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

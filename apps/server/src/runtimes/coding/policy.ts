import type { CodingPermission, CodingRuntime } from '@score/contract'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { driverFor } from './drivers.ts'
import type { CodingDriver } from './types.ts'

// The worker policy (7.7b §3): everything that decides what an orchestration step's CLI can do, frozen when the person
// starts the run and checked again right before each launch. Three rules:
//  - Configuration and credential files are NEVER read. Configuration the CLI may still read is bound by file identity
//    only (stat: dev, ino, size, mtime, or "absent"). Credential files are not even listed.
//  - Environment VALUES are never stored: only the names and a hash of the values.
//  - The invocation is built from the policy's own inputs, never from the live agent row.

export type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number } | 'absent'

export interface WorkerPolicy {
  v: 1
  runtime: CodingRuntime
  permission: CodingPermission
  model: string | null
  /** The files that make up the CLI as it is started (the native executable; a fake CLI adds its script). */
  cli: { files: [string, FileIdentity][]; version: string }
  workspace: { real: string; dev: number; ino: number }
  /** The full argument vector minus the prompt, hashed. */
  argvSha256: string
  /** The allow-listed environment: names, and a hash of the values (the values live only in the supervisor's spec). */
  envNames: string[]
  envSha256: string
  /** The settings file Score writes for the CLI (Claude Code's `--settings`): where, and the hash of its bytes. */
  settings: { path: string; sha256: string } | null
  /** The flags added so the CLI doesn't read what it would by default. */
  neutralised: string[]
  /** Configuration the CLI may still read, by file identity. */
  sources: [string, FileIdentity][]
}

/** Why a policy can't be computed: the reach of this CLI can't be verified. */
export class PolicyUnverifiable extends Error {}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

export const policyIdOf = (policy: WorkerPolicy): string => sha256(canonicalJson(policy))

/** A file's identity by stat alone. A path that isn't there is `absent`; any other failure is unverifiable. */
export function fileIdentity(path: string): FileIdentity {
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat) return 'absent'
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    throw new PolicyUnverifiable(`Score can’t check ${path} (${code ?? 'unreadable'}).`)
  }
}

export function envHash(env: Readonly<Record<string, string>>): {
  names: string[]
  sha256: string
} {
  const names = Object.keys(env).sort()
  return { names, sha256: sha256(canonicalJson(names.map((name) => [name, env[name]]))) }
}

/** What computing the policy needs to know about the world around the agent. */
export interface PolicyContext {
  /** The user's home folder (the CLIs' own configuration folders hang off it). */
  home: string
  /** The environment the CLI would be started with (the allow-listed child environment). */
  env: Readonly<Record<string, string>>
  /** Where Score writes the CLI's settings file, e.g. `<score home>/coding/<agent>`. */
  settingsDir: string
  denyPaths: readonly string[]
  denyFiles: readonly string[]
  /** The file that is started and its leading arguments (a fake CLI is `node script runtime`). */
  command: { file: string; args: readonly string[] }
  /** Read the settings file's bytes from disk (the launch path) instead of trusting the intended bytes. */
  settingsOnDisk: boolean
}

export interface PolicyInputs {
  runtime: CodingRuntime
  permission: CodingPermission
  model: string | null
  /** The workspace's real path. */
  workspace: string
  version: string
}

export function workerDriver(runtime: CodingRuntime): CodingDriver & {
  worker: NonNullable<CodingDriver['worker']>
} {
  const driver = driverFor(runtime)
  if (!driver.worker)
    throw new PolicyUnverifiable(`${driver.label} can’t take orchestration steps.`)
  return driver as CodingDriver & { worker: NonNullable<CodingDriver['worker']> }
}

/**
 * The policy for these inputs, with every identity read now. Used both to compute the policy the person approves (inputs
 * from the agent row) and to check it again before a launch (inputs from the stored policy): the same code, so a check can
 * never be looser than the computation.
 */
export function buildPolicy(inputs: PolicyInputs, context: PolicyContext): WorkerPolicy {
  const driver = workerDriver(inputs.runtime)
  const { worker } = driver
  if (!worker.versions.includes(inputs.version))
    throw new PolicyUnverifiable(
      `Score hasn’t verified what ${driver.label} ${inputs.version} reads on its own, so it can’t say what a step could reach.`,
    )
  let real: string
  let workspaceStat: ReturnType<typeof statSync>
  try {
    real = realpathSync(inputs.workspace)
    workspaceStat = statSync(real)
  } catch {
    throw new PolicyUnverifiable(`The workspace ${inputs.workspace} isn’t available.`)
  }
  const env = envHash(context.env)
  const settingsFile = driver.settingsFile?.(context.denyPaths, context.denyFiles)
  let settings: WorkerPolicy['settings'] = null
  if (settingsFile) {
    const path = `${context.settingsDir}/${settingsFile.name}`
    let bytes: Buffer | string = settingsFile.content
    if (context.settingsOnDisk) {
      try {
        bytes = readFileSync(path)
      } catch {
        throw new PolicyUnverifiable('The settings file Score writes for the CLI isn’t there.')
      }
    }
    settings = { path, sha256: sha256(bytes) }
  }
  const argv = [
    ...context.command.args,
    ...driver.buildArgs({
      workspace: real,
      prompt: '',
      permission: inputs.permission,
      model: inputs.model,
      sessionId: null,
      settingsPath: settings?.path ?? null,
      denyPaths: context.denyPaths,
      denyFiles: context.denyFiles,
      worker: true,
    }),
  ]
  const files: [string, FileIdentity][] = [
    [context.command.file, fileIdentity(context.command.file)],
  ]
  // A fake CLI is `node script runtime`: the script is what runs, so it is part of the CLI's identity too.
  const script = context.command.args[0]
  if (script !== undefined && script.startsWith('/')) files.push([script, fileIdentity(script)])
  for (const [path, id] of files)
    if (id === 'absent') throw new PolicyUnverifiable(`${path} isn’t there.`)
  const sources = [
    ...new Set(worker.bound({ home: context.home, workspace: real, env: context.env })),
  ]
    .sort()
    .map((path): [string, FileIdentity] => [path, fileIdentity(path)])
  return {
    v: 1,
    runtime: inputs.runtime,
    permission: inputs.permission,
    model: inputs.model,
    cli: { files, version: inputs.version },
    workspace: { real, dev: workspaceStat.dev, ino: workspaceStat.ino },
    argvSha256: sha256(canonicalJson(argv)),
    envNames: env.names,
    envSha256: env.sha256,
    settings,
    neutralised: worker.neutralised.map((item) => item.flag).sort(),
    sources,
  }
}

/** The inputs a stored policy was built from: checking it again never looks at the agent row. */
export const inputsOf = (policy: WorkerPolicy): PolicyInputs => ({
  runtime: policy.runtime,
  permission: policy.permission,
  model: policy.model,
  workspace: policy.workspace.real,
  version: policy.cli.version,
})

/** The reach sentence for a stored policy. */
export function reachOf(policy: WorkerPolicy): { text: string; beyondWorkspace: boolean } {
  return workerDriver(policy.runtime).worker.reach(policy.permission, policy.workspace.real)
}

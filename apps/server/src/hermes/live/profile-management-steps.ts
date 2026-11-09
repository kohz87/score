import { setUpNewProfileSubagents } from './subagent-setup.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ProfileStepName } from '@score/contract'
import { drifted, expectedConfig } from '../approvals.ts'
import type { ProfileStepContext } from '../profile-management.ts'
import { runHermes } from './cli.ts'
import { readKey, ensureGeneration } from './credentials.ts'
import { GatewayClient } from './gateway.ts'
import { ProfileNameSchema } from './paths.ts'
import {
  type LiveProfileManagementOptions,
  profileHome,
  runProfileCli,
} from './profile-management-context.ts'
import { writeProfileDescription } from './profile-management-description.ts'
import {
  ensurePrivateDirectory,
  failure,
  foreignOwned,
  foreignOwnedMessage,
  identity,
  stat,
  syncBackup,
  verifyProfileArchive,
} from './profile-management-files.ts'

export async function runProfileStep(
  options: LiveProfileManagementOptions,
  step: ProfileStepName,
  context: ProfileStepContext,
): Promise<{ identity: string | null }> {
  const { targetName: name, input } = context
  ProfileNameSchema.parse(name)
  if (name === 'default') throw failure('The default profile is reserved.')
  const home = profileHome(options, name)
  const actual = identity(home)
  const absentStep = ['purge_identity', 'retire'].includes(step)
  if (
    step !== 'create_profile' &&
    step !== 'import_profile' &&
    !absentStep &&
    (!context.targetIdentity || actual !== context.targetIdentity)
  )
    throw failure('The profile changed. Score won’t act on a different profile with the same name.')
  const db = options.db
  const gateway = () => {
    if (!db) throw failure('Score’s storage isn’t available.')
    return new GatewayClient({
      scoreHome: options.scoreHome,
      db,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    })
  }
  if (step === 'create_profile') {
    if (stat(home) || !input)
      throw failure('A folder already exists at that location. Score won’t take it over.')
    await runProfileCli(options, [
      '-p',
      'default',
      'profile',
      'create',
      name,
      ...(input.cloneFrom ? ['--clone-from', input.cloneFrom] : []),
      '--description',
      input.role,
      '--no-alias',
    ])
    const created = identity(home)
    if (!created) throw failure('Couldn’t confirm the profile was created.')
    return { identity: created }
  }
  if (step === 'import_profile') {
    const archive = context.importArchive
    if (stat(home) || !archive || !input)
      throw failure('A folder already exists at that location. Score won’t take it over.')
    const directory = join(resolve(options.scoreHome), 'profile-imports')
    // Only Score's own private upload directory; the path never comes from a request.
    if (dirname(resolve(archive)) !== directory)
      throw failure('The imported archive isn’t in Score’s storage.')
    const file = lstatSync(archive)
    if (!file.isFile() || (file.mode & 0o077) !== 0)
      throw failure('The imported archive isn’t a private file.')
    // Hermes extracts into a staging directory, refuses links and unsafe paths, and never overwrites a profile.
    await runProfileCli(options, ['-p', 'default', 'profile', 'import', archive, '--name', name])
    const created = identity(home)
    if (!created) throw failure('Couldn’t confirm the profile was imported.')
    return { identity: created }
  }
  if (step === 'describe_profile') {
    if (!input) throw failure('The import details are missing.')
    await writeProfileDescription(options, name, input.role)
  } else if (step === 'preserve_key') {
    ensurePrivateDirectory(resolve(options.scoreHome))
    const directory = join(resolve(options.scoreHome), 'hermes-keys')
    ensurePrivateDirectory(directory)
    const path = join(directory, name)
    if (stat(path)) throw failure('An access key already exists. Score won’t replace it.')
    const temporary = join(directory, `.key-${randomUUID()}`)
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      writeFileSync(fd, randomBytes(32).toString('hex'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temporary, path)
    } finally {
      unlinkSync(temporary)
    }
    const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
    const key = readKey(options.scoreHome, name)
    if (!db) throw failure('Score’s storage isn’t available.')
    ensureGeneration(db, name, key.keySha256)
  } else if (step === 'configure_key') {
    const key = readKey(options.scoreHome, name)
    await runProfileCli(options, ['-p', name, 'config', 'set', 'API_SERVER_KEY', key.key], true)
    await gateway().capabilities(name)
  } else if (step === 'model') {
    if (!input) throw failure('The new agent’s details are missing.')
    await options.port.setAgentModel(name, {
      model: input.model,
      ...(input.provider ? { provider: input.provider } : {}),
    })
    options.profiles.invalidate(name)
    const detail = await options.profiles.read(name, 0, true, {
      status: 'idle',
      activity: null,
    })
    if (detail.model?.id !== input.model) throw failure('Hermes didn’t keep the model.')
  } else if (step === 'permissions') {
    await options.port.updateApprovals(name, (current) =>
      expectedConfig(
        current,
        context.baseline,
        { withoutGoAhead: [], extraNever: [] },
        context.previousNever,
      ),
    )
    const config = await options.port.readApprovals(name)
    if (
      drifted(
        config,
        expectedConfig(config, context.baseline, { withoutGoAhead: [], extraNever: [] }),
      )
    )
      throw failure('Hermes didn’t keep the team rules.')
  } else if (step === 'install_bridge') {
    if (!options.bridgeInstallUrl || !options.bridgeInstallRef)
      throw failure('Set where to install Score’s plugin from first.')
    await runProfileCli(options, [
      '-p',
      name,
      'plugins',
      'install',
      options.bridgeInstallUrl,
      '--ref',
      z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .parse(options.bridgeInstallRef),
      // Hermes otherwise asks whether to enable it; nobody answers a prompt here. Enabling is the next step.
      '--no-enable',
      // An imported Score agent already carries the bridge directory; Hermes reinstalls it from the pin.
      ...(context.importArchive ? ['--force'] : []),
    ])
    if (
      !['score-bridge', 'score_bridge'].some((dir) =>
        stat(join(home, 'plugins', dir, 'plugin.yaml'))?.isFile(),
      )
    )
      throw failure('Couldn’t confirm that Score’s plugin was installed.')
    const provenance = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(join(home, 'plugins', '.install-metadata.json'), 'utf8')))
    if (
      !Object.entries(provenance).some(([name, value]) => {
        const parsed = z.object({ revision: z.string(), pinned: z.boolean() }).safeParse(value)
        return (
          ['score-bridge', 'score_bridge'].includes(name) &&
          parsed.success &&
          parsed.data.pinned &&
          parsed.data.revision === options.bridgeInstallRef
        )
      })
    )
      throw failure('The installed plugin isn’t the version Score expects.')
  } else if (step === 'enable_bridge') {
    await runProfileCli(options, ['-p', name, 'plugins', 'enable', 'score-bridge'])
    // Hermes 0.22.5's Tool Search hides plugin and MCP tools (Score's own) behind tool_search/tool_call; weaker models
    // loop on it, so Score's agents keep every tool visible (owner, 2026-10-26). Best effort: an older Hermes has no
    // such setting, and a refusal there must not stop the setup.
    await (options.runner ?? runHermes)(
      ['-p', name, 'config', 'set', 'tools.tool_search.enabled', 'off'],
      { timeoutMs: 15000, hermesHome: options.hermesHome },
    ).catch(() => undefined)
    // Subagents are safe only inline (decision 173). Best effort too: without it they stay refused, and the Agents
    // page offers the change.
    await setUpNewProfileSubagents(options.runner ?? runHermes, options.hermesHome, db, name, home)
    const result = await (options.runner ?? runHermes)(
      ['-p', name, 'config', 'get', '--json', 'plugins.enabled'],
      { timeoutMs: 5000, hermesHome: options.hermesHome, captureRead: true },
    )
    const enabled = z.array(z.string()).parse(JSON.parse(result.stdout ?? 'null'))
    if (!enabled.some((key) => ['score-bridge', 'score_bridge'].includes(key)))
      throw failure('Couldn’t confirm that Score’s plugin is on.')
  } else if (step === 'verify_ready') {
    await gateway().capabilities(name)
    options.profiles.invalidate(name)
    const detail = await options.profiles.read(name, 0, true, {
      status: 'idle',
      activity: null,
    })
    if (!context.importArchive && detail.model?.id !== input?.model)
      throw failure('Model changed during setup.')
    const config = await options.port.readApprovals(name)
    if (
      drifted(
        config,
        expectedConfig(config, context.baseline, { withoutGoAhead: [], extraNever: [] }),
      )
    )
      throw failure('Permissions changed during setup.')
    // The bridge plugin loads when the profile runs its first session, and Score never starts one by itself, so a
    // handshake can't gate readiness (checked live 2026-10-08: it connects within seconds of the first run). The
    // gateway key, model and team rules above are what must hold before Score routes work here.
  } else if (step === 'export') {
    const directory = join(resolve(options.scoreHome), 'profile-backups')
    ensurePrivateDirectory(resolve(options.scoreHome))
    ensurePrivateDirectory(directory)
    const path = context.exportPath
    if (!path || dirname(resolve(path)) !== directory)
      throw failure('The export location is unsafe or already in use.')
    // The path is unique to this operation, so a file there is our own earlier attempt: a retry reuses it (it is
    // verified before anything is deleted) instead of failing forever. Anything but a plain file is refused.
    const earlier = stat(path)
    if (earlier && (!earlier.isFile() || earlier.isSymbolicLink()))
      throw failure('The export location is unsafe or already in use.')
    if (!earlier)
      await runProfileCli(options, ['-p', 'default', 'profile', 'export', name, '-o', path])
    if (!stat(path)?.isFile()) throw failure('The export is missing.')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
    verifyProfileArchive(path, name)
    syncBackup(path)
  } else if (step === 'delete_profile') {
    if (!context.exportPath) throw failure('No private export exists.')
    verifyProfileArchive(context.exportPath, name)
    syncBackup(context.exportPath)
    // Hermes can remove the profile and then fail identity settlement (non-zero exit). The directory being
    // gone is the postcondition; purge_identity is the retryable step that finishes the rest.
    try {
      await runProfileCli(options, ['-p', 'default', 'profile', 'delete', '-y', name])
    } catch (error) {
      if (stat(home)) {
        // Hermes' own output stays private (cli.ts); name what Score can see for itself.
        const foreign = foreignOwned(home)
        if (foreign) throw failure(foreignOwnedMessage(home, foreign))
        throw error
      }
    }
    if (stat(home)) throw failure('The profile folder still exists.')
  } else if (step === 'purge_identity') {
    if (stat(home)) throw failure('A different profile has this name. Score won’t clean it up.')
    await runProfileCli(options, ['-p', 'default', 'profile', 'purge-identity', name])
    // The profile and its .env are gone; Score's copy of its API key must not outlive them.
    const key = join(resolve(options.scoreHome), 'hermes-keys', name)
    const existing = stat(key)
    if (existing?.isFile()) unlinkSync(key)
    else if (existing)
      throw failure('The saved key isn’t a plain file. Remove it on the Score machine.')
  }
  return { identity: context.targetIdentity }
}

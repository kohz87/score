import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  constants,
  fchmodSync,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  linkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import type { ProfileStepName } from '@score/contract'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
import type {
  ProfileInventory,
  ProfileManagementPort,
  ProfileStepContext,
} from '../profile-management.ts'
import { drifted, expectedConfig } from '../approvals.ts'
import { readKey, ensureGeneration } from './credentials.ts'
import { ProfileNameSchema } from './paths.ts'
import { ProfilesReader } from './profiles.ts'
import { GatewayClient } from './gateway.ts'
import { runHermes, type HermesRunner } from './cli.ts'

const failure = (message: string) => new HttpError(409, 'conflict', message)
function stat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
function identity(path: string): string | null {
  const value = stat(path)
  return value?.isDirectory() ? `${value.dev}:${value.ino}:${value.birthtimeMs}` : null
}
/**
 * 3.7.4: the first path in a profile folder that belongs to another user (Hermes' Docker sandbox writes as root), or
 * null. Hermes runs as this user, so it can't delete such a folder. Bounded; symlinks are not followed. Names only:
 * nothing is opened or read.
 */
export function foreignOwned(home: string, uid = process.getuid?.(), limit = 50000): string | null {
  if (uid === undefined) return null
  const queue = [home]
  let seen = 0
  while (queue.length > 0 && seen < limit) {
    const dir = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // A folder this user can't even list is foreign too.
      return dir === home ? null : dir
    }
    for (const entry of entries) {
      seen += 1
      const path = join(dir, entry.name)
      const info = stat(path)
      if (!info) continue
      if (info.uid !== uid) return path
      if (info.isDirectory()) queue.push(path)
    }
  }
  return null
}

/** What to tell the person when a profile folder holds files only another user can delete. */
export function foreignOwnedMessage(home: string, path: string): string {
  const user = userInfo().username
  return `Some files in this agent's folder belong to another user (for example ${relative(home, path)}, made by its Docker sandbox), so Hermes can't delete them. On the Score machine run: sudo chown -R ${user}: '${home}' — then try again.`
}

function privateDirectory(path: string) {
  mkdirSync(path, { mode: 0o700 })
  syncPath(dirname(path))
}
// Reading cached bytes doesn't prove durability: sync the file or directory itself.
function syncPath(path: string, flags = constants.O_RDONLY) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function syncBackup(path: string) {
  syncPath(path)
  syncPath(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
}
function ensurePrivateDirectory(path: string) {
  if (!stat(path)) privateDirectory(path)
  const value = lstatSync(path)
  if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o077) !== 0)
    throw failure('Score’s home folder must be private to your user and contain no symbolic links.')
}

/** Verify gzip CRC, tar headers, entry bounds and the profile root without extracting or logging contents. */
export function verifyProfileArchive(path: string, name: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const value = fstatSync(fd)
    if (
      !value.isFile() ||
      value.uid !== process.getuid?.() ||
      (value.mode & 0o077) !== 0 ||
      value.size > 256 * 1024 * 1024
    )
      throw failure('Couldn’t verify the private export.')
    const data = gunzipSync(readFileSync(fd), { maxOutputLength: 512 * 1024 * 1024 })
    let entries = 0
    // GNU tar (what Hermes writes) puts names over 100 bytes in a ././@LongLink record ("L") before the entry.
    let longName: string | undefined
    for (let offset = 0; offset + 512 <= data.length;) {
      const header = data.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) {
        if (
          !entries ||
          data.length - offset < 1024 ||
          !data.subarray(offset).every((byte) => byte === 0)
        )
          throw failure('The export archive is incomplete.')
        return
      }
      const text = (start: number, end: number) =>
        header.subarray(start, end).toString().split('\0')[0]!.trim()
      const checksum = Number.parseInt(text(148, 156), 8)
      const total = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      )
      const size = Number.parseInt(text(124, 136) || '0', 8)
      if (
        checksum !== total ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        offset + 512 + size > data.length
      )
        throw failure('The export archive is corrupt.')
      const type = text(156, 157)
      if (type === 'L' || type === 'K') {
        // "K" is a long link target; Score never extracts the archive, so only "L" names are checked.
        if (type === 'L')
          longName = data
            .subarray(offset + 512, offset + 512 + size)
            .toString()
            .split('\0')[0]!
        offset += 512 + Math.ceil(size / 512) * 512
        continue
      }
      // The prefix field exists only in POSIX ustar headers; GNU headers use those bytes for timestamps.
      const ustar = header.subarray(257, 263).toString() === 'ustar\0'
      const entry =
        longName ?? [ustar ? text(345, 500) : '', text(0, 100)].filter(Boolean).join('/')
      longName = undefined
      // Python tarfile may prepend a PAX extended header for timestamps; it carries no extracted entry.
      if (
        !['x', 'g'].includes(type) &&
        ((!entry.startsWith(`${name}/`) && entry !== name) ||
          entry.split('/').includes('..') ||
          entry.startsWith('/'))
      )
        throw failure('The export archive has an unexpected layout.')
      entries++
      offset += 512 + Math.ceil(size / 512) * 512
    }
    throw failure('The export archive is incomplete.')
  } finally {
    closeSync(fd)
  }
}

export class LiveProfileManagement implements ProfileManagementPort {
  constructor(
    private readonly options: {
      scoreHome: string
      hermesHome: string
      db: ScoreDb | undefined
      profiles: ProfilesReader
      port: Pick<
        import('../port.ts').HermesPort,
        'setAgentModel' | 'readApprovals' | 'updateApprovals'
      >
      bridgeInstallUrl?: string
      bridgeInstallRef?: string
      runner?: HermesRunner
      fetch?: typeof globalThis.fetch
      baseUrl?: string
    },
  ) {}
  private home(name: string) {
    const parent = join(this.options.hermesHome, 'profiles')
    if (
      !stat(this.options.hermesHome)?.isDirectory() ||
      (stat(parent) && !stat(parent)?.isDirectory())
    )
      throw failure(
        'The folder that holds Hermes profiles must be a plain folder with no symbolic links.',
      )
    return join(this.options.hermesHome, 'profiles', ProfileNameSchema.parse(name))
  }
  async profileInventory(name: string, cloneFrom?: string): Promise<ProfileInventory> {
    ProfileNameSchema.parse(name)
    const home = name === 'default' ? this.options.hermesHome : this.home(name)
    const targetIdentity = identity(home)
    const inherited: ProfileInventory['inherited'] = {
      memories: [],
      skills: [],
      plugins: [],
      approvalSettings: [],
      credentialsPresent: [],
    }
    const blockers: string[] = []
    // An existing profile with files only another user can delete would stop halfway through a removal: say so first.
    if (targetIdentity) {
      const foreign = foreignOwned(home)
      if (foreign) blockers.push(foreignOwnedMessage(home, foreign))
    }
    if (!targetIdentity && stat(home))
      blockers.push('The target path exists and cannot be adopted.')
    if (!targetIdentity && (!this.options.bridgeInstallUrl || !this.options.bridgeInstallRef))
      blockers.push('A pinned bridge installation URL has not been configured.')
    let sourceRevision: unknown = null
    if (cloneFrom) {
      const source = this.options.profiles.profileHome(ProfileNameSchema.parse(cloneFrom))
      if (!source) blockers.push('Clone source not found.')
      else {
        const detail = await this.options.profiles.read(cloneFrom, 0, false, {
          status: 'offline',
          activity: null,
        })
        inherited.memories = [
          'memories/MEMORY.md',
          'memories/USER.md',
          'external memory provider configuration',
        ]
        inherited.skills = detail.skills.map((item) => item.name)
        const pluginRoot = join(source, 'plugins')
        if (stat(pluginRoot)?.isDirectory())
          inherited.plugins = readdirSync(pluginRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => redact(entry.name))
        const approvals = await this.options.port.readApprovals(cloneFrom)
        inherited.approvalSettings = [
          `mode: ${approvals.mode}`,
          ...approvals.allowlist.map((key) => `allow: ${redact(key)}`),
          ...approvals.deny.map((key) => `deny: ${redact(key)}`),
        ]
        // Hermes's normal clone reads credential files internally. Score is forbidden to inspect those,
        // and this tested CLI exposes no complete names-only inventory for env / memory-provider credentials.
        blockers.push(
          'Cloning is unavailable: a complete names-only credential inventory cannot be verified without reading protected files.',
        )
        sourceRevision = [identity(source), detail, approvals]
      }
    }
    const signatures = [
      'profile.yaml',
      'config.yaml',
      'SOUL.md',
      'AGENTS.md',
      'state.db',
      'state.db-wal',
    ].map((file) => {
      const value = stat(join(home, file))
      return value ? [file, value.ino, value.size, value.mtimeMs] : [file, null]
    })
    return {
      exists: targetIdentity !== null,
      identity: targetIdentity,
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            targetIdentity,
            signatures,
            sourceRevision,
            this.options.bridgeInstallUrl,
            this.options.bridgeInstallRef,
          ]),
        )
        .digest('hex'),
      inherited,
      blockers,
    }
  }
  profileExportPath(name: string, revision: string) {
    return join(
      resolve(this.options.scoreHome),
      'profile-backups',
      `${ProfileNameSchema.parse(name)}-${createHash('sha256').update(revision).digest('hex').slice(0, 24)}.tar.gz`,
    )
  }
  private async cli(args: string[], secret = false) {
    const result = await (this.options.runner ?? runHermes)(args, {
      timeoutMs: 120000,
      hermesHome: this.options.hermesHome,
      ...(secret ? { sensitiveArgIndices: [args.length - 1] } : {}),
    }).catch(() => ({ exitCode: -1 }))
    if (result.exitCode !== 0)
      throw failure(
        'The CLI refused or didn’t confirm this step. Inspect the profile locally; no fallback was attempted.',
      )
  }
  async describeProfile(name: string, description: string) {
    ProfileNameSchema.parse(name)
    const text = z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((v) => !v.includes('\0'))
      .parse(description)
    await this.cli(['-p', 'default', 'profile', 'describe', name, '--text', text])
    this.options.profiles.invalidate(name)
    const detail = await this.options.profiles.read(name, 0, false, {
      status: 'offline',
      activity: null,
    })
    if (detail.role !== redact(text)) throw failure('Hermes didn’t keep the description.')
  }
  async profileStep(step: ProfileStepName, context: ProfileStepContext) {
    const { targetName: name, input } = context
    ProfileNameSchema.parse(name)
    if (name === 'default') throw failure('The default profile is reserved.')
    const home = this.home(name)
    const actual = identity(home)
    const absentStep = ['purge_identity', 'retire'].includes(step)
    if (
      step !== 'create_profile' &&
      step !== 'import_profile' &&
      !absentStep &&
      (!context.targetIdentity || actual !== context.targetIdentity)
    )
      throw failure(
        'The profile changed. Score won’t act on a different profile with the same name.',
      )
    const db = this.options.db
    const gateway = () => {
      if (!db) throw failure('Score’s storage isn’t available.')
      return new GatewayClient({
        scoreHome: this.options.scoreHome,
        db,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      })
    }
    if (step === 'create_profile') {
      if (stat(home) || !input)
        throw failure('A folder already exists at that location. Score won’t take it over.')
      await this.cli([
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
      const directory = join(resolve(this.options.scoreHome), 'profile-imports')
      // Only Score's own private upload directory; the path never comes from a request.
      if (dirname(resolve(archive)) !== directory)
        throw failure('The imported archive isn’t in Score’s storage.')
      const file = lstatSync(archive)
      if (!file.isFile() || (file.mode & 0o077) !== 0)
        throw failure('The imported archive isn’t a private file.')
      // Hermes extracts into a staging directory, refuses links and unsafe paths, and never overwrites a profile.
      await this.cli(['-p', 'default', 'profile', 'import', archive, '--name', name])
      const created = identity(home)
      if (!created) throw failure('Couldn’t confirm the profile was imported.')
      return { identity: created }
    }
    if (step === 'describe_profile') {
      if (!input) throw failure('The import details are missing.')
      await this.describeProfile(name, input.role)
    } else if (step === 'preserve_key') {
      ensurePrivateDirectory(resolve(this.options.scoreHome))
      const directory = join(resolve(this.options.scoreHome), 'hermes-keys')
      ensurePrivateDirectory(directory)
      const path = join(directory, name)
      if (stat(path)) throw failure('An access key already exists. Score won’t replace it.')
      const temporary = join(directory, `.key-${randomUUID()}`)
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
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
      const key = readKey(this.options.scoreHome, name)
      if (!db) throw failure('Score’s storage isn’t available.')
      ensureGeneration(db, name, key.keySha256)
    } else if (step === 'configure_key') {
      const key = readKey(this.options.scoreHome, name)
      await this.cli(['-p', name, 'config', 'set', 'API_SERVER_KEY', key.key], true)
      await gateway().capabilities(name)
    } else if (step === 'model') {
      if (!input) throw failure('The new agent’s details are missing.')
      await this.options.port.setAgentModel(name, {
        model: input.model,
        ...(input.provider ? { provider: input.provider } : {}),
      })
      this.options.profiles.invalidate(name)
      const detail = await this.options.profiles.read(name, 0, true, {
        status: 'idle',
        activity: null,
      })
      if (detail.model?.id !== input.model) throw failure('Hermes didn’t keep the model.')
    } else if (step === 'permissions') {
      await this.options.port.updateApprovals(name, (current) =>
        expectedConfig(
          current,
          context.baseline,
          { withoutGoAhead: [], extraNever: [] },
          context.previousNever,
        ),
      )
      const config = await this.options.port.readApprovals(name)
      if (
        drifted(
          config,
          expectedConfig(config, context.baseline, { withoutGoAhead: [], extraNever: [] }),
        )
      )
        throw failure('Hermes didn’t keep the team rules.')
    } else if (step === 'install_bridge') {
      if (!this.options.bridgeInstallUrl || !this.options.bridgeInstallRef)
        throw failure('Set where to install Score’s plugin from first.')
      await this.cli([
        '-p',
        name,
        'plugins',
        'install',
        this.options.bridgeInstallUrl,
        '--ref',
        z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .parse(this.options.bridgeInstallRef),
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
            parsed.data.revision === this.options.bridgeInstallRef
          )
        })
      )
        throw failure('The installed plugin isn’t the version Score expects.')
    } else if (step === 'enable_bridge') {
      await this.cli(['-p', name, 'plugins', 'enable', 'score-bridge'])
      // Hermes 0.22.5's Tool Search hides plugin and MCP tools (Score's own) behind tool_search/tool_call; weaker models
      // loop on it, so Score's agents keep every tool visible (owner, 2026-10-26). Best effort: an older Hermes has no
      // such setting, and a refusal there must not stop the setup.
      await (this.options.runner ?? runHermes)(
        ['-p', name, 'config', 'set', 'tools.tool_search.enabled', 'off'],
        { timeoutMs: 15000, hermesHome: this.options.hermesHome },
      ).catch(() => undefined)
      const result = await (this.options.runner ?? runHermes)(
        ['-p', name, 'config', 'get', '--json', 'plugins.enabled'],
        { timeoutMs: 5000, hermesHome: this.options.hermesHome, captureRead: true },
      )
      const enabled = z.array(z.string()).parse(JSON.parse(result.stdout ?? 'null'))
      if (!enabled.some((key) => ['score-bridge', 'score_bridge'].includes(key)))
        throw failure('Couldn’t confirm that Score’s plugin is on.')
    } else if (step === 'verify_ready') {
      await gateway().capabilities(name)
      this.options.profiles.invalidate(name)
      const detail = await this.options.profiles.read(name, 0, true, {
        status: 'idle',
        activity: null,
      })
      if (!context.importArchive && detail.model?.id !== input?.model)
        throw failure('Model changed during setup.')
      const config = await this.options.port.readApprovals(name)
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
      const directory = join(resolve(this.options.scoreHome), 'profile-backups')
      ensurePrivateDirectory(resolve(this.options.scoreHome))
      ensurePrivateDirectory(directory)
      const path = context.exportPath
      if (!path || dirname(resolve(path)) !== directory)
        throw failure('The export location is unsafe or already in use.')
      // The path is unique to this operation, so a file there is our own earlier attempt: a retry reuses it (it is
      // verified before anything is deleted) instead of failing forever. Anything but a plain file is refused.
      const earlier = stat(path)
      if (earlier && (!earlier.isFile() || earlier.isSymbolicLink()))
        throw failure('The export location is unsafe or already in use.')
      if (!earlier) await this.cli(['-p', 'default', 'profile', 'export', name, '-o', path])
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
        await this.cli(['-p', 'default', 'profile', 'delete', '-y', name])
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
      await this.cli(['-p', 'default', 'profile', 'purge-identity', name])
      // The profile and its .env are gone; Score's copy of its API key must not outlive them.
      const key = join(resolve(this.options.scoreHome), 'hermes-keys', name)
      const existing = stat(key)
      if (existing?.isFile()) unlinkSync(key)
      else if (existing)
        throw failure('The saved key isn’t a plain file. Remove it on the Score machine.')
    }
    return { identity: context.targetIdentity }
  }
}

import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { redact } from '../../redact.ts'
import type { ProfileInventory } from '../profile-management.ts'
import { ProfileNameSchema } from './paths.ts'
import { type LiveProfileManagementOptions, profileHome } from './profile-management-context.ts'
import { foreignOwned, foreignOwnedMessage, identity, stat } from './profile-management-files.ts'

/** Profile folders scanned in the last few seconds: a removal reads the inventory several times. */
const foreignScans = new Map<string, { at: number; found: string | null }>()
function foreignOwnedCached(home: string): string | null {
  const now = Date.now()
  const cached = foreignScans.get(home)
  if (cached && now - cached.at < 15_000) return cached.found
  const found = foreignOwned(home)
  foreignScans.set(home, { at: now, found })
  return found
}

export async function readProfileInventory(
  options: LiveProfileManagementOptions,
  name: string,
  cloneFrom?: string,
): Promise<ProfileInventory> {
  ProfileNameSchema.parse(name)
  const home = name === 'default' ? options.hermesHome : profileHome(options, name)
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
    const foreign = foreignOwnedCached(home)
    if (foreign) blockers.push(foreignOwnedMessage(home, foreign))
  }
  if (!targetIdentity && stat(home)) blockers.push('The target path exists and cannot be adopted.')
  if (!targetIdentity && (!options.bridgeInstallUrl || !options.bridgeInstallRef))
    blockers.push('A pinned bridge installation URL has not been configured.')
  let sourceRevision: unknown = null
  if (cloneFrom) {
    const source = options.profiles.profileHome(ProfileNameSchema.parse(cloneFrom))
    if (!source) blockers.push('Clone source not found.')
    else {
      const detail = await options.profiles.read(cloneFrom, 0, false, {
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
      const approvals = await options.port.readApprovals(cloneFrom)
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
          options.bridgeInstallUrl,
          options.bridgeInstallRef,
        ]),
      )
      .digest('hex'),
    inherited,
    blockers,
  }
}

export function profileExportPath(
  options: LiveProfileManagementOptions,
  name: string,
  revision: string,
) {
  return join(
    resolve(options.scoreHome),
    'profile-backups',
    `${ProfileNameSchema.parse(name)}-${createHash('sha256').update(revision).digest('hex').slice(0, 24)}.tar.gz`,
  )
}

import { SYSTEMCTL, type RunTool } from './unit-systemd-types.ts'
import { validateUnitName } from './unit-names.ts'
import { showUnit } from './unit-systemctl.ts'

export type UnitAction = 'stopped' | 'reset' | 'absent' | 'mismatch' | 'uncertain' | 'unknown'

const ACTIVE = new Set(['active', 'activating', 'deactivating', 'reloading', 'refreshing'])

/**
 * `systemctl --user stop <exact name>`, only while the unit's InvocationID is the recorded one, and re-checked after
 * the call (design section 6b): a mismatch after the call is uncertainty (fence), not success. Score's backend no
 * longer stops by name (re-review #5: the check and the stop are not one step); this stays for the opt-in suite and
 * tooling, with the same ownership gate as `resetUnit`.
 */
export async function stopUnit(
  run: RunTool,
  name: string,
  invocationId: string,
  prefix?: string,
): Promise<UnitAction> {
  return actOnUnit(run, name, invocationId, 'stop', prefix)
}

/** `reset-failed` (collection), with the same exact-name and InvocationID gate; only after settled + ended proof. */
export async function resetUnit(
  run: RunTool,
  name: string,
  invocationId: string,
  prefix?: string,
): Promise<UnitAction> {
  return actOnUnit(run, name, invocationId, 'reset-failed', prefix)
}

async function actOnUnit(
  run: RunTool,
  name: string,
  invocationId: string,
  verb: 'stop' | 'reset-failed',
  prefix?: string,
): Promise<UnitAction> {
  if (!validateUnitName(name) || invocationId === '') return 'unknown'
  // A unit outside the caller's own namespace (another installation's, or a copied witness) is never acted on.
  if (prefix !== undefined && !name.startsWith(prefix)) return 'unknown'
  const before = await showUnit(run, name)
  if (before.kind === 'unknown') return 'unknown'
  if (before.kind === 'absent') return 'absent'
  if (before.state.invocationId !== invocationId) return 'mismatch'
  const done = await run(SYSTEMCTL, ['--user', verb, '--', name], { timeoutMs: 60_000 })
  if (done.failed) return 'unknown'
  const after = await showUnit(run, name)
  if (after.kind === 'unknown') return 'unknown'
  if (after.kind === 'absent') return verb === 'stop' ? 'stopped' : 'reset'
  if (after.state.invocationId !== invocationId) return 'uncertain'
  if (verb === 'stop')
    return ACTIVE.has(after.state.activeState) || after.state.jobPending ? 'uncertain' : 'stopped'
  return after.state.activeState === 'failed' ? 'uncertain' : 'reset'
}

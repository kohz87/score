import { createHash } from 'node:crypto'
import type { HermesCheck, HermesCheckPart } from '@score/contract'
import {
  closestTested,
  type Fingerprint,
  type FingerprintParts,
  type TestedFingerprint,
} from './fingerprint.ts'
import { BRIDGE_HOOKS, PRIVATE_APPROVAL_API, type SourceFacts } from './source-facts.ts'

// Parts that must be unchanged for a new build to be accepted. Version, revision and CLI text always differ in a new
// build; pattern keys may be added (Score shows unknown keys read-only).
const REQUIRED = new Set([
  'Capabilities',
  'Kanban database schema',
  'Session database schema',
  'Bridge hooks',
  'Approval functions',
])

export interface HermesCheckResult {
  check: HermesCheck
  /** Pattern keys this build adds to the ones Score knows (stored on accept, for display). */
  addedPatternKeys: string[]
}

const list = (items: readonly string[]) => items.join(', ')
function textPart(name: string, current: string | null, tested: string | null): HermesCheckPart {
  if (current === null) return { name, status: 'changed', detail: 'Could not be read.' }
  if (current === tested) return { name, status: 'same', detail: current }
  return { name, status: 'changed', detail: tested === null ? current : `${tested} → ${current}` }
}
function setPart(
  name: string,
  current: readonly string[] | null,
  tested: readonly string[] | null,
  unreadable: string,
): HermesCheckPart {
  if (current === null) return { name, status: 'changed', detail: unreadable }
  if (tested === null)
    return { name, status: 'changed', detail: 'No tested build to compare with.' }
  const added = current.filter((item) => !tested.includes(item))
  const removed = tested.filter((item) => !current.includes(item))
  if (!added.length && !removed.length)
    return { name, status: 'same', detail: `${current.length} unchanged` }
  const detail = [
    added.length && `added: ${list(added)}`,
    removed.length && `removed: ${list(removed)}`,
  ]
    .filter(Boolean)
    .join('; ')
  return {
    name,
    status: added.length && removed.length ? 'changed' : added.length ? 'added' : 'removed',
    detail,
  }
}
function schemaPart(name: string, current: string | null, tested: string | null): HermesCheckPart {
  if (current === null) return { name, status: 'changed', detail: 'Could not be read.' }
  if (tested === null)
    return { name, status: 'changed', detail: 'No tested build to compare with.' }
  return current === tested
    ? { name, status: 'same', detail: 'Unchanged.' }
    : { name, status: 'changed', detail: 'The database layout differs from the tested build.' }
}

export function buildHermesCheck(input: {
  fingerprint: Fingerprint
  facts: SourceFacts | null
  tested: readonly TestedFingerprint[]
  knownPatternKeys: readonly string[]
}): HermesCheckResult {
  const { fingerprint, facts, tested, knownPatternKeys } = input
  const current = fingerprint.parts
  const base: FingerprintParts | undefined = closestTested(fingerprint, tested)?.parts
  const parts: HermesCheckPart[] = [
    textPart('Hermes version', current.codeVersion, base?.codeVersion ?? null),
    textPart('Code revision', current.codeSha, base?.codeSha ?? null),
    textPart('Command line', current.cli, base?.cli ?? null),
    setPart(
      'Capabilities',
      current.capabilities,
      base?.capabilities ?? null,
      'Hermes API capabilities could not be read (is the gateway running?).',
    ),
    schemaPart('Kanban database schema', current.schemas.kanban, base?.schemas.kanban ?? null),
    schemaPart('Session database schema', current.schemas.state, base?.schemas.state ?? null),
  ]
  let addedPatternKeys: string[] = []
  if (!facts) {
    const detail = 'The Hermes sources could not be read.'
    for (const name of ['Bridge hooks', 'Approval functions', 'Dangerous-command patterns'])
      parts.push({ name, status: 'changed', detail })
  } else {
    const missingHooks = BRIDGE_HOOKS.filter((hook) => !facts.validHooks.includes(hook))
    parts.push(
      missingHooks.length
        ? { name: 'Bridge hooks', status: 'changed', detail: `Missing: ${list(missingHooks)}` }
        : { name: 'Bridge hooks', status: 'same', detail: `${BRIDGE_HOOKS.length} present` },
    )
    const api = facts.approvalApi
    const missingApi = [
      ...PRIVATE_APPROVAL_API.functions.filter((name) => !api.functions.includes(name)),
      ...PRIVATE_APPROVAL_API.state.filter((name) => !api.state.includes(name)),
      ...PRIVATE_APPROVAL_API.entrySlots.filter((name) => !api.entrySlots.includes(name)),
      ...(api.detectDangerousCommand ? [] : ['detect_dangerous_command']),
    ]
    parts.push(
      missingApi.length
        ? { name: 'Approval functions', status: 'changed', detail: `Missing: ${list(missingApi)}` }
        : { name: 'Approval functions', status: 'same', detail: 'Present' },
    )
    addedPatternKeys = facts.patternKeys.filter((key) => !knownPatternKeys.includes(key))
    parts.push(setPart('Dangerous-command patterns', facts.patternKeys, [...knownPatternKeys], ''))
  }
  // Without a revision there is nothing to pin the acceptance to.
  const compatible =
    current.codeSha !== null &&
    parts
      .filter((part) => REQUIRED.has(part.name))
      // New API capabilities don't break Score (it ignores ones it doesn't use); removed or changed ones do.
      .every(
        (part) =>
          part.status === 'same' || (part.name === 'Capabilities' && part.status === 'added'),
      )
  // 3.14.4 (owner): the person may turn approvals on anyway for an identified build that still has what approvals call;
  // without those, approvals can't work whatever they choose.
  const overridable =
    !compatible &&
    current.codeSha !== null &&
    parts.some((part) => part.name === 'Bridge hooks' && part.status === 'same') &&
    parts.some((part) => part.name === 'Approval functions' && part.status === 'same')
  const build = {
    version: current.codeVersion,
    codeSha: current.codeSha,
    fingerprint: fingerprint.id,
  }
  const hash = createHash('sha256').update(JSON.stringify({ build, parts })).digest('hex')
  return { check: { hash, build, parts, compatible, overridable }, addedPatternKeys }
}

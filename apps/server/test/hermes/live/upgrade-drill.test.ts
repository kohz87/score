import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { z } from 'zod'
import {
  evaluateCompatibility,
  testedFingerprints,
  type Fingerprint,
  type TestedFingerprint,
} from '../../../src/hermes/live/fingerprint.ts'
import { KNOWN_PATTERN_KEYS } from '../../../src/hermes/pattern-keys.ts'

// Task 5.4 (docs/reviews/2026-10-08-hermes-upgrade-drill.md). The fixture is what
// `scripts/hermes-drill-facts.py` reads out of the hermes-agent sources at the two revisions; nothing here runs Hermes.
const Facts = z.object({
  sha: z.string(),
  schemas: z.object({
    kanbanSchemaSql: z.string(),
    stateSchemaSql: z.string(),
    stateSchemaVersion: z.number(),
  }),
  capabilities: z.array(z.string()),
  validHooks: z.array(z.string()),
  dangerousPatternKeys: z.array(z.string()),
  hardlinePatternKeys: z.array(z.string()),
  approvalApi: z.object({
    functions: z.array(z.string()),
    state: z.array(z.string()),
    detectDangerousCommand: z.boolean(),
    entrySlots: z.array(z.string()),
  }),
})
const fixture = z
  .object({ e97923c38a: Facts, '0240fa4a84': Facts })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../fixtures/hermes/upgrade-drill-facts.json', import.meta.url),
        'utf8',
      ),
    ),
  )
const versions = [
  ['0.21.5 (e97923c38a, tested)', fixture.e97923c38a],
  ['upstream main (0240fa4a84)', fixture['0240fa4a84']],
] as const

// Score's bridge hooks, read from the manifest the installer ships.
const bridgeHooks = [
  ...readFileSync(
    new URL('../../../../../hermes-plugin/score_bridge/plugin.yaml', import.meta.url),
    'utf8',
  ).matchAll(/^ {2}- (\w+)$/gm),
].map((match) => match[1]!)
const requiredCapabilities = [
  'run_submission',
  'run_events_sse',
  'run_status',
  'run_stop',
  'run_approval_response',
]

test('the tested registry entry matches what the 0.21.5 sources advertise', () => {
  const [tested] = testedFingerprints
  expect(tested!.parts.codeSha).toBe(fixture.e97923c38a.sha)
  expect(tested!.parts.capabilities).toEqual(fixture.e97923c38a.capabilities)
})

test.each(versions)('%s: everything Score and its bridge rely on is present', (_name, facts) => {
  expect(bridgeHooks).toHaveLength(14)
  expect(facts.validHooks).toEqual(expect.arrayContaining(bridgeHooks))
  expect(facts.capabilities).toEqual(expect.arrayContaining(requiredCapabilities))
  expect(facts.approvalApi.functions).toEqual([
    'list_gateway_approvals',
    'resolve_gateway_approval',
  ])
  expect(facts.approvalApi.state).toEqual(['_gateway_queues', '_lock'])
  expect(facts.approvalApi.detectDangerousCommand).toBe(true)
  // The bridge sets .result and .event on a queued entry and reads .data.
  expect(facts.approvalApi.entrySlots).toEqual(expect.arrayContaining(['data', 'event', 'result']))
})

test('the kanban and state schemas are the same in both versions, so the schema fingerprint parts hold', () => {
  expect(fixture['0240fa4a84'].schemas).toEqual(fixture.e97923c38a.schemas)
  expect(fixture['0240fa4a84'].capabilities).toEqual(fixture.e97923c38a.capabilities)
  expect(fixture['0240fa4a84'].hardlinePatternKeys).toEqual(fixture.e97923c38a.hardlinePatternKeys)
})

test('the pinned pattern keys are exactly the 0.21.5 list; newer Hermes only adds keys, shown read-only', () => {
  const pinned = new Set(KNOWN_PATTERN_KEYS)
  expect([...pinned].sort()).toEqual(fixture.e97923c38a.dangerousPatternKeys)
  const newer = fixture['0240fa4a84'].dangerousPatternKeys
  expect(newer).toEqual(expect.arrayContaining([...pinned]))
  expect(newer.filter((key) => !pinned.has(key))).toEqual([
    'invisible or bidirectional Unicode control character (possible obfuscation)',
    'pipe a credential file into a curl/wget upload (possible exfiltration)',
    'upload a secret or credential file via curl/wget (possible exfiltration)',
  ])
})

function build(
  codeVersion: string,
  codeSha: string,
  facts: (typeof versions)[number][1],
): Fingerprint {
  const parts = {
    codeVersion,
    codeSha,
    capabilities: facts.capabilities,
    schemas: { kanban: 'k', state: 's' },
    bridge: null,
    cli: `Hermes Agent v${codeVersion}`,
  }
  return { id: `${codeVersion}-id`.padEnd(16, '0').slice(0, 16), parts }
}

test('a newer build with unchanged schemas and capabilities keeps runs but loses gateway approvals until recorded', () => {
  const current = build('0.21.5', fixture.e97923c38a.sha, fixture.e97923c38a)
  const upstream = build('0.21.6', fixture['0240fa4a84'].sha, fixture['0240fa4a84'])
  const recorded: TestedFingerprint = {
    ...current,
    testedAt: '2026-10-07T00:00:00.000Z',
    notes: 'Fixture build',
  }
  expect(evaluateCompatibility(current, [recorded])).toMatchObject({ tested: true, disabled: [] })
  expect(evaluateCompatibility(upstream, [recorded])).toMatchObject({
    tested: false,
    disabled: ['gateway-approvals'],
  })
  // Recording the new build next to the old one accepts both.
  const both = [recorded, { ...upstream, testedAt: '2026-10-09T00:00:00.000Z', notes: 'Drill' }]
  expect(evaluateCompatibility(current, both)).toMatchObject({ tested: true, disabled: [] })
  expect(evaluateCompatibility(upstream, both)).toMatchObject({ tested: true, disabled: [] })
})

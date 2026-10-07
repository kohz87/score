import type { SystemStatus } from '@score/contract'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import testedEntries from '../tested-fingerprints.json' with { type: 'json' }
import type { GatewayClient } from './gateway.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { openReadOnly } from './sqlite.ts'

export const FingerprintPartsSchema = z.object({
  codeVersion: z.string().min(1).nullable(),
  codeSha: z.string().min(1).nullable(),
  capabilities: z.array(z.string().min(1)).nullable(),
  schemas: z.object({ kanban: z.string().nullable(), state: z.string().nullable() }),
  // TODO(1.13a): include the bridge handshake and resolved private APIs.
  bridge: z.null(),
  cli: z.string().min(1).nullable(),
})
export type FingerprintParts = z.infer<typeof FingerprintPartsSchema>
export interface Fingerprint {
  id: string
  parts: FingerprintParts
}
export const TestedFingerprintSchema = z.object({
  id: z.string().min(1),
  parts: FingerprintPartsSchema,
  testedAt: z.iso.datetime().nullable(),
  notes: z.string(),
})
export type TestedFingerprint = z.infer<typeof TestedFingerprintSchema>
export const testedFingerprints = z.array(TestedFingerprintSchema).parse(testedEntries)

export interface FingerprintInputs {
  hermesHome?: string
  gateway?: Pick<GatewayClient, 'capabilities'>
  /** Reuse the status probe instead of issuing a second capabilities request. */
  capabilities?: string[] | null
  readCliVersion?: () => Promise<string | null>
}

const execute = promisify(execFile)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const SchemaRowsSchema = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string() }))

export async function readCliVersion(): Promise<string | null> {
  try {
    const { stdout } = await execute('hermes', ['--version'], { timeout: 5_000 })
    return z.string().trim().min(1).parse(stdout.split(/\r?\n/)[0])
  } catch {
    return null
  }
}

export function schemaHash(path: string): string | null {
  try {
    const db = openReadOnly(path)
    try {
      const rows = SchemaRowsSchema.parse(
        db
          .prepare(
            'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name',
          )
          .all(),
      )
      return sha256(JSON.stringify(rows.map(({ sql }) => sql.replace(/\s+/g, ' ').trim())))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function computeFingerprint(inputs: FingerprintInputs): Promise<Fingerprint> {
  const home = resolveHermesHome(inputs.hermesHome)
  const paths = hermesPaths(home)
  let codeVersion: string | null = null
  let codeSha: string | null = null
  try {
    const state = z
      .object({ code_version: z.unknown().optional(), code_sha: z.unknown().optional() })
      .parse(JSON.parse(readFileSync(join(home, 'gateway_state.json'), 'utf8')))
    const version = z.string().min(1).safeParse(state.code_version)
    const sha = z.string().min(1).safeParse(state.code_sha)
    codeVersion = version.success ? version.data : null
    codeSha = sha.success ? sha.data : null
  } catch {
    /* Missing or malformed state is represented in the fingerprint. */
  }
  let capabilities: string[] | null = null
  try {
    if (inputs.capabilities !== undefined) {
      capabilities = z.array(z.string().min(1)).nullable().parse(inputs.capabilities)
    } else if (inputs.gateway) {
      const features = await inputs.gateway.capabilities('default')
      capabilities = Object.keys(features).filter((name) => features[name] === true)
    }
    capabilities = capabilities === null ? null : [...new Set(capabilities)].sort()
  } catch {
    /* A failed probe is different from a successful probe with no features. */
  }
  let cli: string | null = null
  try {
    cli = FingerprintPartsSchema.shape.cli.parse(await (inputs.readCliVersion ?? readCliVersion)())
  } catch {
    /* CLI absence must not prevent reads or public API controls. */
  }
  const parts: FingerprintParts = {
    codeVersion,
    codeSha,
    capabilities,
    schemas: { kanban: schemaHash(paths.kanbanDb), state: schemaHash(paths.stateDb('default')) },
    bridge: null,
    cli,
  }
  return { id: sha256(JSON.stringify(parts)).slice(0, 16), parts }
}

const requiredCapabilities = [
  'run_submission',
  'run_events_sse',
  'run_status',
  'run_stop',
  'run_approval_response',
] as const
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export function evaluateCompatibility(
  fingerprint: Fingerprint,
  tested: readonly TestedFingerprint[],
): SystemStatus['compatibility'] {
  // The placeholder is a reminder to seed the registry, never a compatibility baseline.
  const entries = tested.filter((entry) => entry.id !== 'unseeded')
  if (entries.some(({ id }) => id === fingerprint.id))
    return { fingerprint: fingerprint.id, tested: true, disabled: [] }
  const { parts } = fingerprint
  const keys = Object.keys(parts) as (keyof FingerprintParts)[]
  let closest: TestedFingerprint | undefined
  let mostMatches = -1
  for (const entry of entries) {
    const matches = keys.filter((key) => equal(parts[key], entry.parts[key])).length
    if (matches > mostMatches) {
      closest = entry
      mostMatches = matches
    }
  }
  const disabled: string[] = []
  if (
    !closest ||
    parts.codeVersion !== closest.parts.codeVersion ||
    parts.codeSha !== closest.parts.codeSha ||
    !equal(parts.schemas, closest.parts.schemas)
  )
    disabled.push('gateway-approvals', 'kanban-grants')
  if (requiredCapabilities.some((feature) => !parts.capabilities?.includes(feature)))
    disabled.push('score-runs')
  return { fingerprint: fingerprint.id, tested: false, disabled }
}

export function assertFeature(status: Pick<SystemStatus, 'compatibility'>, feature: string): void {
  if (status.compatibility.disabled.includes(feature))
    throw new HttpError(403, 'feature_disabled', `${feature} is disabled by the compatibility gate`)
}

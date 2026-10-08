import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AgentDetailSchema,
  AgentPermissionsResponseSchema,
  AgentSummarySchema,
  NeverGlobSchema,
  PatchPermissionRequestSchema,
  PutRulesRequestSchema,
  type AgentDetail,
  type RulesResponse,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { readAgent, readAgentStyle, storeAgent } from '../domain/agents.ts'
import { unifiedDiff } from '../domain/line-diff.ts'
import {
  addOverride,
  readBaseline,
  readOverrides,
  removeOverride,
  writeBaseline,
} from '../domain/team-rules.ts'
import { HttpError } from '../errors.ts'
import {
  KNOWN_PATTERN_KEYS,
  NEVER_PREFIX,
  drifted,
  expectedConfig,
  goAheadRule,
  isKnownPatternKey,
  neverId,
  neverRule,
  patternLabel,
  type AgentOverrides,
  type ApprovalConfig,
  type Baseline,
  type HermesPort,
} from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'

const AgentParams = z.object({ agentId: z.string().min(1).max(256) })
const DryRunQuery = z.object({ dryRun: z.enum(['0', '1']).optional() })

// Contract §10 rules and §8 permissions. The team baseline is Score's record (domain/team-rules.ts); Hermes's
// per-profile approval settings are written only through the adapter's verified loop.
export function registerRulesRoutes(
  app: FastifyInstance,
  port: HermesPort,
  ingest?: Ingest,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  function storage() {
    if (!db || !ingest)
      throw new HttpError(503, 'hermes_unavailable', 'Rules storage is unavailable')
    return { db, ingest }
  }
  // Team-level changes touch every profile: one at a time.
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work)
    tail = result.catch(() => undefined)
    return result
  }

  async function agentIds(): Promise<string[]> {
    return (await port.listAgents()).map((agent) => agent.id)
  }
  async function assertAgent(agentId: string): Promise<void> {
    if (!(await agentIds()).includes(agentId))
      throw new HttpError(404, 'not_found', 'Agent not found')
  }
  async function actual(agentId: string): Promise<ApprovalConfig | null> {
    return port.readApprovals(agentId).catch(() => null)
  }

  async function view(): Promise<RulesResponse> {
    const { db } = storage()
    const baseline = readBaseline(db.sqlite)
    const ids = await agentIds()
    const configs = await Promise.all(ids.map(async (id) => [id, await actual(id)] as const))
    const unknown = new Set<string>()
    for (const [, config] of configs)
      for (const key of config?.allowlist ?? []) if (!isKnownPatternKey(key)) unknown.add(key)
    const allowed = new Set(baseline.goAhead)
    return {
      mode: baseline.mode,
      goAhead: [...baseline.goAhead, ...unknown].map(goAheadRule),
      askMe: KNOWN_PATTERN_KEYS.filter((key) => !allowed.has(key)).map(goAheadRule),
      never: baseline.never.map(neverRule),
      drift: configs.map(([agentId, config]) => ({
        agentId,
        // An unreadable profile cannot be shown to match.
        differs:
          config === null ||
          drifted(
            config,
            expectedConfig(config, baseline, readOverrides(db.sqlite, agentId), baseline.never),
          ),
      })),
    }
  }

  // Refreshes the stored detail of these agents (their permissions changed) and announces it.
  async function announce(ids: string[]): Promise<void> {
    const { ingest } = storage()
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await ingest.submit({
      source: 'agent-rules',
      identity: randomUUID(),
      apply({ sqlite }) {
        return ids.flatMap((id) => {
          const detail = details.find((agent) => agent.id === id)
          if (!detail) return []
          const stored: AgentDetail = AgentDetailSchema.parse({
            ...detail,
            style: readAgentStyle(sqlite, id) ?? detail.style,
          })
          storeAgent(sqlite, stored)
          return [{ type: 'agent.updated' as const, data: AgentSummarySchema.parse(stored) }]
        })
      },
    })
  }

  async function applyBaseline(ids: string[], previousNever: string[]): Promise<string[]> {
    const { db } = storage()
    const baseline = readBaseline(db.sqlite)
    const failed: string[] = []
    for (const id of ids) {
      const overrides = readOverrides(db.sqlite, id)
      try {
        await port.updateApprovals(id, (current) =>
          expectedConfig(current, baseline, overrides, previousNever),
        )
      } catch {
        failed.push(id)
      }
    }
    await announce(ids)
    return failed
  }

  function describe(mode: string, goAhead: string[], never: string[]): string {
    return [
      `mode: ${mode}`,
      ...[...goAhead].sort().map((key) => `go ahead: ${patternLabel(key)}`),
      ...[...never].sort().map((glob) => `never: ${glob}`),
    ].join('\n')
  }

  app.get('/api/settings/rules', async () => view())

  app.put('/api/settings/rules', mutation, async (request) => {
    const { dryRun } = DryRunQuery.parse(request.query)
    const body = PutRulesRequestSchema.parse(request.body)
    if (!body.goAhead.every(isKnownPatternKey))
      throw new HttpError(400, 'bad_request', 'Go ahead accepts known command categories only')
    const next: Baseline = {
      mode: body.mode,
      goAhead: [...new Set(body.goAhead)],
      never: [...new Set(body.never)],
    }
    const { db, ingest } = storage()
    if (dryRun === '1') {
      const before = readBaseline(db.sqlite)
      return {
        preview: unifiedDiff(
          describe(before.mode, before.goAhead, before.never) + '\n',
          describe(next.mode, next.goAhead, next.never) + '\n',
        ),
      }
    }
    return serial(async () => {
      const previous = readBaseline(db.sqlite)
      const at = new Date(clock()).toISOString()
      // Recorded first: a profile Hermes refuses then shows up as drift instead of being forgotten.
      await ingest.submit({
        source: 'team-rules',
        identity: randomUUID(),
        apply({ sqlite }) {
          writeBaseline(sqlite, next, at)
          return []
        },
      })
      const failed = await applyBaseline(await agentIds(), previous.never)
      return { ...(await view()), failed }
    })
  })

  app.post('/api/settings/rules/apply/:agentId', mutation, async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    await assertAgent(agentId)
    const { db } = storage()
    return serial(async () => {
      const baseline = readBaseline(db.sqlite)
      const failed = await applyBaseline([agentId], baseline.never)
      if (failed.length > 0)
        throw new HttpError(409, 'conflict', 'Hermes did not accept the team rules')
      return view()
    })
  })

  app.patch('/api/agents/:agentId/permissions/:permId', mutation, async (request) => {
    const { agentId, permId } = AgentParams.extend({
      permId: z.string().min(1).max(400),
    }).parse(request.params)
    const { level } = PatchPermissionRequestSchema.parse(request.body)
    await assertAgent(agentId)
    const { db, ingest } = storage()
    const notStricter = () =>
      new HttpError(400, 'not_stricter', 'A single agent can only be made stricter than the team')
    return serial(async () => {
      let row: { id: string; label: string; level: typeof level; inherited: boolean }
      if (permId.startsWith(NEVER_PREFIX)) {
        const glob = NeverGlobSchema.parse(permId.slice(NEVER_PREFIX.length))
        if (level !== 'never') {
          // Removing a Never (or turning it into anything softer) loosens the agent.
          throw notStricter()
        }
        await port.updateApprovals(agentId, (current) => ({
          ...current,
          deny: [...new Set([...current.deny, glob])],
        }))
        await ingest.submit({
          source: 'agent-rules',
          identity: randomUUID(),
          apply({ sqlite }) {
            addOverride(sqlite, agentId, 'extra_never', glob)
            return []
          },
        })
        row = { id: neverId(glob), label: glob, level, inherited: false }
      } else {
        if (!isKnownPatternKey(permId))
          throw new HttpError(400, 'bad_request', 'Unknown command category')
        if (level === 'never')
          throw new HttpError(
            400,
            'bad_request',
            'Never applies to command patterns, not categories; add a Never rule instead',
          )
        await port.updateApprovals(agentId, (current) => {
          const has = current.allowlist.includes(permId)
          if (level === 'allowed' && !has) throw notStricter()
          return level === 'asks'
            ? { ...current, allowlist: current.allowlist.filter((key) => key !== permId) }
            : current
        })
        if (level === 'asks')
          await ingest.submit({
            source: 'agent-rules',
            identity: randomUUID(),
            apply({ sqlite }) {
              addOverride(sqlite, agentId, 'without_go_ahead', permId)
              return []
            },
          })
        row = { id: permId, label: patternLabel(permId), level, inherited: false }
      }
      await announce([agentId])
      const stored = readAgent(db.sqlite, agentId)?.permissions.find((p) => p.id === row.id)
      return stored ?? row
    })
  })

  // Takes back an agent's own stricter choice: the profile goes back to exactly what the team baseline asks for
  // (never looser). Only Score's recorded overrides can be removed; a team rule or a Hermes-owned entry cannot.
  app.delete('/api/agents/:agentId/permissions/:permId', mutation, async (request) => {
    const { agentId, permId } = AgentParams.extend({
      permId: z.string().min(1).max(400),
    }).parse(request.params)
    await assertAgent(agentId)
    const { db, ingest } = storage()
    return serial(async () => {
      const baseline = readBaseline(db.sqlite)
      const overrides = readOverrides(db.sqlite, agentId)
      let kind: 'without_go_ahead' | 'extra_never'
      let value: string
      if (permId.startsWith(NEVER_PREFIX)) {
        kind = 'extra_never'
        value = permId.slice(NEVER_PREFIX.length)
      } else {
        kind = 'without_go_ahead'
        value = permId
      }
      const recorded = kind === 'extra_never' ? overrides.extraNever : overrides.withoutGoAhead
      if (!recorded.includes(value)) {
        // A rule that belongs to the team is not this agent's to remove; anything else is simply unknown.
        if (baseline.never.includes(value) || baseline.goAhead.includes(value))
          throw new HttpError(
            400,
            'not_an_override',
            'That rule comes from the team, not this agent',
          )
        throw new HttpError(404, 'not_found', 'This agent has no such override')
      }
      const remaining: AgentOverrides = {
        withoutGoAhead: overrides.withoutGoAhead.filter(
          (v) => kind !== 'without_go_ahead' || v !== value,
        ),
        extraNever: overrides.extraNever.filter((v) => kind !== 'extra_never' || v !== value),
      }
      try {
        // The removed glob counts as Score-managed, so it leaves `approvals.deny` unless the team has it too.
        await port.updateApprovals(agentId, (current) =>
          expectedConfig(
            current,
            baseline,
            remaining,
            kind === 'extra_never' ? [...baseline.never, value] : baseline.never,
          ),
        )
      } catch {
        throw new HttpError(409, 'conflict', 'Hermes did not accept the change')
      }
      // Forgotten only once Hermes holds the baseline-derived config, so a failed write leaves the override.
      await ingest.submit({
        source: 'agent-rules',
        identity: randomUUID(),
        apply({ sqlite }) {
          removeOverride(sqlite, agentId, kind, value)
          return []
        },
      })
      await announce([agentId])
      return AgentPermissionsResponseSchema.parse({
        items: readAgent(db.sqlite, agentId)?.permissions ?? [],
      })
    })
  })
}

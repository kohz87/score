import {
  AgentLookSchema,
  AgentStyleSchema,
  AgentSummarySchema,
  ShapeSchema,
  type PetPack,
  type AgentLook,
  type AgentStyle,
  type AgentSummary,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Ingest } from '../hub/ingest.ts'
import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { withInheritance } from './team-rules.ts'
import { applyLifecycle } from './agent-lifecycle.ts'
import { packMeta, parsePack } from '../packs/meta.ts'
import { getCodingAgent, isCodingAgent } from '../runtimes/coding/store.ts'

// Defaults stay on the original eight shapes (the rest, PLAN 10.2, are chosen), so no agent's default look changes.
const defaultShapes = ShapeSchema.options.slice(0, 8)
const colors = ['#6B4EFF', '#19C39A', '#FFB61E', '#FF6B8A'] as const
export function defaultAgentStyle(index: number): AgentStyle {
  return {
    color: colors[index % colors.length]!,
    shape: defaultShapes[index % defaultShapes.length]!,
  }
}
const DetailRowSchema = z.object({ detail: z.string() })
const StyleRowSchema = z.object({
  color: AgentStyleSchema.shape.color,
  shape: AgentStyleSchema.shape.shape,
  look: AgentLookSchema,
  pack_rev: z.string().nullable(),
  pack_meta: z.string().nullable(),
  updated_at: z.iso.datetime(),
})
/** A style with every optional part spelled out (absent look = cut, absent pack = none), so styles compare equal. */
export function completeStyle(
  style: AgentStyle,
): AgentStyle & { look: AgentLook; pack: PetPack | null } {
  return { ...style, look: style.look ?? 'cut', pack: style.pack ?? null }
}
/**
 * What a client may put in a style it sends (create, import, patch): colour, shape and look. The pack has its own
 * routes and is never taken from a request body.
 */
export function clientStyle(style: AgentStyle): AgentStyle {
  return { color: style.color, shape: style.shape, look: style.look ?? 'cut', pack: null }
}
export function readAgent(sqlite: DatabaseSync, id: string): AgentDetail | null {
  const row = sqlite.prepare('SELECT detail FROM agents_proj WHERE id = ?').get(id)
  return row ? AgentDetailSchema.parse(JSON.parse(DetailRowSchema.parse(row).detail)) : null
}
/** Id and display name of every projected agent: what Reports needs, without asking Hermes. */
export function readAgentNames(sqlite: DatabaseSync): { id: string; name: string }[] {
  return sqlite
    .prepare(
      `SELECT id, json_extract(detail, '$.name') AS name FROM agents_proj
       WHERE COALESCE(json_extract(detail, '$.lifecycle.state'), 'ready') NOT IN ('removed', 'deleting')
       ORDER BY id`,
    )
    .all()
    .map((row) => z.object({ id: z.string(), name: z.string() }).parse(row))
}
/**
 * The saved style of an agent, wherever it lives: a coding agent's own row, else the Hermes override. Everything that
 * rebuilds a projection from a fetched list (a refresh that started before a save) takes this as authoritative.
 */
export function readAgentStyle(sqlite: DatabaseSync, id: string): AgentStyle | null {
  const coding = getCodingAgent(sqlite, id)
  if (coding) return AgentStyleSchema.parse(coding.style)
  const row = sqlite
    .prepare(
      'SELECT color, shape, look, pack_rev, pack_meta, updated_at FROM agent_styles WHERE agent_id = ?',
    )
    .get(id)
  if (!row) return null
  const parsed = StyleRowSchema.parse(row)
  return AgentStyleSchema.parse({
    color: parsed.color,
    shape: parsed.shape,
    look: parsed.look,
    pack: parsePack(parsed.pack_rev, parsed.pack_meta),
  })
}
/**
 * Writes the style of an agent where it lives: a coding agent in its own row, a Hermes profile in `agent_styles`.
 * The pet pack is left alone unless `pack` is given (only the pack routes do that).
 */
export function writeAgentStyle(
  sqlite: DatabaseSync,
  agentId: string,
  style: AgentStyle,
  now: string,
  options: { pack?: boolean } = {},
): void {
  const full = completeStyle(style)
  // Validated on the way in as on the way out.
  const pack = packMeta(full.pack)
  if (isCodingAgent(sqlite, agentId)) {
    sqlite
      .prepare(
        `UPDATE coding_agents SET color = ?, shape = ?, look = ?${options.pack ? ', pack_rev = ?, pack_meta = ?' : ''} WHERE id = ?`,
      )
      .run(
        ...[
          full.color,
          full.shape,
          full.look,
          ...(options.pack ? [pack.rev, pack.meta] : []),
          agentId,
        ],
      )
    return
  }
  sqlite
    .prepare(
      `INSERT INTO agent_styles (agent_id, color, shape, look, pack_rev, pack_meta, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET color = excluded.color, shape = excluded.shape, look = excluded.look,
         ${options.pack ? 'pack_rev = excluded.pack_rev, pack_meta = excluded.pack_meta,' : ''} updated_at = excluded.updated_at`,
    )
    .run(agentId, full.color, full.shape, full.look, pack.rev, pack.meta, now)
}
export function storeAgent(sqlite: DatabaseSync, raw: AgentDetail): void {
  const agent = applyLifecycle(sqlite, withInheritance(sqlite, raw))
  sqlite
    .prepare(
      'INSERT INTO agents_proj (id, detail) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET detail = excluded.detail',
    )
    .run(agent.id, JSON.stringify(AgentDetailSchema.parse(agent)))
}
export async function reconcileAgents(
  ingest: Pick<Ingest, 'submit'>,
  details: AgentDetail[],
): Promise<void> {
  const agents = z.array(AgentDetailSchema).parse(details)
  await ingest.submit({
    source: 'agents',
    identity: randomUUID(),
    apply({ sqlite }) {
      return agents.flatMap((detail) => {
        const agent = applyLifecycle(
          sqlite,
          AgentDetailSchema.parse({
            ...detail,
            style: readAgentStyle(sqlite, detail.id) ?? detail.style,
          }),
        )
        const previous = readAgent(sqlite, agent.id)
        if (JSON.stringify(previous) === JSON.stringify(withInheritance(sqlite, agent))) return []
        storeAgent(sqlite, agent)
        const summary = AgentSummarySchema.parse(agent)
        return JSON.stringify(previous && AgentSummarySchema.parse(previous)) ===
          JSON.stringify(summary)
          ? []
          : [{ type: 'agent.updated' as const, data: summary }]
      })
    },
  })
}
export function updateProjectedAgent(sqlite: DatabaseSync, summary: AgentSummary): AgentSummary {
  let safe = AgentSummarySchema.parse({
    ...summary,
    style: readAgentStyle(sqlite, summary.id) ?? summary.style,
  })
  const previous = readAgent(sqlite, summary.id)
  if (previous)
    safe = AgentSummarySchema.parse(
      applyLifecycle(sqlite, { ...previous, ...safe, model: previous.model }),
    )
  if (previous)
    storeAgent(sqlite, {
      ...previous,
      ...safe,
      // A summary without a model keeps the detail's known one; a new model keeps its known source.
      model: safe.model
        ? { via: 'Hermes configuration', fallback: null, ...previous.model, ...safe.model }
        : previous.model,
    })
  return safe
}

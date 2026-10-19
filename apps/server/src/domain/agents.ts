import {
  AgentLookSchema,
  AgentStyleSchema,
  AgentSummarySchema,
  AvatarEyesSchema,
  AvatarRevSchema,
  type AvatarEyes,
  ShapeSchema,
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
import { parseAvatarEyes } from '../avatars/eyes.ts'
import { isCodingAgent } from '../runtimes/coding/store.ts'

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
  avatar_rev: AvatarRevSchema.nullable(),
  avatar_eyes: z.string().nullable(),
  updated_at: z.iso.datetime(),
})
/** A style with every optional part spelled out (absent look = bot, absent avatar = none), so styles compare equal. */
export function completeStyle(
  style: AgentStyle,
): AgentStyle & { look: AgentLook; avatar: string | null; avatarEyes: AvatarEyes | null } {
  return {
    ...style,
    look: style.look ?? 'bot',
    avatar: style.avatar ?? null,
    avatarEyes: style.avatarEyes ?? null,
  }
}
/**
 * What a client may put in a style it sends (create, import, patch): colour, shape and look. The picture has its own
 * routes and is never taken from a request body.
 */
export function clientStyle(style: AgentStyle): AgentStyle {
  return {
    color: style.color,
    shape: style.shape,
    look: style.look ?? 'bot',
    avatar: null,
    avatarEyes: null,
  }
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
export function readAgentStyle(sqlite: DatabaseSync, id: string): AgentStyle | null {
  const row = sqlite
    .prepare(
      'SELECT color, shape, look, avatar_rev, avatar_eyes, updated_at FROM agent_styles WHERE agent_id = ?',
    )
    .get(id)
  if (!row) return null
  const parsed = StyleRowSchema.parse(row)
  return AgentStyleSchema.parse({
    color: parsed.color,
    shape: parsed.shape,
    look: parsed.look,
    avatar: parsed.avatar_rev,
    avatarEyes: parseAvatarEyes(parsed.avatar_eyes),
  })
}
/**
 * Writes the style of an agent where it lives: a coding agent in its own row, a Hermes profile in `agent_styles`.
 * The picture revision and its eye marks are left alone unless `avatar` is given (only the picture routes do that).
 */
export function writeAgentStyle(
  sqlite: DatabaseSync,
  agentId: string,
  style: AgentStyle,
  now: string,
  options: { avatar?: boolean } = {},
): void {
  const full = completeStyle(style)
  // Validated on the way in as on the way out.
  const eyes = AvatarEyesSchema.nullable().parse(full.avatarEyes)
  const stored = eyes === null ? null : JSON.stringify(eyes)
  if (isCodingAgent(sqlite, agentId)) {
    sqlite
      .prepare(
        `UPDATE coding_agents SET color = ?, shape = ?, look = ?${options.avatar ? ', avatar_rev = ?, avatar_eyes = ?' : ''} WHERE id = ?`,
      )
      .run(
        ...[
          full.color,
          full.shape,
          full.look,
          ...(options.avatar ? [full.avatar, stored] : []),
          agentId,
        ],
      )
    return
  }
  sqlite
    .prepare(
      `INSERT INTO agent_styles (agent_id, color, shape, look, avatar_rev, avatar_eyes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET color = excluded.color, shape = excluded.shape, look = excluded.look,
         ${options.avatar ? 'avatar_rev = excluded.avatar_rev, avatar_eyes = excluded.avatar_eyes,' : ''} updated_at = excluded.updated_at`,
    )
    .run(agentId, full.color, full.shape, full.look, full.avatar, stored, now)
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

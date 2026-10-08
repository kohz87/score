import {
  AgentStyleSchema,
  AgentSummarySchema,
  ShapeSchema,
  type AgentStyle,
  type AgentSummary,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Ingest } from '../hub/ingest.ts'
import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { withInheritance } from './team-rules.ts'

const colors = ['#6B4EFF', '#19C39A', '#FFB61E', '#FF6B8A'] as const
export function defaultAgentStyle(index: number): AgentStyle {
  return {
    color: colors[index % colors.length]!,
    shape: ShapeSchema.options[index % ShapeSchema.options.length]!,
  }
}
const DetailRowSchema = z.object({ detail: z.string() })
const StyleRowSchema = AgentStyleSchema.extend({ updated_at: z.iso.datetime() })
export function readAgent(sqlite: DatabaseSync, id: string): AgentDetail | null {
  const row = sqlite.prepare('SELECT detail FROM agents_proj WHERE id = ?').get(id)
  return row ? AgentDetailSchema.parse(JSON.parse(DetailRowSchema.parse(row).detail)) : null
}
export function readAgentStyle(sqlite: DatabaseSync, id: string): AgentStyle | null {
  const row = sqlite
    .prepare('SELECT color, shape, updated_at FROM agent_styles WHERE agent_id = ?')
    .get(id)
  return row ? AgentStyleSchema.parse(StyleRowSchema.parse(row)) : null
}
export function storeAgent(sqlite: DatabaseSync, raw: AgentDetail): void {
  const agent = withInheritance(sqlite, raw)
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
        const agent = AgentDetailSchema.parse({
          ...detail,
          style: readAgentStyle(sqlite, detail.id) ?? detail.style,
        })
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
  const safe = AgentSummarySchema.parse({
    ...summary,
    style: readAgentStyle(sqlite, summary.id) ?? summary.style,
  })
  const previous = readAgent(sqlite, summary.id)
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

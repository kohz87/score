import type { DatabaseSync } from 'node:sqlite'
import {
  JOURNEY_MAX_EVENTS,
  JOURNEY_MAX_EVENTS_PER_AGENT,
  type Journey,
  type JourneyEvent,
} from '@score/contract'
import { z } from 'zod'

/** What Hermes knows for the Journey tab (read-only, from the adapter). No contents, only names and times. */
export interface JourneyFacts {
  /** Tasks Hermes marked completed, by assignee. */
  tasks: { agentId: string; at: number; id: string; title?: string }[]
  /** One entry per skill file changed. `name` is the skill's name only. */
  skills: { agentId: string; at: number; name: string }[]
  /** One entry per memory file changed; the file's contents are never read. */
  memory: { agentId: string; at: number }[]
  /** Fake adapter only: notes standing in for the vault index in demos. */
  notes?: { agentId: string; at: number; title: string; path: string }[]
}

const TitleRowSchema = z.object({ id: z.string(), title: z.string().nullable() })
const NoteRowSchema = z.object({
  path: z.string(),
  title: z.string(),
  mtime_ms: z.number(),
  last_author: z.string(),
})

/** Titles of tasks in Score's projection, by id. */
export function readTaskTitles(sqlite: DatabaseSync, ids: string[]): Map<string, string> {
  const titles = new Map<string, string>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200)
    const rows = sqlite
      .prepare(
        `SELECT id, json_extract(detail, '$.title') AS title FROM task_projections
         WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk)
    for (const row of rows) {
      const parsed = TitleRowSchema.parse(row)
      if (parsed.title) titles.set(parsed.id, parsed.title)
    }
  }
  return titles
}

/** Notes whose latest author is an agent, written in [from, to] (Score's vault index). */
export function readAgentNotes(sqlite: DatabaseSync, from: number, to: number) {
  return sqlite
    .prepare(
      `SELECT path, title, mtime_ms, last_author FROM knowledge_notes
       WHERE last_author LIKE 'agent:%' AND mtime_ms >= ? AND mtime_ms <= ?
       ORDER BY mtime_ms DESC LIMIT ?`,
    )
    .all(from, to, JOURNEY_MAX_EVENTS)
    .map((row) => NoteRowSchema.parse(row))
    .map((row) => ({
      agentId: row.last_author.slice('agent:'.length),
      at: row.mtime_ms,
      title: row.title,
      path: row.path,
    }))
}

const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text)

export function computeJourney(input: {
  from: string
  to: string
  window: { from: number; to: number }
  agentIds: string[]
  facts: JourneyFacts
  titles: Map<string, string>
  notes: { agentId: string; at: number; title: string; path: string }[]
}): Journey {
  const { window } = input
  const inWindow = (at: number) => at >= window.from && at <= window.to
  const byAgent = new Map<string, JourneyEvent[]>(input.agentIds.map((id) => [id, []]))
  const add = (agentId: string, at: number, event: Omit<JourneyEvent, 'at'>) => {
    if (!inWindow(at)) return
    byAgent.get(agentId)?.push({ at: new Date(at).toISOString(), ...event })
  }
  for (const task of input.facts.tasks)
    add(task.agentId, task.at, {
      kind: 'task_done',
      label: clip(task.title ?? input.titles.get(task.id) ?? `Task ${task.id}`),
      ref: task.id,
    })
  for (const note of [...(input.facts.notes ?? []), ...input.notes])
    add(note.agentId, note.at, { kind: 'note_written', label: clip(note.title), ref: note.path })
  for (const skill of input.facts.skills)
    add(skill.agentId, skill.at, { kind: 'skill_changed', label: clip(skill.name), ref: null })
  for (const memory of input.facts.memory)
    add(memory.agentId, memory.at, {
      kind: 'memory_changed',
      label: 'Memory file changed',
      ref: null,
    })

  let truncated = false
  const kept = input.agentIds.map((id) => {
    const events = byAgent.get(id)!.sort((a, b) => b.at.localeCompare(a.at))
    if (events.length > JOURNEY_MAX_EVENTS_PER_AGENT) truncated = true
    return { id, events: events.slice(0, JOURNEY_MAX_EVENTS_PER_AGENT) }
  })
  // The total bound drops the oldest events overall, so a busy agent cannot push the others out of view.
  const total = kept.reduce((sum, agent) => sum + agent.events.length, 0)
  if (total > JOURNEY_MAX_EVENTS) {
    truncated = true
    const newest = new Set(
      kept
        .flatMap((agent) => agent.events)
        .sort((x, y) => y.at.localeCompare(x.at))
        .slice(0, JOURNEY_MAX_EVENTS),
    )
    for (const agent of kept) agent.events = agent.events.filter((event) => newest.has(event))
  }
  return { from: input.from, to: input.to, truncated, agents: kept }
}

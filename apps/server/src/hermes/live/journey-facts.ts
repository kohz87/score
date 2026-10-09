import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { JourneyFacts } from '../../domain/journey.ts'
import { redact } from '../../redact.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly, readBatch } from './sqlite.ts'
import { skillFiles } from './profiles.ts'

const DoneRowSchema = z.object({
  id: z.string(),
  assignee: z.string().nullable(),
  completed_at: z.number(),
})
// Built-in memory lives in these two files; only their modified times are looked at.
const MEMORY_FILES = ['MEMORY.md', 'USER.md']

function modifiedAt(path: string): number | null {
  try {
    const stat = fs.lstatSync(path)
    return stat.isFile() ? stat.mtimeMs : null
  } catch {
    return null
  }
}

/** Read-only: finished Kanban tasks, skill files and memory file times per profile. Never any memory or skill text. */
export function readJourneyFacts(
  req: { from: number; to: number; agentIds: string[] },
  profileHome: (profile: string) => string | null,
  hermesHome?: string,
): JourneyFacts {
  const facts: JourneyFacts = { tasks: [], skills: [], memory: [] }
  const agents = new Set(req.agentIds.filter((id) => ProfileNameSchema.safeParse(id).success))
  try {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).kanbanDb)
    try {
      for (const row of readBatch(
        db,
        'tasks',
        DoneRowSchema,
        'WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5000',
        [],
      ).rows) {
        if (row.assignee && agents.has(row.assignee) && row.completed_at * 1000 >= req.from)
          facts.tasks.push({ agentId: row.assignee, at: row.completed_at * 1000, id: row.id })
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (!(error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)) throw error
  }
  for (const agentId of agents) {
    const home = profileHome(agentId)
    if (!home) continue
    for (const skill of skillFiles(home)) {
      const at = modifiedAt(skill.file)
      if (at !== null) facts.skills.push({ agentId, at, name: redact(skill.name) })
    }
    for (const name of MEMORY_FILES) {
      const at = modifiedAt(join(home, 'memories', name))
      if (at !== null) facts.memory.push({ agentId, at })
    }
  }
  return facts
}

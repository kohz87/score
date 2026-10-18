import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The agents the fake scenario starts with. Specs share one server and count its team, so a spec that adds an agent
// must remove it again (in `finally`, see long-description.spec.ts).
const SEEDED_AGENTS = new Set(['lead', 'builder', 'reviewer', 'designer'])

/** Ids of agents on the shared e2e server that no spec removed; empty when none, or when the server is not reachable. */
async function leftoverAgents(dir: string): Promise<string[]> {
  const state = join(dir, 'paired-session.json')
  if (!existsSync(state)) return []
  const cookies = JSON.parse(readFileSync(state, 'utf8')) as { name: string; value: string }[]
  const port = process.env.SCORE_WEB_PORT ?? '5173'
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    })
    if (!response.ok) return []
    const body = (await response.json()) as { items?: { id: string }[] }
    return (body.items ?? []).map((agent) => agent.id).filter((id) => !SEEDED_AGENTS.has(id))
  } catch {
    return []
  }
}

// Fails the run when a spec left an agent behind, then removes the run folder (server homes, logs, temp folders)
// that playwright.config.ts created under /tmp.
export default async function globalTeardown(): Promise<void> {
  const dir = process.env.SCORE_E2E_HOME
  if (!dir) return
  const left = await leftoverAgents(dir)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (left.length > 0)
    throw new Error(
      `Specs left agents on the shared e2e server: ${left.join(', ')}. Remove what a spec adds in a finally block.`,
    )
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import type { AgentDetail } from '@score/contract'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { deriveAgentStatusEvents } from '../../src/domain/agent-status.ts'
import { readAgent, storeAgent } from '../../src/domain/agents.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'

// The derivation only needs a projected agent and runs rows; take the agent from the fake adapter.
test('agent status follows its runs and is announced once per change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-agent-status-'))
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  try {
    const [first] = (await new FakePort(1).listAgentDetails()) as AgentDetail[]
    const agent: AgentDetail = { ...first!, id: 'builder', status: 'idle', activity: null }
    storeAgent(db.sqlite, agent)
    const run = (status: string) =>
      db.sqlite
        .prepare(
          `INSERT OR REPLACE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('r1', 'builder', 'score', ?, '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z')`,
        )
        .run(status)
    const draft = [{ type: 'run.updated' as const, data: { agentId: 'builder' } }] as never
    const derive = () => deriveAgentStatusEvents(db.sqlite, draft, { source: 'x', now: 'now' })
    run('running')
    expect(derive().map((event) => event.type)).toEqual(['agent.updated'])
    expect(readAgent(db.sqlite, 'builder')?.status).toBe('working')
    expect(derive()).toEqual([])
    run('waiting_for_approval')
    expect(readAgent(db.sqlite, 'builder') && derive()).toHaveLength(1)
    expect(readAgent(db.sqlite, 'builder')?.status).toBe('waiting')
    run('completed')
    expect(derive()).toHaveLength(1)
    expect(readAgent(db.sqlite, 'builder')).toMatchObject({ status: 'idle', activity: null })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

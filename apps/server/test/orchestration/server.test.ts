import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  OrchestrationCreatedSchema,
  OrchestrationSnapshotSchema,
} from '@score/contract'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { loadConfig, resolveJournalDir } from '../../src/config.ts'
import { startServer } from '../../src/start-server.ts'

// The whole stack in fake mode: start-server wiring, the scripted lead, real timers, the HTTP routes and the journal.
test('a started fake server runs an orchestration end to end with its scripted lead and a journal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'score-orc-server-'))
  const config = loadConfig({
    SCORE_HOME: home,
    SCORE_MODE: 'fake',
    SCORE_FAKE_SPEED: '100',
    SCORE_FAKE_LOOP: 'false',
  })
  const server = await startServer(config, {
    logger: false,
    listen: async (app) => void (await app.ready()),
  })
  try {
    const paired = await server.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: server.pairingToken },
    })
    const headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/orchestrations',
      headers,
      payload: {
        goal: 'Write the release notes',
        leadAgentId: 'lead',
        allowedAgents: ['builder', 'reviewer'],
        gatePolicy: 'none',
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
      },
    })
    expect(created.statusCode).toBe(201)
    const id = OrchestrationCreatedSchema.parse(created.json()).orchestration.id
    await vi.waitFor(
      async () => {
        const snap = OrchestrationSnapshotSchema.parse(
          (await server.app.inject({ url: `/api/orchestrations/${id}`, headers })).json(),
        )
        expect(snap.orchestration.status).toBe('succeeded')
      },
      { timeout: 20_000, interval: 200 },
    )
    const snap = OrchestrationSnapshotSchema.parse(
      (await server.app.inject({ url: `/api/orchestrations/${id}`, headers })).json(),
    )
    expect(snap.orchestration.stepsList.map((s) => s.status)).toEqual(['succeeded', 'succeeded'])
    // The fake adapter's journal lives in the home; a live one is outside it.
    expect(existsSync(join(resolveJournalDir(config), 'journal.ndjson'))).toBe(true)
    expect(resolveJournalDir({ ...config, mode: 'live' }, { XDG_STATE_HOME: '/state' })).toBe(
      '/state/score/execution-journal',
    )
    expect(resolveJournalDir({ ...config, mode: 'live', journalDir: '/j' }, {})).toBe('/j')
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
}, 40_000)

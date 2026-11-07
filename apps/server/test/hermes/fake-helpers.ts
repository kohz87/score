import { StreamEventSchema, type StreamEvent, type ApprovalChoice } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, vi } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createHermesPort, type HermesPort, type ObservationSink } from '../../src/hermes/index.ts'
import { scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import {
  createIngest,
  type Ingest,
  type IngestResult,
  type Observation,
} from '../../src/hub/ingest.ts'
import { FakeScheduler } from './fake-scheduler.ts'

export interface FakeState {
  directory: string
  db: ScoreDb
  ingest: Ingest
  port: HermesPort
  scheduler: FakeScheduler
  sink: ObservationSink
  observations: Observation[]
  results: IngestResult[]
  onError: ReturnType<typeof vi.fn<(error: unknown) => void>>
}

// The scenario's room is a room people talk in, so it routes with exchanges (11.11) and its messages emit job.upserted.
export const SCENARIO_JOB_EVENTS = 5

export function createFakeState(): FakeState {
  const directory = mkdtempSync(join(tmpdir(), 'score-fake-'))
  const db = openDatabase(join(directory, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  const ingest = createIngest(db, { clock: () => scheduler.now() })
  const observations: Observation[] = []
  const results: IngestResult[] = []
  const sink: ObservationSink = {
    async submit(observation) {
      observations.push(observation)
      const result = await ingest.submit(observation)
      results.push(result)
      return result
    },
  }
  const onError = vi.fn<(error: unknown) => void>()
  const port = createHermesPort(loadConfig({ SCORE_FAKE_LOOP: 'false' }), { scheduler, onError })
  return { directory, db, ingest, port, scheduler, sink, observations, results, onError }
}

export function installFakeHooks(
  assign: (state: FakeState) => void,
  current: () => FakeState,
): void {
  beforeEach(() => assign(createFakeState()))
  afterEach(async () => {
    const state = current()
    await state.port.stop()
    await state.ingest.close()
    state.db.close()
    rmSync(state.directory, { recursive: true, force: true })
  })
}

export function eventsFor(db: ScoreDb): StreamEvent[] {
  return db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) => StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) }))
}

export function deliverDecisionTo(
  port: HermesPort,
  req: { approvalId: string; choice: ApprovalChoice },
) {
  return port.deliverDecision({
    ...req,
    origin: 'score-run',
    profile: 'builder',
    runId: `fake-approval-run:${req.approvalId}`,
    requestId: req.approvalId,
  })
}

export async function playScenario(
  port: HermesPort,
  sink: ObservationSink,
  scheduler: FakeScheduler,
  ingest: Ingest,
): Promise<void> {
  await port.start(sink)
  await scheduler.advance(scenarioDuration)
  await ingest.drain()
}

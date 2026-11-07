import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Observation } from '../../hub/ingest.ts'
import { guardedUpsert } from '../../hub/projections.ts'
import { readRun, runDraft, runLifecycle } from '../../hermes/index.ts'
import type { RunTranslation } from './translate-types.ts'

export function setRun(
  sqlite: DatabaseSync,
  runId: string,
  now: string,
  values: Record<string, SQLInputValue>,
): boolean {
  const row = readRun(sqlite, runId)
  return (
    guardedUpsert(sqlite, {
      table: 'runs',
      key: { id: runId },
      stateColumn: 'status',
      lifecycle: runLifecycle,
      versionColumn: 'version',
      values: {
        profile: row.profile,
        origin: row.origin,
        started_at: row.started_at,
        status: row.status,
        version: row.version + 1,
        updated_at: now,
        ...values,
      },
    }) === 'applied'
  )
}

/** The run left the queue: its process started. */
export function runningObservation(translation: RunTranslation): Observation {
  const { runId, agentId } = translation
  return {
    source: `coding:${agentId}`,
    identity: `coding:${runId}:running`,
    apply({ sqlite, now }) {
      return setRun(sqlite, runId, now, { status: 'running' }) ? [runDraft(sqlite, runId)] : []
    },
  }
}

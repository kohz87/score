import { z } from 'zod'
import { AgentOperationSchema, type AgentOperation } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import {
  installProfileOperationMethods,
  type ProfileOperationsPublicMethods,
} from './profiles-runtime.ts'
import { OperationRow } from './profiles-support.ts'
import type { ProfileImportStore } from './profile-imports.ts'

const ProfileOperationsCore = class ProfileOperations {
  private readonly flights = new Map<string, Promise<void>>()
  private closed = false
  constructor(
    private readonly db: ScoreDb,
    private readonly ingest: Ingest,
    private readonly port: HermesPort,
    private readonly clock = Date.now,
    private readonly imports?: ProfileImportStore,
  ) {}

  get(id: string): AgentOperation {
    const row = this.db.sqlite.prepare('SELECT * FROM profile_operations WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that operation.')
    return AgentOperationSchema.parse(JSON.parse(OperationRow.parse(row).operation))
  }
  private pending(name: string) {
    const count = (sql: string) =>
      z.object({ count: z.int().nonnegative() }).parse(this.db.sqlite.prepare(sql).get(name)).count
    return {
      activeRuns: count(
        `SELECT (SELECT count(*) FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval')) + (SELECT count(*) FROM command_intents WHERE kind = 'start_run' AND json_extract(payload, '$.profile') = ?1 AND state IN ('pending','sent','unknown')) AS count`,
      ),
      queuedTurns: count(
        "SELECT count(*) AS count FROM message_runs WHERE agent_id = ? AND state IN ('pending','active')",
      ),
      pendingApprovals: count(
        "SELECT count(*) AS count FROM approvals WHERE profile = ? AND status = 'pending'",
      ),
      assignments: count(
        `SELECT count(*) AS count FROM task_projections WHERE (json_extract(detail, '$.assignee') = ? OR json_extract(detail, '$.reviewer') = ?1) AND json_extract(detail, '$."hermesStatus"') NOT IN ('done', 'archived')`,
      ),
      disposition:
        'Active work must finish first. Remove room membership and lead selection; keep history with removed attribution.',
    }
  }
}

installProfileOperationMethods(ProfileOperationsCore.prototype)

export type ProfileOperations = InstanceType<typeof ProfileOperationsCore> &
  ProfileOperationsPublicMethods

type ProfileOperationsConstructor = {
  new (
    db: ScoreDb,
    ingest: Ingest,
    port: HermesPort,
    clock?: () => number,
    imports?: ProfileImportStore,
  ): ProfileOperations
  readonly prototype: ProfileOperations
}

export const ProfileOperations = ProfileOperationsCore as unknown as ProfileOperationsConstructor

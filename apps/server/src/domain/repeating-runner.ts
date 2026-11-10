import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { ScoreDb } from '../db/index.ts'
import type { Orchestrator } from './orchestration/executor.ts'
import {
  cannotFire,
  dueFires,
  noteFailed,
  noteStarted,
  recordFire,
  scheduledRun,
} from './recipe-schedules.ts'
import { advanceTarget, postOutput, targets } from './routine-targets.ts'

/**
 * Decision 183: what Score does on its own every tick: start the recipe fires that are due (or record the ones it found
 * too late as missed), and post repeating jobs' new results into their chats.
 */
export function repeatingRunner(deps: {
  orchestrator: Pick<Orchestrator, 'createWorkflowRun'>
  db: ScoreDb
  ingest: Ingest
  port: Pick<HermesPort, 'listAgents' | 'readRoutineOutputs'>
  clock: () => number
}): {
  tick: () => Promise<void>
  fire: (
    workflowId: string,
    at: string,
  ) => Promise<{ outcome: 'started' } | { outcome: 'failed'; reason: string }>
} {
  const { orchestrator, db, ingest, port } = deps
  const now = () => new Date(deps.clock()).toISOString()
  /**
   * Starts one run of a recipe's schedule. The fire is claimed first (the schedule moves on and records `started`), so a
   * crash or a second tick never starts it twice; what the run turned out to be is filled in after.
   */
  async function fire(
    workflowId: string,
    at: string,
  ): Promise<{ outcome: 'started' } | { outcome: 'failed'; reason: string }> {
    const refusal = db.tx((sqlite) => {
      const why = cannotFire(sqlite, workflowId)
      recordFire(
        sqlite,
        workflowId,
        why ? { at, outcome: 'failed', reason: why } : { at, outcome: 'started' },
        now(),
      )
      return why
    })
    if (refusal) return { outcome: 'failed', reason: refusal }
    try {
      const body = db.read((sqlite) => scheduledRun(sqlite, workflowId, now()))
      const created = await orchestrator.createWorkflowRun(body, await port.listAgents())
      db.tx((sqlite) => noteStarted(sqlite, workflowId, at, created.run.briefId))
      return { outcome: 'started' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The run couldn’t start.'
      db.tx((sqlite) => noteFailed(sqlite, workflowId, at, reason))
      return { outcome: 'failed', reason }
    }
  }

  async function tick(): Promise<void> {
    for (const due of db.read((sqlite) => dueFires(sqlite, now()))) {
      if (due.late)
        db.tx((sqlite) =>
          recordFire(
            sqlite,
            due.workflowId,
            { at: due.at, outcome: 'missed', missed: due.missed },
            now(),
          ),
        )
      else await fire(due.workflowId, due.at)
    }
    for (const target of db.read((sqlite) => targets(sqlite))) {
      const outputs = await port.readRoutineOutputs(target.routineId, target.since).catch(() => [])
      for (const output of outputs)
        await ingest.submit({
          source: 'routines',
          identity: `routine-output:${target.routineId}:${output.file}`,
          apply: ({ sqlite, now: stamp }) => {
            const drafts = postOutput(sqlite, target, output, stamp)
            // The next look starts here: a backlog longer than one page is worked through in order.
            advanceTarget(sqlite, target.routineId, output.at)
            return drafts
          },
        })
    }
  }

  return { tick, fire }
}

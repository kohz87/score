import {
  AgentAssignedSchema,
  RecipeScheduleRequestSchema,
  RecipeSchedulesResponseSchema,
  WorkflowDefinitionSchema,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import {
  recipeSchedule,
  recipeSchedules,
  removeRecipeSchedule,
  setRecipeSchedule,
} from '../domain/recipe-schedules.ts'
import { repeatingRunner } from '../domain/repeating-runner.ts'
import { repeatingJob } from '../domain/routine-targets.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'

const WorkflowParams = z.object({ workflowId: z.string().min(1).max(100) })
const AgentParams = z.object({ agentId: z.string().min(1).max(256) })
/** How often Score looks for due recipe fires and new repeating-job results. */
export const REPEATING_TICK_MS = 30_000

/**
 * Decision 183 (docs/API-CONTRACT.md §22): recipe schedules, the fires Score starts, and repeating jobs' results posted
 * into their chats. `every` sets the timer; tests drive `tick()` themselves.
 */
export function registerRepeatingRoutes(
  app: FastifyInstance,
  deps: {
    orchestrator: Pick<Orchestrator, 'createWorkflowRun'>
    db: ScoreDb
    ingest: Ingest
    port: Pick<HermesPort, 'listAgents' | 'listRoutines' | 'readRoutineOutputs'>
    clock?: () => number
    every?: number | null
  },
): { tick: () => Promise<void> } {
  const { db, port } = deps
  const clock = deps.clock ?? Date.now
  const { tick, fire } = repeatingRunner({ ...deps, clock })
  const now = () => new Date(clock()).toISOString()
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  app.get('/api/recipe-schedules', async () =>
    RecipeSchedulesResponseSchema.parse({ items: db.read((sqlite) => recipeSchedules(sqlite)) }),
  )
  app.put('/api/workflows/:workflowId/schedule', mutation, async (request) => {
    const { workflowId } = WorkflowParams.parse(request.params)
    const req = RecipeScheduleRequestSchema.parse(request.body)
    return db.tx((sqlite) => setRecipeSchedule(sqlite, workflowId, req, now()))
  })
  app.delete('/api/workflows/:workflowId/schedule', mutation, async (request) => {
    const { workflowId } = WorkflowParams.parse(request.params)
    db.tx((sqlite) => removeRecipeSchedule(sqlite, workflowId))
    return { workflowId }
  })
  app.post('/api/workflows/:workflowId/schedule/run', mutation, async (request) => {
    const { workflowId } = WorkflowParams.parse(request.params)
    if (!db.read((sqlite) => recipeSchedule(sqlite, workflowId)))
      throw new HttpError(404, 'not_found', 'This recipe doesn’t repeat.')
    const fired = await fire(workflowId, now())
    if (fired.outcome === 'failed') throw new HttpError(409, 'conflict', fired.reason)
    return db.read((sqlite) => recipeSchedule(sqlite, workflowId))
  })

  app.get('/api/agents/:agentId/assigned', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    const listed = await port.listRoutines(agentId).catch(() => [])
    return AgentAssignedSchema.parse({
      agentId,
      repeating: db.read((sqlite) => listed.map((one) => repeatingJob(sqlite, one))),
      recipeSteps: db.read((sqlite) => recipeStepsOf(sqlite, agentId)),
    })
  })

  const every = deps.every === undefined ? REPEATING_TICK_MS : deps.every
  if (every !== null) {
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void tick()
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }, every)
    timer.unref?.()
    app.addHook('onClose', async () => clearInterval(timer))
  }
  return { tick }
}

/** The steps that name the agent in recipes that repeat (their latest version): what's assigned to it on a schedule. */
function recipeStepsOf(
  sqlite: DatabaseSync,
  agentId: string,
): { workflowId: string; recipeName: string; stepLabel: string; schedule: string | null }[] {
  const rows = sqlite
    .prepare(
      `SELECT d.id, d.name, v.definition, s.schedule FROM workflow_definitions d
       JOIN workflow_versions v ON v.workflow_id = d.id
         AND v.version = (SELECT MAX(version) FROM workflow_versions WHERE workflow_id = d.id)
       JOIN recipe_schedules s ON s.workflow_id = d.id AND s.enabled = 1
       WHERE d.archived_at IS NULL ORDER BY d.name`,
    )
    .all() as { id: string; name: string; definition: string; schedule: string | null }[]
  return rows.flatMap((row) => {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
    if (!parsed.success) return []
    return parsed.data.nodes
      .filter((node) => node.kind === 'agent' && node.agentId === agentId)
      .map((node) => ({
        workflowId: row.id,
        recipeName: row.name,
        stepLabel: node.label,
        schedule: row.schedule,
      }))
  })
}

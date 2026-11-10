import type { FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { HermesPort } from './hermes/index.ts'
import type { BridgeDeps } from './hermes/index.ts'
import type { Orchestrator } from './domain/orchestration/executor.ts'
import type { SecurityPassword } from './auth/security-password.ts'
import type { TaskHolds } from './http/task-holds.ts'
import type { BriefControl } from './http/brief-control.ts'
import { defaultRootPolicy } from './workspace/policy.ts'
import { resolveHermesHome } from './hermes/index.ts'
import { createPlanStarter } from './http/plan-start.ts'
import { registerAgentContextRoutes } from './http/agent-context.ts'
import { registerAgentHistoryRoutes } from './http/agent-history.ts'
import { registerAgentPauseRoutes } from './http/agent-pause.ts'
import { registerAttemptRoutes } from './http/attempts.ts'
import { registerBriefRoutes } from './http/briefs.ts'
import { registerNowRoutes } from './http/now.ts'
import { registerOrchestrationRoutes } from './http/orchestrations.ts'
import { registerTeamPauseRoutes } from './http/team-pause.ts'
import { registerWatchRoutes } from './http/watch.ts'
import { registerWorkflowRoutes } from './http/workflows.ts'
import { registerRepeatingRoutes } from './http/repeating.ts'

export interface WorkRouteDeps {
  app: FastifyInstance
  port: HermesPort
  db: ScoreDb | undefined
  ingest: Ingest | undefined
  config: Config
  clock: (() => number) | undefined
  bridge: BridgeDeps | undefined
  orchestrator: Orchestrator | undefined
  holds: TaskHolds
  control: BriefControl
  dispatch: () => Promise<void>
  getSecurityPassword: () => SecurityPassword | undefined
}

export function registerWorkRoutes({
  app,
  port,
  db,
  ingest,
  config,
  clock,
  bridge,
  orchestrator,
  holds,
  control,
  dispatch,
  getSecurityPassword,
}: WorkRouteDeps): void {
  if (!db || !ingest) return
  const plans = createPlanStarter({ port, db, ingest })
  app.decorate('recoverPlanStarts', () => plans.recover())
  registerBriefRoutes(app, {
    db,
    plans,
    ...(clock ? { clock } : {}),
  })
  if (orchestrator) {
    registerOrchestrationRoutes(app, {
      orchestrator,
      db,
      port,
      ...(clock ? { clock } : {}),
      // 3.13: a job with a check runs a command on this computer: the folder is checked and a fresh second factor asked.
      checkPolicy: (({ home, hermesHome }: Pick<Config, 'home' | 'hermesHome'>) =>
        defaultRootPolicy([home, resolveHermesHome(hermesHome), resolveHermesHome()]))(config),
      hostEnrolled: () => getSecurityPassword()?.hostIssued() ?? false,
    })
    registerWorkflowRoutes(app, {
      orchestrator,
      db,
      port,
      ...(ingest ? { ingest } : {}),
      ...(clock ? { clock } : {}),
    })
    // Decision 183: recipe schedules Score runs, and repeating jobs' results posted into their chats.
    if (ingest)
      registerRepeatingRoutes(app, { orchestrator, db, ingest, port, ...(clock ? { clock } : {}) })
  }
  registerTeamPauseRoutes(app, {
    db,
    ingest,
    control,
    holds,
    dispatch,
    ...(orchestrator ? { orchestrator } : {}),
    ...(clock ? { clock } : {}),
  })
  registerWatchRoutes(app, { port, db, ingest })
  registerAgentHistoryRoutes(app, { port, db })
  registerAttemptRoutes(app, { db })
  registerAgentContextRoutes(app, { port, db })
  registerAgentPauseRoutes(app, {
    db,
    ingest,
    port,
    holds,
    dispatch,
    ...(orchestrator ? { orchestrator } : {}),
    ...(clock ? { clock } : {}),
  })
  registerNowRoutes(app, {
    port,
    db,
    ingest,
    disabled: () => bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
    ...(clock ? { clock } : {}),
  })
}

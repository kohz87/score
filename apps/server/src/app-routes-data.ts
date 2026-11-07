import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { HermesPort } from './hermes/index.ts'
import type { KnowledgeVault } from './knowledge/vault.ts'
import type { MediaStore } from './media/store.ts'
import type { SecurityPassword } from './auth/security-password.ts'
import type { AgentWorkspaces } from './workspace/agent-workspace.ts'
import { KnowledgeAgentApi } from './knowledge/agent-api.ts'
import { ZipStaging } from './knowledge/staging.ts'
import { McpAccessStore } from './mcp/access.ts'
import { registerAgentRoutes } from './http/agents.ts'
import { registerAgentTabRoutes } from './http/agent-tabs.ts'
import { registerCurrencyRoutes } from './http/currency.ts'
import { registerKnowledgeAgentRoutes } from './http/knowledge-agents.ts'
import { registerKnowledgeRoutes } from './http/knowledge.ts'
import { registerMcpAccessRoutes } from './http/mcp-access.ts'
import { registerProfileRoutes } from './http/profiles.ts'
import { registerReportRoutes } from './http/reports.ts'
import { registerRoutineRoutes } from './http/routines.ts'
import { registerRulesRoutes } from './http/rules.ts'
import { registerRunsOnRoutes } from './http/agent-runs-on.ts'
import { registerSettingsRoutes } from './http/settings.ts'
import { registerTaskRoutes } from './http/tasks.ts'
import { registerThemeRoutes } from './http/themes.ts'
import { registerWorkspaceRoutes } from './http/workspace.ts'

export interface DataRouteDeps {
  app: FastifyInstance
  port: HermesPort
  db: ScoreDb | undefined
  ingest: Ingest | undefined
  config: Config
  clock: (() => number) | undefined
  mediaStore: MediaStore | undefined
  knowledge: KnowledgeVault | undefined
  workspaces: AgentWorkspaces
  ownsHome: boolean
  getSecurityPassword: () => SecurityPassword | undefined
}

export function registerDataRoutes({
  app,
  port,
  db,
  ingest,
  config,
  clock,
  mediaStore,
  knowledge,
  workspaces,
  ownsHome,
  getSecurityPassword,
}: DataRouteDeps): void {
  registerTaskRoutes(app, port, ingest, db, clock)
  registerReportRoutes(app, port, db, clock)
  registerAgentRoutes(app, port, ingest, db, clock)
  if (db && ingest)
    registerProfileRoutes(app, {
      db,
      ingest,
      port,
      config,
      ...(clock ? { clock } : {}),
    })
  registerAgentTabRoutes(app, port, ingest, db, clock)
  registerRunsOnRoutes(app, port, db, clock)
  registerWorkspaceRoutes(app, port, config, undefined, workspaces)
  if (knowledge) {
    registerKnowledgeRoutes(
      app,
      knowledge,
      mediaStore,
      new ZipStaging(join(config.home, 'knowledge-staging'), clock, undefined, ownsHome),
    )
    if (db) registerKnowledgeAgentRoutes(app, new KnowledgeAgentApi(knowledge, db, clock))
  }
  if (db)
    registerMcpAccessRoutes(app, {
      access: new McpAccessStore(db, clock),
      bridgePort: config.remote?.bridgePort,
      db,
      port,
    })
  registerRoutineRoutes(app, port, db, clock)
  registerSettingsRoutes(app, port, db, clock, getSecurityPassword)
  if (db)
    registerThemeRoutes(app, {
      db,
      home: config.home,
      ...(ingest ? { ingest } : {}),
      ...(clock ? { clock } : {}),
    })
  registerCurrencyRoutes(app, db)
  registerRulesRoutes(app, port, ingest, db, clock)
}

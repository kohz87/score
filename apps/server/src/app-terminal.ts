import type { FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { ScoreDb } from './db/index.ts'
import type { HermesPort } from './hermes/index.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'
import type { SecurityPassword } from './auth/security-password.ts'
import type { BuildAppOptions } from './app-options.ts'
import { HttpError } from './errors.ts'
import { isCodingAgent } from './runtimes/coding/store.ts'
import { lifecycleOf } from './domain/agent-lifecycle.ts'
import { allowedOriginsFor } from './auth/csrf.ts'
import { registerTerminalRoutes } from './http/terminal.ts'

export interface TerminalDeps {
  app: FastifyInstance
  config: Config
  db: ScoreDb | undefined
  port: HermesPort
  coding: CodingRuntime | undefined
  securityPassword: SecurityPassword | undefined
  https: BuildAppOptions['https']
  terminal: BuildAppOptions['terminal']
}

export function registerTerminal({
  app,
  config,
  db,
  port,
  coding,
  securityPassword,
  https,
  terminal,
}: TerminalDeps): string | null {
  let terminalUnavailable: string | null = null
  if (config.terminal && !https) {
    // Plain-HTTP listeners (local mode) never get a shell: a terminal needs a TLS connection.
    terminalUnavailable = 'needs HTTPS (remote mode with a certificate)'
  } else if (config.terminal) {
    try {
      app.decorate(
        'terminals',
        registerTerminalRoutes(app, {
          origins: allowedOriginsFor(config),
          hostEnrolled: () => securityPassword?.hostIssued() ?? false,
          // 3.11.0: a live session runs the agent's own CLI (Hermes or a coding CLI), fresh, as this user.
          agentRun: async (agentId) => {
            if (db && isCodingAgent(db.sqlite, agentId)) {
              const command = await coding?.interactiveCommand(agentId)
              if (!command)
                throw new HttpError(
                  409,
                  'conflict',
                  'This agent’s CLI or its workspace isn’t available on this computer.',
                )
              return command
            }
            const life = db ? lifecycleOf(db.sqlite, agentId) : undefined
            if (life && life.state !== 'ready')
              throw new HttpError(409, 'conflict', 'This agent isn’t ready for a live session.')
            const command = port.interactiveCommand?.(agentId) ?? null
            if (!command) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
            return command
          },
          ...terminal,
        }),
      )
    } catch (error) {
      terminalUnavailable = 'node-pty not built'
      app.log.error(
        { err: error },
        'SCORE_TERMINAL=1 but the terminal module (node-pty) could not load: the terminal stays off. See docs/SETUP.md.',
      )
    }
  }
  return terminalUnavailable
}

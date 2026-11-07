import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import { createAgentDirectory, withAgentDirectory } from './http/agent-directory.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'
import { hermesPortOf, withCodingAgents } from './runtimes/coding/port.ts'
import type { HermesPort } from './hermes/index.ts'

/**
 * The port the routes see. Live Hermes reads cost seconds per profile, so pages read Hermes agents from Score's
 * projection (5.23); that directory only knows Hermes profiles, so it wraps the Hermes part and the coding agents are
 * added on top of it (otherwise its list hid the coding agents from every live route: rooms, orchestration preflight
 * and create). Coding agents join the team under the same port: rooms, Now, Flow and Reports see one list of agents.
 */
export function routePort(options: {
  live: boolean
  port: HermesPort
  coding?: CodingRuntime | undefined
  db?: ScoreDb | undefined
  ingest?: Ingest | undefined
  warn?: (error: unknown) => void
}): HermesPort {
  const { coding, db, ingest } = options
  let port = options.port
  if (options.live && db && ingest) {
    const hermes = hermesPortOf(port)
    port = withAgentDirectory(hermes, createAgentDirectory(hermes, db, ingest, options.warn))
  }
  if (db && ingest && coding) port = withCodingAgents(port, coding)
  return port
}

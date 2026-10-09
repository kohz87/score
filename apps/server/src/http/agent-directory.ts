import {
  AgentDetailSchema,
  AgentSummarySchema,
  type AgentDetail,
  type ModelSettings,
} from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { readAgent, readAgentNames, reconcileAgents, storeAgent } from '../domain/agents.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const FRESH_MS = 15_000

/**
 * Agents for page loads (5.23): reading them from Hermes runs several CLI processes per profile (seconds each), so
 * pages answer from Score's projection and a background read refreshes it (agent.updated tells browsers what
 * changed). Only a cold server with an empty projection waits for Hermes. Callers that just changed an agent ask
 * for `fresh`.
 */
export function createAgentDirectory(
  port: Pick<HermesPort, 'listAgentDetails'>,
  db: ScoreDb,
  ingest: Pick<Ingest, 'submit'>,
  onError: (error: unknown) => void = () => undefined,
  clock: () => number = Date.now,
) {
  let refreshedAt = 0
  let known: string[] | null = null
  let flight: Promise<AgentDetail[]> | undefined
  // Counts agent-affecting writes (bumped when each finishes). A read is trusted only if no write finished while it
  // ran, and a read that must see a write never joins one that started before it.
  let writes = 0
  let flightWrites = 0

  function noteWrite(): void {
    writes++
  }

  function refresh(): Promise<AgentDetail[]> {
    if (flight && flightWrites === writes) return flight
    const started = writes
    flightWrites = started
    const mine = (async () => {
      const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
      // A save finished while Hermes was being read: this answer may predate it, so it must not overwrite the
      // projection (the save's own record, or the read that follows it, is newer).
      if (started === writes) {
        await reconcileAgents(ingest, details)
        known = details.map((agent) => agent.id)
        refreshedAt = clock()
      }
      return details
    })().finally(() => {
      if (flight === mine) flight = undefined
    })
    flight = mine
    return mine
  }

  /** The projected agents in Hermes's last known order (or Score's, before the first read). */
  function projected(): AgentDetail[] {
    return db.read((sqlite) => {
      const ids = known ?? readAgentNames(sqlite).map((agent) => agent.id)
      return ids.flatMap((id) => {
        const agent = readAgent(sqlite, id)
        return agent ? [AgentDetailSchema.parse(agent)] : []
      })
    })
  }

  /**
   * Records a model Score just wrote, so the save answers at once; a background read then confirms it from Hermes
   * (re-reading costs another Hermes process, seconds on a busy machine).
   */
  async function recordModel(agentId: string, model: string, provider: string | undefined) {
    await ingest.submit({
      source: 'agent-model',
      identity: `agent-model:${agentId}:${clock()}:${model}`,
      apply({ sqlite }) {
        const previous = readAgent(sqlite, agentId)
        if (!previous) return []
        const agent = AgentDetailSchema.parse({
          ...previous,
          model: {
            id: model,
            label: model,
            via: provider ?? previous.model?.via ?? 'Hermes configuration',
            fallback: previous.model?.fallback ?? null,
          },
        })
        storeAgent(sqlite, agent)
        return [{ type: 'agent.updated' as const, data: AgentSummarySchema.parse(agent) }]
      },
    })
    void refresh().catch(onError)
  }

  /** Records the fallback chain Score just wrote, as the agent card's "falls back to" text. */
  async function recordFallback(agentId: string, fallback: string | null) {
    await ingest.submit({
      source: 'agent-fallback',
      identity: `agent-fallback:${agentId}:${clock()}`,
      apply({ sqlite }) {
        const previous = readAgent(sqlite, agentId)
        if (!previous?.model || previous.model.fallback === fallback) return []
        const agent = AgentDetailSchema.parse({
          ...previous,
          model: { ...previous.model, fallback },
        })
        storeAgent(sqlite, agent)
        return [{ type: 'agent.updated' as const, data: AgentSummarySchema.parse(agent) }]
      },
    })
  }

  return {
    recordModel,
    recordFallback,
    noteWrite,
    async details({ fresh = false }: { fresh?: boolean } = {}): Promise<AgentDetail[]> {
      if (fresh) return refresh()
      const cached = projected()
      if (cached.length === 0) return refresh()
      if (clock() - refreshedAt > FRESH_MS) void refresh().catch(onError)
      return cached
    },
    refresh,
  }
}
export type AgentDirectory = ReturnType<typeof createAgentDirectory>

// Port calls that can change what an agent's detail shows: the next agent read after one of them goes to Hermes.
const AGENT_WRITES = new Set([
  'setAgentModel',
  'setPluginEnabled',
  'setSkillEnabled',
  'setToolEnabled',
  'installSkill',
  'updateApprovals',
  'writeAgentFile',
  'describeProfile',
  'profileStep',
  'applyConfig',
  'addLocalProvider',
  'addProviderKey',
  'connectProvider',
])

/**
 * The port routes see: agent reads come from the directory; the first agent read after an agent-affecting write is
 * fresh, so a save answers with what Hermes now holds.
 */
export function withAgentDirectory(port: HermesPort, directory: AgentDirectory): HermesPort {
  let dirty = false
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === 'listAgentDetails')
        return async () => {
          const fresh = dirty
          dirty = false
          return directory.details({ fresh })
        }
      if (property === 'listAgents')
        return async () => {
          const fresh = dirty
          dirty = false
          return (await directory.details({ fresh })).map((agent) =>
            AgentSummarySchema.parse(agent),
          )
        }
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      if (property === 'setAgentModel')
        return async (agentId: string, req: { model: string; provider?: string }) => {
          await method.apply(target, [agentId, req])
          directory.noteWrite()
          await directory.recordModel(agentId, req.model, req.provider)
        }
      if (property === 'updateModelSettings')
        return async (agentId: string, req: unknown) => {
          const settings = (await method.apply(target, [agentId, req])) as ModelSettings
          // A refresh that started before this write must not count as fresh. Not a dirty write: the response is the fresh state, so no Hermes re-read is needed for the card.
          const text = settings.fallbacks.map((ref) => ref.model).join(', then ')
          directory.noteWrite()
          await directory.recordFallback(agentId, text || null)
          return settings
        }
      if (typeof property === 'string' && AGENT_WRITES.has(property))
        return (...args: unknown[]) => {
          // Before and after: a read that runs while the write is in flight must not count as the fresh one.
          dirty = true
          const result = method.apply(target, args)
          if (!(result instanceof Promise)) {
            directory.noteWrite()
            return result
          }
          return result.finally(() => {
            dirty = true
            directory.noteWrite()
          })
        }
      return method.bind(target)
    },
  })
}

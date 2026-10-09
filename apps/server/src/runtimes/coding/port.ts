import { HttpError } from '../../errors.ts'
import type { HermesPort } from '../../hermes/index.ts'
import type { CodingRuntime } from './service.ts'

// Methods whose first argument is an agent id and that mean something only for a Hermes profile.
const PROFILE_ONLY = new Set([
  'readAgentFile',
  'writeAgentFile',
  'setAgentModel',
  'readModelSettings',
  'updateModelSettings',
  'listSkills',
  'installSkill',
  'setSkillEnabled',
  'listMemory',
  'listAgentChannels',
  'addMemory',
  'deleteMemory',
  'setToolEnabled',
  'setWorkspaceCwd',
  'readAgentTodos',
  'listPlugins',
  'setPluginEnabled',
  'readApprovals',
  'updateApprovals',
  'listRoutines',
  'createRoutine',
  'readOutsideSession',
])

const unsupported = () =>
  new HttpError(
    409,
    'unsupported',
    'Coding agents do not have this (it is a Hermes profile feature)',
  )

/**
 * The port the routes see: Hermes's agents plus the coding agents, and turns for a coding agent go to its CLI runtime.
 * Everything else is Hermes's, untouched. Kanban tasks stay Hermes-only in v1 (review 2026-10-09, 7.2 #6).
 */
export function withCodingAgents(port: HermesPort, coding: CodingRuntime): HermesPort {
  const idOf = (value: unknown) => (typeof value === 'string' ? coding.isCodingAgent(value) : false)
  return new Proxy(port, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      const call = (...args: unknown[]) => method.apply(target, args)
      switch (property) {
        case 'listAgentDetails':
          return async () => [...((await call()) as unknown[]), ...(await coding.details())]
        case 'listAgents':
          return async () => [
            ...((await call()) as unknown[]),
            ...(await coding.details()).map(
              ({
                id,
                name,
                role,
                style,
                status,
                activity,
                model,
                served,
                runtime,
                runtimeNote,
              }) => ({
                id,
                name,
                role,
                style,
                status,
                activity,
                model: model ? { id: model.id, label: model.label } : null,
                served,
                runtime,
                runtimeNote,
              }),
            ),
          ]
        case 'startRun':
          return (req: { agentId: string }) =>
            idOf(req.agentId)
              ? coding.startRun(req as Parameters<typeof coding.startRun>[0])
              : call(req)
        case 'stopRun':
          return (req: { agentId: string }) =>
            idOf(req.agentId)
              ? coding.stopRun(req as Parameters<typeof coding.stopRun>[0])
              : call(req)
        case 'rewindSession':
          // A coding agent has no rewindable history: the room hides the messages in Score, and the agent's CLI
          // session for this room is dropped so its next turn starts fresh instead of remembering what was undone.
          return async (req: { agentId: string; sessionId: string; dryRun?: boolean }) => {
            if (!idOf(req.agentId)) return call(req)
            if (!req.dryRun) coding.forgetRoomSession(req.sessionId, req.agentId)
            return { status: 'skipped', reason: 'no_session' }
          }
        case 'readWorkspaceConfig':
          return async (agentId: string) =>
            idOf(agentId)
              ? {
                  cwd: coding.agents().find((agent) => agent.id === agentId)?.workspace ?? null,
                  backend: null,
                }
              : call(agentId)
        case 'createTask':
        case 'patchTask':
          return async (...args: unknown[]) => {
            const body = (property === 'createTask' ? args[0] : args[1]) as
              { assignee?: string; reviewer?: string } | undefined
            if (idOf(body?.assignee) || idOf(body?.reviewer))
              throw new HttpError(
                422,
                'unsupported',
                'Coding agents take room work only for now, not Kanban tasks',
              )
            return method.apply(target, args)
          }
        case 'reportFacts':
          return async (req: { from: number; to: number; agentIds: string[] }) => {
            const hermes = req.agentIds.filter((id) => !idOf(id))
            return call({ ...req, agentIds: hermes })
          }
        case 'sessionCosts':
          return async (req: { sinceMs: number; agentIds: string[] }) =>
            call({ ...req, agentIds: req.agentIds.filter((id) => !idOf(id)) })
        case 'reportHistoryRows':
          return async (now: number, agentIds: string[]) =>
            call(
              now,
              agentIds.filter((id) => !idOf(id)),
            )
        case 'listOutsideSessions':
          return async (agentIds: string[]) => call(agentIds.filter((id) => !idOf(id)))
        default:
          if (typeof property === 'string' && PROFILE_ONLY.has(property))
            return async (...args: unknown[]) => {
              if (idOf(args[0])) throw unsupported()
              return method.apply(target, args)
            }
          return method.bind(target)
      }
    },
  })
}

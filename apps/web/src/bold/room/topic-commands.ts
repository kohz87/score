import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { JobSchema, RoomSchema, type AgentSummary, type Job, type Room } from '@score/contract'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import type { SlashCommand } from '../../routes/chat/composer-model.ts'
import { agentDisplayName, canTalkTo } from '../bold-agents.ts'
import { changeCachedJob } from './room-queries.ts'
import { useStartJob, type StartJobOptions } from '../BoldStartJob.tsx'
import { setRoomWorkspace, useSharedWorkspaces } from '../workspaces-queries.ts'

/** The chat commands (3.22.0). Each one calls a route that exists; the palette lists them with the rest. */
export const TOPIC_COMMANDS: SlashCommand[] = [
  { name: 'new', usage: '/new <title>', description: 'Start a new topic in this chat' },
  { name: 'rename', usage: '/rename <title>', description: 'Rename the current topic' },
  { name: 'done', usage: '/done', description: 'Close the current topic' },
  {
    name: 'reopen',
    usage: '/reopen',
    description: 'Reopen the current (or latest finished) topic',
  },
  { name: 'lead', usage: '/lead @agent', description: 'Make someone the owner of this chat' },
  { name: 'add', usage: '/add @agent', description: 'Add someone to this chat' },
  { name: 'remove', usage: '/remove @agent', description: 'Take someone out of this chat' },
  {
    name: 'run',
    usage: '/run [recipe]',
    description: 'Start a run in this chat (lead decides, or a saved recipe by name)',
  },
  {
    name: 'workspace',
    usage: '/workspace <name>',
    description: 'Set the folder this chat works in (none clears it)',
  },
]

const post = (path: string, body: object = {}) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify(body),
  })

function problem(error: unknown): Error {
  if (error instanceof Error && !(error instanceof ApiError)) return error
  if (error instanceof ApiError && error.message) return new Error(error.message)
  return new Error('That didn’t work. Try again.')
}

function findAgent(agents: AgentSummary[], word: string, needsToTalk: boolean): AgentSummary {
  const key = word.replace(/^@/, '').toLowerCase()
  const agent = agents.find(
    (item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key,
  )
  if (!agent) throw new Error(`There is no agent called ${word}. Type @ to pick one.`)
  if (needsToTalk && !canTalkTo(agent))
    throw new Error(`${agentDisplayName(agent)} can’t take messages right now.`)
  return agent
}

export type TopicCommandContext = {
  room: Room
  agents: AgentSummary[]
  jobs: Job[]
  /** The topic the composer sends to: picked, else the newest open one, else the general conversation. */
  current: Job | undefined
  workspaces: { id: string; name: string }[]
  /** A started, closed or reopened topic goes into the cached job list before it is picked. */
  queryClient: QueryClient
  /** Makes a topic the current one (the address names it). */
  pick: (jobId: string | null) => void
  /** A small line in the stream for what changed. */
  say: (text: string) => void
  /** Opens Start a job for this chat (`/run`). Missing where the dialog isn't mounted. */
  startRun?: (options: StartJobOptions) => void
}

/** Runs one command and says what it did in the stream; throws an Error with plain words when it can't. */
export async function runTopicCommand(
  name: string,
  args: string,
  ctx: TopicCommandContext,
): Promise<void> {
  const { room, agents, jobs, current, pick, say } = ctx
  const topic = current && !current.isDefault ? current : undefined
  try {
    if (name === 'new') {
      const title = args.trim()
      if (!title) throw new Error('Give the topic a title: /new <title>')
      const job = JobSchema.parse(
        await post(`rooms/${encodeURIComponent(room.id)}/jobs`, { title: title.slice(0, 200) }),
      )
      changeCachedJob(ctx.queryClient, job, 'upsert')
      pick(job.id)
      say(`You started the topic “${job.title}”`)
    } else if (name === 'rename') {
      const title = args.trim()
      if (!topic) throw new Error('There is no open topic to rename. Start one with /new <title>.')
      if (!title) throw new Error('Give the new title: /rename <title>')
      const job = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(topic.id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ title: title.slice(0, 200) }),
        }),
      )
      say(`You renamed the topic “${topic.title}” to “${job.title}”`)
    } else if (name === 'done') {
      if (!topic) throw new Error('There is no open topic to close.')
      const closed = JobSchema.parse(await post(`jobs/${encodeURIComponent(topic.id)}/close`))
      changeCachedJob(ctx.queryClient, closed, 'upsert')
      pick(null)
      say(`You closed the topic “${topic.title}”`)
    } else if (name === 'reopen') {
      const target =
        topic && (topic.state === 'done' || topic.state === 'closed')
          ? topic
          : [...jobs]
              .filter((job) => !job.isDefault && (job.state === 'done' || job.state === 'closed'))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      if (!target) throw new Error('No finished topic to reopen.')
      const reopened = JobSchema.parse(await post(`jobs/${encodeURIComponent(target.id)}/reopen`))
      changeCachedJob(ctx.queryClient, reopened, 'upsert')
      pick(reopened.id)
      say(`You reopened the topic “${target.title}”`)
    } else if (name === 'lead' || name === 'add' || name === 'remove') {
      const word = args.trim().split(/\s+/)[0] ?? ''
      if (!word) throw new Error(`Say who: /${name} @agent`)
      const agent = findAgent(agents, word, name !== 'remove')
      const who = agentDisplayName(agent)
      let body: object
      let line: string
      if (name === 'lead') {
        if (!room.members.includes(agent.id))
          throw new Error(`${who} isn’t in this chat. Add them first with /add @${agent.id}.`)
        body = { leadAgentId: agent.id }
        line = `You made ${who} the owner`
      } else if (name === 'add') {
        if (room.members.includes(agent.id)) throw new Error(`${who} is already in this chat.`)
        body = { members: [...room.members, agent.id] }
        line = `You added ${who}`
      } else {
        if (!room.members.includes(agent.id)) throw new Error(`${who} isn’t in this chat.`)
        if (room.members.length <= 1)
          throw new Error(`${who} is the only one in this chat. A chat needs at least one member.`)
        if (room.leadAgentId === agent.id)
          throw new Error(`${who} is the owner. Make someone else the owner first with /lead.`)
        body = { members: room.members.filter((id) => id !== agent.id) }
        line = `You took ${who} out`
      }
      RoomSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(room.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      )
      say(line)
    } else if (name === 'run') {
      // A direct chat holds no run: runs belong to a group chat (a team or a chat of several agents).
      if (room.kind === 'direct') throw new Error('Runs start in a group chat.')
      if (!ctx.startRun) throw new Error('Start a job isn’t available here.')
      const recipeName = args.trim()
      ctx.startRun({ roomId: room.id, ...(recipeName ? { recipeName } : {}) })
    } else if (name === 'workspace') {
      const word = args.trim()
      if (!word) throw new Error('Name the workspace: /workspace <name>, or /workspace none')
      if (word.toLowerCase() === 'none') {
        await setRoomWorkspace(room.id, null)
        say('You cleared the chat’s workspace')
        return
      }
      const found = ctx.workspaces.find((item) => item.name.toLowerCase() === word.toLowerCase())
      if (!found)
        throw new Error(
          ctx.workspaces.length
            ? `No workspace called “${word}”. Yours: ${ctx.workspaces.map((item) => item.name).join(', ')}.`
            : 'You have no workspaces yet. Make one in Settings › Workspaces.',
        )
      await setRoomWorkspace(room.id, found.id)
      say(`You set the workspace to ${found.name}`)
    }
  } catch (error) {
    throw problem(error)
  }
}

/** The hook the room uses: the palette items and a runner bound to the open chat. */
export function useTopicCommands(
  ctx: Omit<TopicCommandContext, 'workspaces' | 'queryClient' | 'startRun'>,
) {
  const workspaces = useSharedWorkspaces().data ?? []
  const queryClient = useQueryClient()
  const startJob = useStartJob()
  return {
    items: TOPIC_COMMANDS,
    run: (name: string, args: string) =>
      runTopicCommand(name, args, {
        ...ctx,
        workspaces,
        queryClient,
        startRun: startJob?.openStartJob,
      }),
  }
}

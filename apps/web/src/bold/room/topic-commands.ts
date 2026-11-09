import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { JobSchema, RoomSchema, type AgentSummary, type Job, type Room } from '@score/contract'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import type { SlashCommand } from '../../routes/chat/composer-model.ts'
import { agentDisplayName, canTalkTo } from '../bold-agents.ts'
import { changeCachedJob } from './room-queries.ts'
import { activeJobs } from './room-model.ts'
import type { BusyStart } from './BusyDialog.tsx'
import { useStartJob, type StartJobOptions } from '../BoldStartJob.tsx'
import { setRoomWorkspace, useSharedWorkspaces } from '../workspaces-queries.ts'
import { agentSubagentsQuery, putJobSubagents } from '../subagents/subagent-queries.ts'

/** The chat commands (3.22.0). Each one calls a route that exists; the palette lists them with the rest. */
export const TOPIC_COMMANDS: SlashCommand[] = [
  { name: 'rename', usage: '/rename <title>', description: 'Rename the current job' },
  { name: 'done', usage: '/done', description: 'Close the current job' },
  {
    name: 'reopen',
    usage: '/reopen',
    description: 'Reopen the current (or latest finished) job',
  },
  { name: 'lead', usage: '/lead @agent', description: 'Make someone the owner of this chat' },
  {
    name: 'subagents',
    usage: '/subagents 2',
    insert: '/subagents 2',
    key: 'subagents-2',
    description: 'At most 2 at once, for this job',
  },
  {
    name: 'subagents',
    usage: '/subagents off',
    insert: '/subagents off',
    key: 'subagents-off',
    description: 'None in this job',
  },
  {
    name: 'subagents',
    usage: '/subagents on',
    insert: '/subagents on',
    key: 'subagents-on',
    description: "Back to the agent's limit (4)",
    note: "The agent's limit is the most you can set here. Change it in its settings.",
  },
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

/** A one-to-one still starts new chats; DirectChat lists and runs this itself. */
export const DIRECT_NEW_COMMAND: SlashCommand = {
  name: 'new',
  usage: '/new <title>',
  description: 'Start a new chat',
}

/** Typed but not offered in the palette: a chat does one job at a time, so `/new` has nothing to start (3.28.0). */
export const TYPED_ONLY_COMMANDS = ['new']

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
  /** The job the composer sends to: picked, else the active one, else the chat's own thread. */
  current: Job | undefined
  workspaces: { id: string; name: string }[]
  /** A started, closed or reopened topic goes into the cached job list before it is picked. */
  queryClient: QueryClient
  /** Makes a topic the current one (the address names it). */
  pick: (jobId: string | null) => void
  /** A small line in the stream for what changed. */
  say: (text: string, action?: { label: string; run: () => void }) => void
  /** Loads a slash command into the composer (the note's "Change"). */
  offer?: (command: string) => void
  /** Opens Start a job for this chat (`/run`). Missing where the dialog isn't mounted. */
  startRun?: (options: StartJobOptions) => void
  /** The chat already has a job running: the busy dialog asks what to do (3.28.0). Without it `/run` just starts. */
  onBusy?: (busy: BusyStart, options: StartJobOptions) => void
}

/** Runs one command and says what it did in the stream; throws an Error with plain words when it can't. */
export async function runTopicCommand(
  name: string,
  args: string,
  ctx: TopicCommandContext,
): Promise<void> {
  const { room, agents, jobs, current, pick, say } = ctx
  const topic = current && !current.isDefault ? current : undefined
  // In a group chat the visible word is "job"; a one-to-one keeps "chat" (3.28.0).
  const noun = room.kind === 'direct' ? 'chat' : 'job'
  try {
    if (name === 'new') {
      throw new Error(
        'A chat does one job at a time: start one with /run, or Stop the current job first.',
      )
    } else if (name === 'rename') {
      const title = args.trim()
      if (!topic)
        throw new Error(
          `There is no open ${noun} to rename.${room.kind === 'direct' ? '' : ' Start one with /run.'}`,
        )
      if (!title) throw new Error('Give the new title: /rename <title>')
      const job = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(topic.id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ title: title.slice(0, 200) }),
        }),
      )
      say(`You renamed the ${noun} “${topic.title}” to “${job.title}”`)
    } else if (name === 'done') {
      if (!topic) throw new Error(`There is no open ${noun} to close.`)
      const closed = JobSchema.parse(await post(`jobs/${encodeURIComponent(topic.id)}/close`))
      changeCachedJob(ctx.queryClient, closed, 'upsert')
      pick(null)
      say(`You closed the ${noun} “${topic.title}”`)
    } else if (name === 'reopen') {
      const target =
        topic && (topic.state === 'done' || topic.state === 'closed')
          ? topic
          : [...jobs]
              .filter((job) => !job.isDefault && (job.state === 'done' || job.state === 'closed'))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      if (!target) throw new Error(`No finished ${noun} to reopen.`)
      const reopened = JobSchema.parse(await post(`jobs/${encodeURIComponent(target.id)}/reopen`))
      changeCachedJob(ctx.queryClient, reopened, 'upsert')
      pick(reopened.id)
      say(`You reopened the ${noun} “${target.title}”`)
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
    } else if (name === 'subagents') {
      const change = { label: 'Change', run: () => ctx.offer?.('subagents') }
      if (!topic) {
        say('There’s no job to set subagents for. Start one first.')
        return
      }
      const limits = topic.subagents
      if (!limits) {
        say('This job doesn’t have subagents.')
        return
      }
      const agentId = topic.activeAgents[0] ?? topic.holderAgentId ?? room.leadAgentId ?? undefined
      const agentSub = agentId
        ? await ctx.queryClient.fetchQuery(agentSubagentsQuery(agentId))
        : null
      const ceiling = agentSub?.control === 'limits' ? agentSub.maxConcurrent : null
      const used = `${limits.used} of ${limits.maxTotal} used in this job`
      const state = !limits.enabled
        ? 'Subagents are off for this job.'
        : limits.maxConcurrent === null
          ? `Subagents are on, up to ${ceiling ?? 'the agent’s limit'} at once (${used}).`
          : `Subagents are set to at most ${limits.maxConcurrent} for this job (${used}).`
      const argument = args.trim().toLowerCase()
      if (!argument) {
        say(state, change)
        return
      }
      if (argument === 'off') {
        const updated = await putJobSubagents(topic.id, { enabled: false })
        changeCachedJob(ctx.queryClient, updated, 'upsert')
        say('Subagents are off for this job.', change)
        return
      }
      if (argument === 'on') {
        const updated = await putJobSubagents(topic.id, {
          enabled: true,
          maxConcurrent: null,
        })
        changeCachedJob(ctx.queryClient, updated, 'upsert')
        say(
          ceiling === null
            ? 'Subagents are on, at the agent’s limit.'
            : `Subagents are on, up to the agent’s limit (${ceiling}).`,
          change,
        )
        return
      }
      if (!/^\d+$/.test(argument)) {
        say('Use /subagents off, /subagents on, or /subagents 2.')
        return
      }
      const count = Number(argument)
      if (!Number.isInteger(count) || count < 1) {
        say('Use a whole number from 1 to the agent’s limit.')
        return
      }
      if (agentSub && agentSub.control !== 'limits') {
        const name = agents.find((agent) => agent.id === agentId)?.name ?? agentId ?? 'This agent'
        say(`${name} decides how many run at once. Use /subagents off or /subagents on.`)
        return
      }
      if (ceiling !== null && count > ceiling) {
        say(
          `The agent’s limit is ${ceiling}, so that’s the most you can set here. Nothing was sent.`,
        )
        return
      }
      const updated = await putJobSubagents(topic.id, {
        enabled: true,
        maxConcurrent: count,
      })
      changeCachedJob(ctx.queryClient, updated, 'upsert')
      say(`Subagents set to at most ${count} for this job.`, change)
    } else if (name === 'run') {
      // A direct chat holds no run: runs belong to a group chat (a team or a chat of several agents).
      if (room.kind === 'direct') throw new Error('Runs start in a group chat.')
      if (!ctx.startRun) throw new Error('Start a job isn’t available here.')
      const recipeName = args.trim()
      const options: StartJobOptions = { roomId: room.id, ...(recipeName ? { recipeName } : {}) }
      // One job per chat: with one running, the person decides first (stop it, or start this elsewhere).
      const running = activeJobs(jobs)[0]
      if (running && ctx.onBusy) {
        ctx.onBusy(
          {
            running: { id: running.id, title: running.title },
            chatName: room.name,
            starting: recipeName ? `run “${recipeName}”` : 'a new run',
          },
          options,
        )
        return
      }
      ctx.startRun(options)
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
    typedOnly: TYPED_ONLY_COMMANDS,
    run: (name: string, args: string) =>
      runTopicCommand(name, args, {
        ...ctx,
        workspaces,
        queryClient,
        startRun: startJob?.openStartJob,
      }),
  }
}

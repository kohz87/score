import type { QueryClient } from '@tanstack/react-query'
import type { AgentSummary, Job, Room } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import { changeCachedJob } from '../room/room-queries.ts'
import { DIRECT_NEW_COMMAND, useTopicCommands } from '../room/topic-commands.ts'
import { createDirectChat } from './direct-queries.ts'

/** Only these topic commands make sense in a one-to-one: no owner, members or room workspace to change (/run is listed to say runs start in a group chat). */
const DIRECT_COMMANDS = new Set(['new', 'rename', 'done', 'reopen', 'run'])

/** The composer's `/` palette in a one-to-one, including its own way to start a chat. */
export function useDirectTopicCommands({
  agent,
  room,
  agents,
  chats,
  current,
  pick,
  say,
  queryClient,
}: {
  agent: AgentSummary
  room: Room
  agents: AgentSummary[]
  chats: Job[]
  current: Job | undefined
  pick: (jobId: string | null) => void
  say: (text: string) => void
  queryClient: QueryClient
}) {
  const base = useTopicCommands({ room, agents, jobs: chats, current, pick, say })
  return {
    items: [DIRECT_NEW_COMMAND, ...base.items]
      .filter((item) => DIRECT_COMMANDS.has(item.name))
      .map((item) =>
        item.name === 'new'
          ? {
              ...item,
              usage: '/new [title]',
              description: `Start a new chat with ${agentDisplayName(agent)}`,
            }
          : item,
      ),
    run: async (name: string, args: string) => {
      if (name !== 'new') return base.run(name, args)
      // A one-to-one's new chat comes from the agent route (it is called "New chat" when no title is given).
      const chat = await createDirectChat(agent.id, args.trim().slice(0, 200) || undefined)
      changeCachedJob(queryClient, chat, 'upsert')
      pick(chat.id)
      say(`You started the chat “${chat.title}”`)
    },
  }
}

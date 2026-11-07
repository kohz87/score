import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
// The parts below load these through their own imports; keep the entry's original cascade order.
import '../../components/agent-glyph.css'
import '../../routes/team/workspace.css'
import '../../routes/chat/chat.css'
import '../room/bold-thread.css'
import '../room/bold-room.css'
import './bold-direct.css'
import { agentDisplayName } from '../bold-agents.ts'
import { DirectChatBar } from './DirectChatBar.tsx'
import type { DirectChatProps } from './direct-chat-props.ts'
import { directChatsQuery } from './direct-queries.ts'
import { LoadedDirect } from './LoadedDirect.tsx'
import { NoRoomYet } from './NoRoomYet.tsx'

/**
 * A one-to-one in the chat view (3.22.0). The agent's chats are the topics of one conversation, read together with the
 * group chat's merged stream; the header, composer with its `/` palette and the context bar are the group chat's.
 */
export function DirectChat(props: DirectChatProps) {
  const { agent } = props
  const definition = useMemo(() => directChatsQuery(agent.id), [agent.id])
  const direct = useStreamQuery(definition)
  const room = direct.data?.room ?? null
  const bar = <DirectChatBar {...props} />
  if (direct.status === 'pending' && !direct.data)
    return (
      <>
        {bar}
        <p className="bold-stream-note bold-dm-status" role="status">
          Opening your chats with {agentDisplayName(agent)}…
        </p>
      </>
    )
  if (direct.status === 'error')
    return (
      <>
        {bar}
        <p className="bold-stream-note bold-dm-status" role="alert">
          Couldn’t load your chats with {agentDisplayName(agent)}. Try again.
        </p>
      </>
    )
  if (!room) return <NoRoomYet {...props} bar={bar} />
  return <LoadedDirect key={room.id} {...props} room={room} chats={direct.data?.chats ?? []} />
}

import type { AgentSummary, Job, OutsideSession } from '@score/contract'
import type { RefObject } from 'react'
import { agentDisplayName } from './bold-agents.ts'
import { ChatInfoButton, ChatMeta } from './chats/ChatHeader.tsx'
import { DirectViewerSheet, ViewerSheet } from './chats/ViewerSheet.tsx'
import { DirectChat } from './direct/DirectChat.tsx'
import { BoldTeamRoom } from './room/BoldTeamRoom.tsx'

export function BoldRoomChatColumn({
  directMode,
  directAgent,
  agents,
  agentsPending,
  phone,
  infoShown,
  sheetOpen,
  viewerOpen,
  currentJob,
  phoneOpenRef,
  onToggleInfo,
  onChatInfo,
  onTeamChatInfo,
  onBackToChats,
  onOpenElsewhere,
  onOpenThread,
  onShowGraph,
  onCloseViewer,
}: {
  directMode: boolean
  directAgent: AgentSummary | undefined
  agents: AgentSummary[]
  agentsPending: boolean
  phone: boolean
  infoShown: boolean
  sheetOpen: boolean
  viewerOpen: boolean
  currentJob: Job | undefined
  phoneOpenRef: RefObject<HTMLButtonElement | null>
  onToggleInfo: () => void
  onChatInfo: () => void
  onTeamChatInfo: () => void
  onBackToChats: () => void
  onOpenElsewhere: (session: OutsideSession) => void
  onOpenThread: (jobId: string | null) => void
  onShowGraph: (jobId: string) => void
  onCloseViewer: () => void
}) {
  // The phone viewer sits after the section, not inside it: the section is inert while the side sheet is open (review P1).
  return (
    <>
      <section
        className="roomcol"
        aria-label={directAgent ? `Chat with ${agentDisplayName(directAgent)}` : 'Team room'}
        inert={phone && sheetOpen}
      >
        {directMode ? (
          directAgent ? (
            <DirectChat
              key={directAgent.id}
              agent={directAgent}
              agents={agents}
              phone={phone}
              infoOpen={infoShown}
              onToggleInfo={onToggleInfo}
              infoRef={phoneOpenRef}
              infoExpanded={sheetOpen}
              onChatInfo={onChatInfo}
              onBackToChats={onBackToChats}
            />
          ) : (
            <p className="bold-stream-note bold-dm-status" role="status">
              {agentsPending ? 'Opening your chats…' : 'That agent isn’t on your team any more.'}
            </p>
          )
        ) : (
          <BoldTeamRoom
            agents={agents}
            phone={phone}
            onOpenElsewhere={onOpenElsewhere}
            onOpenThread={onOpenThread}
            onShowGraph={onShowGraph}
            externalDeletedNotice
            chatMeta={(room) => <ChatMeta room={room} agents={agents} />}
            chatAction={() => <ChatInfoButton open={infoShown} onToggle={onToggleInfo} />}
            infoRef={phoneOpenRef}
            infoExpanded={sheetOpen}
            onChatInfo={onTeamChatInfo}
            onBackToChats={onBackToChats}
          />
        )}
        {viewerOpen &&
          !phone &&
          (directMode ? (
            directAgent && (
              <DirectViewerSheet agents={agents} agentId={directAgent.id} phone={false} />
            )
          ) : (
            <ViewerSheet agents={agents} phone={false} fallbackJob={currentJob} />
          ))}
      </section>
      {viewerOpen &&
        phone &&
        (directMode ? (
          directAgent && (
            <DirectViewerSheet
              agents={agents}
              agentId={directAgent.id}
              phone
              onBackToChat={onCloseViewer}
            />
          )
        ) : (
          <ViewerSheet
            agents={agents}
            phone
            fallbackJob={currentJob}
            onBackToChat={onCloseViewer}
          />
        ))}
    </>
  )
}

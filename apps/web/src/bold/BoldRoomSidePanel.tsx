import type { AgentSummary, Job, OutsideSession, Room } from '@score/contract'
import type { RefObject } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { CloseIcon } from './BoldIcons.tsx'
import { agentMood } from './bold-agents.ts'
import type { SideMode } from './bold-room-types.ts'
import { ChatInfo } from './chats/ChatInfo.tsx'
import { TopicGraph } from './chats/TopicGraph.tsx'
import { DirectInfo } from './direct/DirectInfo.tsx'
import { BoldElsewhere } from './room/BoldElsewhere.tsx'

export function BoldRoomSidePanel({
  directMode,
  directAgent,
  agents,
  chatId,
  phone,
  sheetOpen,
  panelClosed,
  sideRef,
  phoneCloseRef,
  shownMode,
  elsewhereAgent,
  label,
  graphJob,
  filesVisible,
  openGroup,
  openGroupJobs,
  everyoneOpen,
  topicsLanding,
  elsewhere,
  onChoose,
  onCloseSheet,
  onNavigate,
  onBroughtIntoJob,
}: {
  directMode: boolean
  directAgent: AgentSummary | undefined
  agents: AgentSummary[]
  chatId: string | null
  phone: boolean
  sheetOpen: boolean
  panelClosed: boolean
  sideRef: RefObject<HTMLElement | null>
  phoneCloseRef: RefObject<HTMLButtonElement | null>
  shownMode: SideMode
  elsewhereAgent: AgentSummary | undefined
  label: string
  graphJob: Job | undefined
  filesVisible: boolean
  openGroup: Room | null
  openGroupJobs: Job[] | undefined
  everyoneOpen: boolean
  topicsLanding: number
  elsewhere: OutsideSession | null
  onChoose: (mode: SideMode) => void
  onCloseSheet: () => void
  onNavigate: () => void
  onBroughtIntoJob: (jobId: string) => void
}) {
  return (
    <div
      className={`bold-sidecol${phone && sheetOpen ? ' open' : ''}`}
      hidden={(phone && !sheetOpen) || panelClosed}
    >
      <aside
        className="side"
        id="bold-side-panel"
        ref={sideRef}
        aria-label="Side panel"
        aria-modal={phone && sheetOpen ? true : undefined}
      >
        <div className="sidehead">
          {shownMode === 'elsewhere' && !directMode && elsewhereAgent ? (
            <span className="bold-elsewhere-label">
              <AgentGlyph
                agent={elsewhereAgent}
                size="sm"
                bare
                decorative
                mood={agentMood(elsewhereAgent)}
              />{' '}
              {label}
            </span>
          ) : (
            <div className="bold-side-tabs" role="tablist" aria-label="Panel">
              <button
                type="button"
                role="tab"
                aria-selected={directMode || shownMode === 'info'}
                className={directMode || shownMode === 'info' ? 'on' : undefined}
                onClick={() => (directMode ? undefined : onChoose('info'))}
              >
                Info
              </button>
              {graphJob && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={shownMode === 'graph'}
                  className={shownMode === 'graph' ? 'on' : undefined}
                  onClick={() => onChoose('graph')}
                >
                  Graph
                </button>
              )}
            </div>
          )}
          {phone && (
            <button
              ref={phoneCloseRef}
              type="button"
              className="icon-btn sm sideclose"
              aria-label="Close side panel"
              onClick={onCloseSheet}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {directMode ? (
          directAgent ? (
            <DirectInfo
              agent={directAgent}
              agents={agents}
              chatId={chatId}
              visible={filesVisible}
              onNavigate={onNavigate}
            />
          ) : (
            <ChatInfo
              room={null}
              agents={agents}
              jobs={[]}
              everyone={false}
              phone={phone}
              onNavigate={onNavigate}
            />
          )
        ) : shownMode === 'graph' && graphJob ? (
          <TopicGraph key={graphJob.id} job={graphJob} />
        ) : shownMode === 'info' ? (
          <ChatInfo
            room={openGroup}
            agents={agents}
            jobs={openGroupJobs ?? []}
            everyone={everyoneOpen}
            phone={phone}
            visible={filesVisible}
            openTopics={topicsLanding}
            onNavigate={onNavigate}
          />
        ) : shownMode === 'elsewhere' && elsewhere ? (
          <BoldElsewhere
            key={`${elsewhere.agentId}:${elsewhere.id}`}
            session={elsewhere}
            agents={agents}
            onBroughtIn={onBroughtIntoJob}
          />
        ) : null}
      </aside>
    </div>
  )
}

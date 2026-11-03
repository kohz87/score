import type { AgentSummary } from '@score/contract'
import type { ReactNode, RefObject } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood, agentNameColor, agentStateLabel } from '../bold-agents.ts'
import { ScreenIcon } from '../BoldIcons.tsx'
import { boldAgentScreenLink } from '../bold-links.ts'
import { ChatInfoButton } from '../chats/ChatHeader.tsx'
import { PrivacyNote } from './direct-parts.tsx'

/** A Hermes agent's Bot Desktop; coding agents have no screen to show. */
export function hasScreen(agent: AgentSummary): boolean {
  return Boolean(agent.served && (!agent.runtime || agent.runtime === 'hermes'))
}

/** "Look at its screen" (3.12.1): a shortcut to the agent's Bot Desktop, as on its page. */
export function ScreenShortcut({ agent }: { agent: AgentSummary }) {
  if (!hasScreen(agent)) return null
  return (
    <Link
      className="icon-btn sm bold-dm-screen"
      to={boldAgentScreenLink(agent.id)}
      aria-label={`Look at ${agentDisplayName(agent)}'s screen`}
      title={`Look at ${agentDisplayName(agent)}'s screen`}
    >
      <ScreenIcon />
    </Link>
  )
}

/** "Direct · working": what kind of chat this is and what the agent is doing now. */
function DirectLine({ agent }: { agent: AgentSummary }) {
  return (
    <span className="bold-chat-meta bold-dm-line">
      Direct · <span className="bold-dm-status-word">{agentStateLabel(agent)}</span>
      {' · '}
      <PrivacyNote agent={agent} />
    </span>
  )
}

/** The chat bar of a one-to-one (board 18): the agent's glyph and name, "Direct · status", the menus, Chat info. */
export function DirectBar({
  agent,
  menu,
  infoOpen,
  onToggleInfo,
}: {
  agent: AgentSummary
  menu?: ReactNode
  infoOpen: boolean
  onToggleInfo: () => void
}) {
  return (
    <div className="roomhead bold-chat-bar bold-dm-bar">
      <div className="bold-chat-bar-id">
        <div className="bold-chat-bar-name">
          <AgentGlyph agent={agent} size="sm" bare decorative mood={agentMood(agent)} />
          <h1 className="roomtitle bold-dm-title" style={{ color: agentNameColor(agent) }}>
            {agentDisplayName(agent)}
          </h1>
        </div>
        <DirectLine agent={agent} />
      </div>
      <span className="bold-room-grow" aria-hidden="true" />
      <ScreenShortcut agent={agent} />
      {menu}
      <ChatInfoButton open={infoOpen} onToggle={onToggleInfo} />
    </div>
  )
}

/** The phone's chat bar: the same Back and Info as a group chat, with the agent's name and Direct line. */
export function DirectPhoneBar({
  agent,
  topic,
  menu,
  infoRef,
  infoExpanded,
  onBack,
  onInfo,
}: {
  agent: AgentSummary
  /** The open chat's title and state, when it is a named chat (as a group chat shows its open topic). */
  topic?: string | undefined
  menu?: ReactNode
  infoRef?: RefObject<HTMLButtonElement | null> | undefined
  infoExpanded?: boolean | undefined
  onBack: () => void
  onInfo: () => void
}) {
  return (
    <div className="bold-chat-phone-bar bold-dm-bar">
      <button
        type="button"
        className="bold-chat-round small"
        aria-label="Back to chats"
        onClick={onBack}
      >
        ‹
      </button>
      <div className="bold-chat-phone-id">
        <strong data-phone-chat-title tabIndex={-1}>
          {agentDisplayName(agent)}
        </strong>
        <span>
          {topic ? `${topic} · ` : ''}Direct · {agentStateLabel(agent)}
        </span>
        <PrivacyNote agent={agent} />
      </div>
      <ScreenShortcut agent={agent} />
      {menu}
      <button
        ref={infoRef}
        type="button"
        className="bold-chat-round small"
        aria-label="Chat info"
        aria-expanded={infoExpanded ?? false}
        aria-controls="bold-side-panel"
        onClick={onInfo}
      >
        i
      </button>
    </div>
  )
}

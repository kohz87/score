import type { AgentSummary, Message } from '@score/contract'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { nestSubagentCalls } from '../../components/subagent.ts'
import { StatusLine } from '../../live/StatusLine.tsx'
import { useStatusLine } from '../../live/use-activity.ts'
import { agentTextColor } from './agent-text-color.ts'
import { MessageActions } from './MessageActions.tsx'
import { Part, partKey } from './MessageParts.tsx'
import { StopReply } from './MessageStopReply.tsx'
import type { Expansion, ToolPart } from './message-item-types.ts'
import { speedLine } from './speed-format.ts'
import type { WorkspaceTarget } from './workspace-link.ts'

export function MessageItem({
  message,
  agents,
  readOnly = false,
  bold = false,
  importedLabel,
  versionControl,
  workspaceLinkFor,
  workspacePrepare,
  approvalPointerIds,
}: {
  message: Message
  agents: AgentSummary[]
  /** Where `workspace://` links open (the bold room: the job's Workbench); classic keeps the Team › Workspace link. */
  workspaceLinkFor?: (target: WorkspaceTarget) => string
  /** Refresh a stale Results read before the bold room opens a workspace link. */
  workspacePrepare?: (target: WorkspaceTarget) => Promise<void>
  /** A message of a previous version (PLAN 5.33): greyed, no actions. */
  readOnly?: boolean
  /** The bold shell's presentation (PLAN 11.7): a shared part is labelled with the agent it came from. */
  bold?: boolean
  /** Where an imported copy came from ("Telegram"); such messages cannot be edited or retried. */
  importedLabel?: string | undefined
  /** The `‹ 2 / 3 ›` control of an edited message (PLAN 5.35), shown in the action row. */
  versionControl?: ReactNode
  /** Pending approvals that live in the bold strip: their message part is a pointer, not a second decision card. */
  approvalPointerIds?: ReadonlySet<string>
}) {
  const imported = message.id.startsWith('import:')
  const author = message.author
  const agent =
    author.kind === 'agent' ? agents.find((item) => item.id === author.agentId) : undefined
  const you = author.kind === 'you'
  const shared = message.parts.find((part) => part.kind === 'shared')
  const sharedAgent =
    shared && shared.kind === 'shared'
      ? agents.find((item) => item.id === shared.from.agentId)
      : undefined
  const name = you ? 'You' : (agent?.name ?? (author.kind === 'agent' ? author.agentId : 'Agent'))
  const shownName =
    bold && sharedAgent ? `${sharedAgent.name}, shared from a one-to-one with you` : name
  const shownGlyph = bold && sharedAgent ? sharedAgent : !you ? agent : undefined
  const sharedStyle =
    bold && sharedAgent
      ? ({ '--shared-color': sharedAgent.style.color } as CSSProperties)
      : undefined
  const [expansion, setExpansion] = useState<Expansion>({ open: false, version: 0 })
  const showActions =
    !message.streaming &&
    !message.id.startsWith('pending-') &&
    !message.parts.some((part) => part.kind === 'summary')
  const cards = message.parts.filter((part) => part.kind === 'tool').length
  // PLAN 8.7: a sub-agent's calls are drawn inside its Agent card, not beside it.
  const nesting = (() => {
    const tools = message.parts.filter((part): part is ToolPart => part.kind === 'tool')
    const { top, children } = nestSubagentCalls(tools)
    return { children, hidden: new Set(tools.filter((tool) => !top.includes(tool))) }
  })()
  const writing = message.streaming && !you && !readOnly && !message.id.startsWith('pending-')
  const status = useStatusLine(author.kind === 'agent' ? author.agentId : null, {
    working: writing,
    parts: message.parts,
  })
  // Quiet figures under a finished agent reply; nothing while it is still being written.
  const speed = !you && !message.streaming ? speedLine(message.speed) : null
  return (
    <article
      id={`message-${message.id}`}
      className={`chat-message${you ? ' chat-message--you' : ''}${message.editedBy ? ' chat-message--edited' : ''}${readOnly ? ' chat-message--previous' : ''}${bold && sharedAgent ? ' bold-shared' : ''}`}
      aria-label={`Message from ${shownName}`}
      tabIndex={-1}
      data-protected={bold && sharedAgent ? 'block' : undefined}
      style={sharedStyle}
    >
      {shownGlyph && <AgentGlyph agent={shownGlyph} size="sm" decorative />}
      <div className="chat-message-body">
        <div className="chat-message-meta">
          <strong style={shownGlyph && { color: agentTextColor(shownGlyph.style.color) }}>
            {shownName}
          </strong>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {speed && <span className="chat-speed">{speed}</span>}
          {message.effort && author.kind === 'agent' && (
            <span className="bold-reply-effort">· effort {message.effort}</span>
          )}
          {message.editedBy && <span className="chat-edited">edited</span>}
          {imported && importedLabel && (
            <span className="chat-imported-chip">from {importedLabel}</span>
          )}
        </div>
        <div
          className="chat-message-parts"
          aria-live={message.streaming ? 'polite' : 'off'}
          aria-atomic="false"
        >
          {cards >= 3 && (
            <button
              type="button"
              className="chat-expand-all"
              onClick={() =>
                setExpansion((current) => ({
                  open: current.version === 0 ? true : !current.open,
                  version: current.version + 1,
                }))
              }
            >
              {expansion.version > 0 && expansion.open ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {message.parts.map((part, index) => {
            if (part.kind === 'tool' && nesting.hidden.has(part)) return null
            return (
              <Part
                key={partKey(message.parts, index)}
                workspaceLinkFor={workspaceLinkFor}
                workspacePrepare={workspacePrepare}
                approvalPointerIds={approvalPointerIds}
                nested={
                  part.kind === 'tool' && part.callId
                    ? (nesting.children.get(part.callId) ?? [])
                    : []
                }
                part={part}
                agents={agents}
                message={message}
                expansion={expansion}
                authorName={name}
                readOnly={readOnly}
                bold={bold}
              />
            )
          })}
        </div>
        {writing && <StatusLine line={status} live />}
        {!readOnly && message.streaming && !you && !message.id.startsWith('pending-') && (
          <StopReply message={message} name={name} />
        )}
        {!readOnly && message.editedBy && (
          <button
            type="button"
            className="chat-edited-link"
            onClick={() =>
              document
                .getElementById(`message-${message.editedBy}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          >
            see the new version
          </button>
        )}
        {(versionControl || (!readOnly && showActions)) && (
          <div className="chat-message-foot">
            {versionControl}
            {!readOnly && showActions && (
              <MessageActions message={message} name={name} agents={agents} imported={imported} />
            )}
          </div>
        )}
      </div>
    </article>
  )
}

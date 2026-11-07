import type { AgentSummary, Message, MessagePart } from '@score/contract'
import { ApprovalCard } from './ApprovalCard.tsx'
import { DocumentChip, WorkspaceChip } from './DocumentChips.tsx'
import { Markdown } from './Markdown.tsx'
import { PlanCard } from './PlanCard.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { ToolCard } from './MessageToolCard.tsx'
import type { Expansion, ToolPart } from './message-item-types.ts'
import { isNotProcessedNotice, MODEL_DIDNT_ANSWER } from './stall.ts'
import type { WorkspaceTarget } from './workspace-link.ts'

// A part keeps its component state (an open card, a code block's "Copied") when the final parts arrive with another kind
// inserted before it, which a plain index key would remount: key by kind and its position among parts of that kind.
export function partKey(parts: MessagePart[], index: number) {
  const kind = parts[index]!.kind
  let ordinal = 0
  for (let i = 0; i < index; i++) if (parts[i]!.kind === kind) ordinal++
  return `${kind}-${ordinal}`
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className="chat-card chat-thinking">
      <summary>{streaming ? 'Thinking…' : 'Thought process'}</summary>
      <p>{text}</p>
    </details>
  )
}

export function Part({
  part,
  agents,
  message,
  expansion,
  authorName,
  readOnly,
  nested,
  bold,
  workspaceLinkFor,
  workspacePrepare,
  approvalPointerIds,
}: {
  part: MessagePart
  nested: ToolPart[]
  workspaceLinkFor?: ((target: WorkspaceTarget) => string) | undefined
  workspacePrepare?: ((target: WorkspaceTarget) => Promise<void>) | undefined
  approvalPointerIds?: ReadonlySet<string> | undefined
  agents: AgentSummary[]
  message: Message
  expansion: Expansion
  authorName: string
  readOnly: boolean
  bold: boolean
}) {
  switch (part.kind) {
    case 'summary':
      return (
        <SummaryCard part={part} message={message} authorName={authorName} readOnly={readOnly} />
      )
    case 'text':
      if (!message.streaming && message.author.kind === 'agent' && isNotProcessedNotice(part.text))
        return (
          <p className="chat-model-failed" role="status">
            {MODEL_DIDNT_ANSWER}
          </p>
        )
      return (
        <>
          {part.via === 'mcp' && <span className="chat-via-mcp">via MCP</span>}
          <Markdown
            text={part.text}
            streaming={message.streaming}
            workspace={{
              agentId: message.author.kind === 'agent' ? message.author.agentId : null,
              agentIds: agents.map((agent) => agent.id),
              ...(workspaceLinkFor ? { linkFor: workspaceLinkFor } : {}),
              ...(workspacePrepare ? { prepare: workspacePrepare } : {}),
            }}
          />
        </>
      )
    case 'tool':
      return (
        <ToolCard
          part={part}
          expansion={expansion}
          live={message.streaming}
          nested={nested}
          agent={
            message.author.kind === 'agent'
              ? agents.find((item) => item.id === (message.author as { agentId: string }).agentId)
              : undefined
          }
        />
      )
    case 'thinking':
      return <Thinking text={part.text} streaming={message.streaming} />
    case 'tools':
      return <div className="chat-compact chat-tools">{part.summary}</div>
    case 'file':
      return (
        <div className="chat-compact chat-file">
          <code>{part.path}</code>
          <span className="chat-added">+{part.added}</span>
          <span className="chat-removed">−{part.removed}</span>
        </div>
      )
    case 'image':
      return (
        <img
          className="chat-image"
          src={`/api/media/${encodeURIComponent(part.mediaId)}`}
          alt="Attached image"
          loading="lazy"
        />
      )
    case 'document':
      return <DocumentChip part={part} />
    case 'workspace':
      return <WorkspaceChip part={part} />
    case 'review':
      return (
        <div className={`chat-compact chat-review chat-review--${part.verdict}`}>
          {part.verdict === 'approved' ? 'Approved' : 'Changes requested'}
        </div>
      )
    case 'approval':
      if (approvalPointerIds?.has(part.approvalId))
        return (
          <p className="chat-compact chat-notice" role="note">
            Waiting in Needs you
          </p>
        )
      return <ApprovalCard approvalId={part.approvalId} />
    case 'notice':
      return (
        <p className="chat-compact chat-notice" role="note">
          {part.text}
        </p>
      )
    case 'ref':
      return (
        <p className={`chat-compact chat-notice${bold ? ' bold-ref-chip' : ''}`} role="note">
          {bold ? 'Referring to' : 'Refers to'} “{part.title}”
        </p>
      )
    case 'shared':
      return (
        <blockquote className={`chat-compact${bold ? ' bold-shared-part' : ''}`}>
          <span className="chat-notice">
            Shared from a one-to-one{part.from.agentId ? ` with ${part.from.agentId}` : ''}
          </span>
          <Markdown text={part.text} streaming={false} />
        </blockquote>
      )
    case 'plan':
      return <PlanCard part={part} agents={agents} roomId={message.roomId} messageId={message.id} />
  }
}

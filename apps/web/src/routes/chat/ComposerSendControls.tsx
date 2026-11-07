import type { AgentSummary } from '@score/contract'
import { StopIcon } from '../../components/StopIcon.tsx'
import { ContextMeter } from './ContextMeter.tsx'

export function ComposerSendControls({
  roomMode,
  roomId,
  agents,
  meterAgents,
  finishedReplies,
  compactSubject,
  compactSignal,
  writingCount,
  text,
  editing,
  stopping,
  hold,
  pending,
  uploading,
  stopReplies,
}: {
  roomMode: boolean
  roomId: string
  agents: AgentSummary[]
  meterAgents: string[]
  finishedReplies: number
  compactSubject: string | null
  compactSignal: number
  writingCount: number
  text: string
  editing: boolean
  stopping: boolean
  hold?: string
  pending: boolean
  uploading: number
  stopReplies: () => Promise<void>
}) {
  return (
    <span className="chat-send-group">
      {/* Context rings sit just left of Send (owner request): one per addressed agent. */}
      {!roomMode && meterAgents.length > 0 && (
        <div className="chat-meter" role="group" aria-label="Context use">
          {meterAgents.map((id) => (
            <ContextMeter
              key={id}
              roomId={roomId}
              agentId={id}
              name={agents.find((agent) => agent.id === id)?.name ?? id}
              finishedReplies={finishedReplies}
              confirmSignal={id === compactSubject ? compactSignal : undefined}
            />
          ))}
        </div>
      )}
      {writingCount > 0 && !text.trim() && !editing ? (
        <button
          type="button"
          className="chat-send chat-send--stop"
          data-protected="inline-flex"
          aria-label={stopping ? 'Stopping…' : 'Stop'}
          title="Stop"
          aria-busy={stopping}
          disabled={stopping}
          onClick={() => void stopReplies()}
        >
          <StopIcon />
        </button>
      ) : (
        <button
          type="submit"
          className="chat-send"
          disabled={!text.trim() || Boolean(hold) || pending || uploading > 0}
        >
          {roomMode ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 19V5M6 11l6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="chat-sr-only">{editing ? 'Send correction' : 'Send'}</span>
            </>
          ) : editing ? (
            'Send correction'
          ) : (
            'Send'
          )}
        </button>
      )}
    </span>
  )
}

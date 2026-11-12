import { Link } from 'react-router'
import type { CommandResult } from './composer-model.ts'
import type { Notice } from './composer-types.ts'
import { UsageCard } from './UsageCard.tsx'
import { ReleaseHeld } from '../team/ReleaseHeld.tsx'

function CommandNotice({ command }: { command: CommandResult | null }) {
  if (!command) return null
  if (command.kind === 'assign') return <>Created task {command.taskKey}</>
  if (command.kind === 'model') return <>Sent using {command.model}</>
  return <>Command applied</>
}

export function ComposerNotice({ notice, pending }: { notice: Notice | null; pending: boolean }) {
  if (!notice) return null
  return (
    <div
      className={`chat-composer-notice${notice.kind === 'error' ? ' chat-composer-notice--error' : ''}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.kind === 'result' ? (
        <CommandNotice command={notice.command} />
      ) : notice.kind === 'usage' ? (
        <UsageCard card={notice.card} fallback={notice.text} />
      ) : (
        <span className="chat-usage-card">
          {notice.text}
          {notice.kind === 'error' && notice.action && (
            <>
              {' '}
              <Link className="link" to={notice.action.to}>
                {notice.action.label}
              </Link>
            </>
          )}
          {notice.kind === 'error' && notice.retry && (
            <>
              {' '}
              <button type="button" className="link" disabled={pending} onClick={notice.retry.run}>
                {notice.retry.label}
              </button>
            </>
          )}
        </span>
      )}
      {notice.kind === 'error' && notice.heldAgent && <ReleaseHeld agentId={notice.heldAgent} />}
    </div>
  )
}

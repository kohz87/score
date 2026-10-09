import { openPopOut } from './pop-out.ts'

export function PopOutButton({
  agentId,
  agentName,
  className,
}: {
  agentId: string
  agentName: string
  className: string
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={`Open ${agentName} in its own window`}
      title="Open in its own window"
      onClick={() => openPopOut(agentId)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

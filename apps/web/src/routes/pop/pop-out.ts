/** The compact per-agent view (7.4b). It is an ordinary route on the same origin, so the session cookie carries over. */
export const popOutPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/pop`

/** One window per agent: a second click focuses the window the first one opened instead of making another. */
export const popOutWindowName = (agentId: string) =>
  `score-agent-${agentId.replace(/[^\w-]/g, '_')}`

export function openPopOut(agentId: string): void {
  const opened = window.open(
    popOutPath(agentId),
    popOutWindowName(agentId),
    'popup=yes,width=480,height=820',
  )
  opened?.focus()
}

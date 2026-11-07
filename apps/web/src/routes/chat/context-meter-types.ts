export interface MeterProps {
  roomId: string
  agentId: string
  name: string
  /** The session to read; the room session when omitted (a job's thread passes its own). */
  sessionId?: string
  /** Changes after every finished reply: the reading is refreshed. */
  finishedReplies: number
  /** Opens the popover on the compact confirmation (the `/compress` command). */
  confirmSignal?: number | undefined
  /** `bar`: the chat's context bar draws it as "Context ▬ N%" (mock-up board 18) instead of the ring. */
  variant?: 'ring' | 'bar'
}

import { z } from 'zod'

// §3 Web terminal (PLAN 7.3): off unless the server starts with SCORE_TERMINAL=1 (the routes do not exist otherwise).
/** A one-time ticket for exactly one terminal WebSocket; valid 60 s, bound to the minting session and origin. */
export const TerminalTicketSchema = z.object({
  ticket: z.string().min(40).max(128),
  expiresAt: z.iso.datetime(),
})
export type TerminalTicket = z.infer<typeof TerminalTicketSchema>

export const TerminalSessionSchema = z.object({
  id: z.uuid(),
  openedAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  /** The paired browser's address when it opened the terminal. */
  address: z.string(),
  cols: z.int().min(1),
  rows: z.int().min(1),
})
export type TerminalSession = z.infer<typeof TerminalSessionSchema>
export const TerminalSessionsSchema = z.object({ items: z.array(TerminalSessionSchema) })

/** JSON control frames on the terminal WebSocket (text frames); stdin and stdout are binary frames. */
export const TerminalClientFrameSchema = z.object({
  type: z.literal('resize'),
  cols: z.int().min(1).max(500),
  rows: z.int().min(1).max(200),
})
export const TerminalServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), id: z.uuid(), user: z.string() }),
  z.object({
    type: z.literal('exit'),
    reason: z.enum(['exited', 'idle', 'limit', 'closed', 'revoked', 'stalled', 'stopped']),
    code: z.int().nullable(),
  }),
])
export type TerminalClientFrame = z.infer<typeof TerminalClientFrameSchema>
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>

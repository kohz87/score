import type { MessagePart } from '@score/contract'

/** Expand all / Collapse all (PLAN 5.25): a counter, so pressing the same button twice still reaches cards opened by hand. */
export type Expansion = { open: boolean; version: number }

export type ToolPart = Extract<MessagePart, { kind: 'tool' }>

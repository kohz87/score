import {
  RewindPlanSchema,
  RewindResponseSchema,
  type RewindMode,
  type RewindSkipReason,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

// Rewind (PLAN 5.33): editing or deleting your own message hides it and everything after it as a previous version and
// takes the agents' Hermes sessions back to just before it.
const base = (roomId: string, messageId: string) =>
  `rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`

export async function fetchRewindPlan(roomId: string, messageId: string) {
  return RewindPlanSchema.parse(await apiFetch(`${base(roomId, messageId)}/rewind-plan`))
}

export async function postRewind(
  roomId: string,
  messageId: string,
  mode: RewindMode,
  scoreOnly: boolean,
  key: string = newId(),
) {
  return RewindResponseSchema.parse(
    await apiFetch(`${base(roomId, messageId)}/rewind`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ mode, ...(scoreOnly ? { scoreOnly: true } : {}) }),
    }),
  )
}

export const REASON_TEXT: Record<RewindSkipReason, string> = {
  score_only: 'not rewound (hidden in Score only)',
  compressed: 'its Hermes session was compressed after this message',
  bridge_unavailable: 'its Hermes gateway is not running or Score’s bridge is not loaded in it',
  turn_count_mismatch: 'Hermes’s history does not match what Score recorded',
  no_session: 'Hermes has no session for this room',
  rewind_failed: 'Hermes refused the rewind',
  no_answer: 'Hermes did not answer in time (it may or may not have been rewound)',
}

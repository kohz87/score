import type { JournalEntry } from './journal-entry.ts'

/** What the journal says about the history reset and the freeze (decision 72). */
export interface HistoryState {
  /** The newest history-reset record's generation, or null when this journal never had one. */
  generation: string | null
  /** When that reset record was written (attempts created before it belong to the archived history). */
  resetAt: string | null
  /** The matching `history-reset-complete` came after it. */
  complete: boolean
  /** The reason of a freeze record no completed reset superseded, or null. */
  freeze: string | null
}

/** Replays the reset and freeze records in order. A completed reset of the current generation supersedes what came before. */
export function foldHistory(entries: readonly JournalEntry[], scope: string): HistoryState {
  const state: HistoryState = { generation: null, resetAt: null, complete: false, freeze: null }
  for (const entry of entries) {
    if (entry.scope !== scope) continue
    if (entry.kind === 'history-reset') {
      state.generation = entry.generation
      state.resetAt = entry.at
      state.complete = false
      state.freeze = null
    } else if (entry.kind === 'history-reset-complete') {
      if (entry.generation === state.generation) {
        state.complete = true
        state.freeze = null
      }
    } else if (entry.kind === 'execution-freeze') {
      state.freeze ??= entry.reason
    }
  }
  return state
}

/** Why the history is held according to the journal alone, or null. */
export function historyHold(state: HistoryState): string | null {
  if (state.generation !== null && !state.complete)
    return 'a history reset was started but not finished'
  return state.freeze
}

export type HistoryRead = ({ ok: true } & HistoryState) | { ok: false; reason: string }

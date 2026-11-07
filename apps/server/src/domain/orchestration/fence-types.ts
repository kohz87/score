import { type FenceItem } from '@score/contract'
import { z } from 'zod'

export const GlobalRowSchema = z.object({
  fenced: z.int(),
  reason: z.string().nullable(),
  fence_seq: z.int(),
  untrusted_history: z.int(),
  revision: z.int(),
  since: z.string().nullable(),
})
export const ItemRowSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  journal_n: z.int().nullable(),
  detail: z.string(),
})

export interface Mismatch {
  kind: FenceItem['kind']
  ref: string
  journalN: number | null
  detail: string
  /** The database holds more than the journal does: the journal lost records (a truncated or replaced file). */
  lost?: boolean
}

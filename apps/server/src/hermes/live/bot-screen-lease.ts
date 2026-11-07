import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const LeaseSchema = z
  .object({
    holder: z.enum(['agent', 'human']),
    viewer_id: z.string().nullable().optional(),
    epoch: z.int().nonnegative().optional(),
  })
  .loose()

export interface LeaseView {
  holder: 'agent' | 'human'
  viewerId: string | null
  epoch: number
}
// Hermes' reading of a file it can't parse: a human holds it, and it is nobody's viewer (never Score's).
const UNREADABLE: LeaseView = { holder: 'human', viewerId: 'unreadable-lease', epoch: -1 }

/** Hermes' rule (lease.py `_read`): no file = the agent holds; unreadable or corrupt = a human holds. */
export async function readLease(botDir: string): Promise<LeaseView> {
  let raw: string
  try {
    raw = await readFile(join(botDir, 'lease.json'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { holder: 'agent', viewerId: null, epoch: 0 }
      : UNREADABLE
  }
  try {
    const parsed = LeaseSchema.safeParse(JSON.parse(raw.replace(/^\uFEFF/u, '')))
    if (!parsed.success) return UNREADABLE
    return {
      holder: parsed.data.holder,
      viewerId: parsed.data.viewer_id ?? null,
      epoch: parsed.data.epoch ?? 0,
    }
  } catch {
    return UNREADABLE
  }
}

export async function leaseHolder(botDir: string): Promise<'agent' | 'human'> {
  return (await readLease(botDir)).holder
}

export async function sandboxed(botDir: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(await readFile(join(botDir, 'sandbox.json'), 'utf8'))
    return typeof marker === 'object' && marker !== null && Object.keys(marker).length > 0
  } catch {
    return false
  }
}

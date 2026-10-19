import { PackRevSchema, PetPackSchema, type PetPack } from '@score/contract'

/** The pack of a row: its revision column and its JSON meta. Anything that isn't a valid pack reads as none. */
export function parsePack(rev: string | null, meta: string | null): PetPack | null {
  if (rev === null || meta === null || !PackRevSchema.safeParse(rev).success) return null
  try {
    const fields: unknown = JSON.parse(meta)
    const parsed = PetPackSchema.safeParse({ ...(fields as object), rev })
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** What goes in the meta column: the pack without its revision (that has a column of its own). */
export function packMeta(pack: PetPack | null): { rev: string | null; meta: string | null } {
  if (pack === null) return { rev: null, meta: null }
  const valid = PetPackSchema.parse(pack)
  return {
    rev: valid.rev,
    meta: JSON.stringify({
      activities: valid.activities,
      name: valid.name,
      credits: valid.credits,
      floor: valid.floor,
    }),
  }
}

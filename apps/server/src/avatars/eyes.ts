import { AvatarEyesSchema, type AvatarEyes } from '@score/contract'

/** The eye marks stored as JSON; anything that is not valid marks (damaged JSON, wrong shape) reads as none. */
export function parseAvatarEyes(stored: string | null): AvatarEyes | null {
  if (stored === null) return null
  try {
    const parsed = AvatarEyesSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

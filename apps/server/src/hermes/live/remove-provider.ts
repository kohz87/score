import { HttpError } from '../../errors.ts'

/**
 * Removing a provider (2.0.3): a local one from every profile that defines it, then any stored credentials under the
 * same id. Every profile must answer first: an unreadable one stops the removal (502), since a "no" there could leave a
 * copy behind or send a local id down the credential path. Profiles are cleaned one at a time; a failure part way
 * leaves the earlier ones cleaned, and trying again finishes the rest.
 */
export async function removeProviderAcross(
  id: string,
  deps: {
    profiles: string[]
    defines: (profile: string, id: string) => Promise<boolean | null>
    removeLocal: (profile: string, id: string) => Promise<void>
    removeHosted: (id: string) => Promise<void>
  },
): Promise<void> {
  const answers = await Promise.all(deps.profiles.map((profile) => deps.defines(profile, id)))
  if (answers.some((answer) => answer === null))
    throw new HttpError(
      502,
      'hermes_unavailable',
      'Couldn’t read every agent’s providers, so nothing was removed.',
    )
  const local = deps.profiles.filter((_, at) => answers[at] === true)
  if (local.length === 0) return deps.removeHosted(id)
  for (const profile of local) await deps.removeLocal(profile, id)
  try {
    await deps.removeHosted(id)
  } catch (error) {
    // Nothing stored under that id is the usual case for a local provider.
    if (!(error instanceof HttpError && error.code === 'not_supported')) throw error
  }
}

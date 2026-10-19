import { ApiError } from '../../data/api.ts'

/** The plain-words reasons a picture route refused something: the server's list on a 422, else its message. */
export function avatarProblems(
  error: unknown,
  fallback = 'Couldn’t save the picture. Try again.',
): string[] {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return ['Pair this browser using the link in the server terminal to change agent pictures.']
    const reasons = (error.details as { reasons?: unknown } | undefined)?.reasons
    if (Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string'))
      return reasons.length > 0 ? (reasons as string[]) : [error.message]
    return [error.message]
  }
  return [fallback]
}

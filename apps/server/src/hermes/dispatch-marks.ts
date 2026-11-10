import { HttpError } from '../errors.ts'

/** Marks a refusal raised before anything was sent to Hermes (callers may conclude nothing was dispatched). */
export function notDispatched(error: unknown): unknown {
  return error instanceof HttpError
    ? new HttpError(error.status, error.code, error.message, { notDispatched: true })
    : error
}
export function isNotDispatched(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { notDispatched?: unknown }).notDispatched === true
  )
}

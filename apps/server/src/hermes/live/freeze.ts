import { HttpError } from '../../errors.ts'

/**
 * The one refusal for every outgoing Hermes execution or control call while Score holds all agent work (decisions 71
 * and 72): dispatching a run or a chat reply, any Stop, approval delivery. Nothing is sent; the person reads the
 * sentence and resets the history to leave the state.
 */
export function executionFrozenError(notice: string): HttpError {
  return new HttpError(423, 'execution_frozen', notice, { notice })
}

/** Throws the freeze refusal when `frozen` names a reason. Evaluated at every call, never cached. */
export function assertThawed(frozen: (() => string | null) | undefined): void {
  const notice = frozen?.() ?? null
  if (notice !== null) throw executionFrozenError(notice)
}

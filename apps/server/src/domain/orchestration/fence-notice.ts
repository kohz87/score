/**
 * What the person reads (fence screen, coding card) while Score holds all agent work. A frozen state is only left with
 * `scripts/score installation reset-history`; an unresolved installation says what to do about the installation instead.
 */
export function holdingNotice(why: string, resettable = true): string {
  const reason = why.trim().replace(/[.]$/, '')
  return `Score is holding all agent work: ${reason}.${resettable ? ' Run scripts/score installation reset-history to continue.' : ''}`
}

/** The fence item that carries the freeze (the web fence screen shows its sentence and no lift button). */
export const FROZEN_REF = 'execution-frozen'

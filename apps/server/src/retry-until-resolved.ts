/**
 * Runs `work` until it reports nothing unresolved. Delays follow `delays` (the last one repeats), so a Hermes
 * outage longer than the fast phase keeps being retried slowly instead of being given up on silently.
 *
 * `stop()` ends future attempts and resolves once an attempt already running has settled, so shutdown can wait for
 * it before closing what it uses. Every attempt is also handed to `track` (the server's job tracker).
 */
export function retryUntilResolved(
  work: () => Promise<number>,
  delays: readonly number[],
  {
    immediate = true,
    track,
  }: { immediate?: boolean; track?: (attempt: Promise<unknown>) => void } = {},
): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let attempt = 0
  let active: Promise<void> | undefined
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, delays[Math.min(attempt, delays.length - 1)]!)
    timer.unref()
  }
  const run = () => {
    attempt++
    const current = work().then((unresolved) => {
      if (unresolved > 0) schedule()
    }, schedule)
    const settled = current.finally(() => {
      if (active === settled) active = undefined
    })
    active = settled
    track?.(settled)
  }
  if (immediate) run()
  else schedule()
  return {
    async stop() {
      stopped = true
      clearTimeout(timer)
      await active
    },
  }
}

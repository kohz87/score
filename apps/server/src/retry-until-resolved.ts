/**
 * Runs `work` until it reports nothing unresolved. Delays follow `delays` (the last one repeats), so a Hermes
 * outage longer than the fast phase keeps being retried slowly instead of being given up on silently.
 */
export function retryUntilResolved(
  work: () => Promise<number>,
  delays: readonly number[],
  { immediate = true }: { immediate?: boolean } = {},
): { stop(): void } {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let attempt = 0
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, delays[Math.min(attempt, delays.length - 1)]!)
    timer.unref()
  }
  const run = () => {
    attempt++
    void work().then((unresolved) => {
      if (unresolved > 0) schedule()
    }, schedule)
  }
  if (immediate) run()
  else schedule()
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

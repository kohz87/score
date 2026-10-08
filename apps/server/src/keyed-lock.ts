const tails = new Map<string, Promise<unknown>>()

/** Runs `work` after every earlier call with the same key has settled (in-process; Score is one process). */
export function withKeyedLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(work, work)
  const tail = run.catch(() => undefined)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}

/**
 * One queue per Hermes profile for everything that changes its config.yaml. Each `hermes config set` (and the
 * tools/plugins verbs) reads and rewrites the whole file, so two writers in flight can undo each other.
 * Hermes processes outside Score are not covered; the verified read-back after each write catches those.
 */
export class ProfileLocks {
  private readonly tails = new Map<string, Promise<unknown>>()
  run<T>(profile: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(profile) ?? Promise.resolve()).then(work, work)
    const tail = result.catch(() => undefined)
    this.tails.set(profile, tail)
    void tail.then(() => {
      if (this.tails.get(profile) === tail) this.tails.delete(profile)
    })
    return result
  }
}

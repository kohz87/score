/** A sliding-window counter per key (an IP address), in memory: the share route allows `limit` requests per window. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records a request and says whether it is within the limit. */
  allow(key: string): boolean {
    const now = this.clock()
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    const allowed = recent.length < this.limit
    if (allowed) recent.push(now)
    // A refused request is not recorded: the window frees up as old requests age out.
    this.#hits.set(key, recent)
    if (this.#hits.size > 5000) this.prune(now)
    return allowed
  }

  private prune(now: number): void {
    for (const [key, hits] of this.#hits)
      if (hits.every((at) => now - at >= this.windowMs)) this.#hits.delete(key)
  }
}

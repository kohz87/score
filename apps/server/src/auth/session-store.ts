export interface SessionStore {
  create(hash: string, expiresAt: number): void
  has(hash: string, now: number): boolean
  revoke(hash: string): void
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, number>()

  create(hash: string, expiresAt: number): void {
    this.#sessions.set(hash, expiresAt)
  }

  has(hash: string, now: number): boolean {
    const expiresAt = this.#sessions.get(hash)
    if (expiresAt === undefined) return false
    if (now >= expiresAt) {
      this.#sessions.delete(hash)
      return false
    }
    return true
  }

  revoke(hash: string): void {
    this.#sessions.delete(hash)
  }
}

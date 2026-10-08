import { z } from 'zod'

export const RemoteSessionSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().uuid(),
  label: z.string().max(200),
  address: z.string().max(100),
  createdAt: z.int(),
  lastSeenAt: z.int(),
  expiresAt: z.int(),
})
export type RemoteSession = z.infer<typeof RemoteSessionSchema>

export interface SessionStore {
  create(hash: string, expiresAt: number): void
  has(hash: string, now: number): boolean
  revoke(hash: string): void
  createRemote(session: RemoteSession): void
  getRemote(hash: string): RemoteSession | undefined
  listRemote(): RemoteSession[]
  touchRemote(hash: string, now: number, address: string): void
  /** A fresh lifetime from `now`: renewing counts as activity, so the idle clock restarts too. */
  renewRemote(hash: string, now: number, expiresAt: number): void
  revokeRemote(hash: string): void
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, number>()
  readonly #remote = new Map<string, RemoteSession>()

  createRemote(session: RemoteSession): void {
    this.#remote.set(session.hash, RemoteSessionSchema.parse(session))
  }
  getRemote(hash: string): RemoteSession | undefined {
    return this.#remote.get(hash)
  }
  listRemote(): RemoteSession[] {
    return [...this.#remote.values()]
  }
  touchRemote(hash: string, now: number, address: string): void {
    const session = this.#remote.get(hash)
    if (session) this.#remote.set(hash, { ...session, lastSeenAt: now, address })
  }
  renewRemote(hash: string, now: number, expiresAt: number): void {
    const session = this.#remote.get(hash)
    if (session) this.#remote.set(hash, { ...session, lastSeenAt: now, expiresAt })
  }
  revokeRemote(hash: string): void {
    this.#remote.delete(hash)
  }

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

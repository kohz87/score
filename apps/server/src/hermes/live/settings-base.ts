import { HttpError } from '../../errors.ts'
import { redactBounded } from '../../redact.ts'
import {
  runHermes,
  spawnHermes,
  type HermesChild,
  type HermesRunner,
  type HermesSpawner,
} from './cli.ts'
import { SignInManager } from './sign-in.ts'
import { ProfileLocks } from './profile-locks.ts'
import { resolveHermesHome } from './paths.ts'
import type { ProviderBase } from '../port.ts'
import { CATALOG, FREE_TIER, HEADER, READ_TIMEOUT_MS, ROW, title } from './settings-catalog.ts'

export abstract class LiveSettingsBase {
  protected readonly home: string
  constructor(
    hermesHome: string | undefined,
    protected readonly runner: HermesRunner = runHermes,
    /** Every provider Hermes supports (from the gateway); null when it can't be read. */
    protected readonly providerCatalog: () => Promise<
      { slug: string; name: string; auth_type?: string | undefined }[] | null
    > = async () => null,
    /** The profile whose credentials the provider routes act on; none = Hermes's default. */
    protected readonly profile?: string,
    protected readonly spawner: HermesSpawner = spawnHermes,
    protected readonly locks: ProfileLocks = new ProfileLocks(),
  ) {
    this.home = resolveHermesHome(hermesHome)
    this.signIns = new SignInManager({
      spawn: this.spawner,
      hermesHome: this.home,
      profileArgs: this.profileArgs(),
      isConnected: async (id) =>
        (await this.pooled()).some((item) => item.id === id && item.status === 'connected'),
    })
  }
  protected readonly signIns: SignInManager
  protected readonly keyInFlight = new Set<string>()
  /** Key children still running, so shutdown can stop them (audit 2026-10-08). */
  protected readonly keyChildren = new Set<HermesChild>()
  protected closed = false
  protected admit(): void {
    if (this.closed)
      throw new HttpError(
        503,
        'unavailable',
        'Score is shutting down. Try again once it has restarted.',
      )
  }
  protected profileArgs(): string[] {
    return this.profile ? ['-p', this.profile] : []
  }
  /** Stops admitting sign-ins and stops every child still running: device sign-ins and pasted-key adds. */
  close(): void {
    this.closed = true
    this.signIns.close()
    for (const child of this.keyChildren) child.kill()
  }

  protected async read(args: string[], fresh = false): Promise<string | null> {
    const result = await this.runner([...this.profileArgs(), ...args], {
      timeoutMs: READ_TIMEOUT_MS,
      hermesHome: this.home,
      captureSettings: true,
      ...(fresh ? { fresh: true } : {}),
    })
    return result.exitCode === 0 && result.stdout !== undefined ? result.stdout : null
  }
  protected async readJson(args: string[], fresh = false): Promise<unknown> {
    const text = await this.read(args, fresh)
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** The last `auth list` that answered: a failed or timed-out read keeps it instead of showing everything missing. */
  protected lastAuthList: string | null = null
  protected async pooled(): Promise<ProviderBase[]> {
    const text = (await this.read(['auth', 'list'])) ?? this.lastAuthList
    this.lastAuthList = text
    const found = new Map<string, { n: number; failed: number; oauth: boolean }>()
    const free: ProviderBase[] = []
    let current: { n: number; failed: number; oauth: boolean } | undefined
    for (const line of (text ?? '').split(/\r?\n/)) {
      const header = HEADER.exec(line)
      if (header) {
        current = { n: 0, failed: 0, oauth: false }
        found.set(header[1]!, current)
        continue
      }
      const row = ROW.exec(line)
      if (row && current) {
        current.n++
        current.oauth ||= row[1] === 'oauth'
        if (/auth failed|re-auth/i.test(row[2]!)) current.failed++
        continue
      }
      const note = FREE_TIER.exec(line)
      if (note && !line.startsWith(' ')) {
        current = undefined
        free.push({
          id: note[1]!,
          label: CATALOG[note[1]!] ?? title(note[1]!),
          status: 'connected',
          detail: redactBounded(note[2]!, 120),
        })
      }
    }
    const items: ProviderBase[] = [...free]
    for (const [id, entry] of found) {
      if (entry.n === 0) continue
      items.push({
        id,
        label: CATALOG[id] ?? title(id),
        status: entry.failed === entry.n ? 'needs_signin' : 'connected',
        detail:
          id === 'openai-codex'
            ? 'Your ChatGPT plan'
            : entry.oauth
              ? 'Signed in'
              : `API key (${entry.n})`,
      })
    }
    return items
  }
}

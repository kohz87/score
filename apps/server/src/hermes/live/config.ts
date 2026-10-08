import { z } from 'zod'
import { runHermes, type HermesRunner } from './cli.ts'
import { ProfileLocks } from './profile-locks.ts'
import { resolveHermesHome } from './paths.ts'
import { ConfigService, type ConfigBackend, type ConfigIndexEntry } from '../config-service.ts'
import index from './config-index.json' with { type: 'json' }

// The index is generated from the tested Hermes version's defaults (scripts/gen-config-index.py); current
// values come from `hermes config get --json <section>`, which masks credential-shaped fields.
const IndexSchema = z.object({
  generatedFrom: z.string(),
  entries: z.array(
    z.object({
      key: z.string(),
      description: z.string().optional(),
      default: z.unknown().optional(),
    }),
  ),
})
export const CONFIG_INDEX: ConfigIndexEntry[] = IndexSchema.parse(index).entries

const TIMEOUT_MS = 8000

export class LiveConfigBackend implements ConfigBackend {
  readonly file = 'config.yaml'
  private readonly home: string
  constructor(
    hermesHome: string | undefined,
    private readonly runner: HermesRunner = runHermes,
    private readonly locks: ProfileLocks = new ProfileLocks(),
  ) {
    this.home = resolveHermesHome(hermesHome)
  }
  async readSection(top: string): Promise<{ found: boolean; value?: unknown }> {
    const result = await this.runner(['config', 'get', '--json', top], {
      timeoutMs: TIMEOUT_MS,
      hermesHome: this.home,
      captureRead: true,
    })
    if (result.exitCode !== 0 || result.stdout === undefined) return { found: false }
    try {
      return { found: true, value: JSON.parse(result.stdout) as unknown }
    } catch {
      return { found: false }
    }
  }
  async write(key: string, value: string): Promise<boolean> {
    // Unscoped commands act on the default profile (cli.ts pinScope).
    const result = await this.locks.run('default', () =>
      this.runner(['config', 'set', key, value], { timeoutMs: TIMEOUT_MS, hermesHome: this.home }),
    )
    return result.exitCode === 0
  }
}

export function createLiveConfigService(
  hermesHome: string | undefined,
  runner?: HermesRunner,
  locks?: ProfileLocks,
) {
  return new ConfigService(new LiveConfigBackend(hermesHome, runner, locks), CONFIG_INDEX)
}

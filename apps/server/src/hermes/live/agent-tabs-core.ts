import { HttpError } from '../../errors.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { ProfileLocks } from './profile-locks.ts'
import { ProfileNameSchema } from './paths.ts'

/** Shared profile lookup, locking and CLI writes for the focused agent-tabs modules. */
export abstract class AgentTabsCore {
  constructor(
    protected readonly hermesHome: string,
    protected readonly homeOf: (profile: string) => string | null,
    protected readonly invalidate: (profile: string) => void,
    protected readonly runner: HermesRunner = runHermes,
    protected readonly locks: ProfileLocks = new ProfileLocks(),
  ) {}

  // Every change to a profile's config.yaml (model, skills, tools, plugins, approvals) shares one queue.
  protected serial<T>(profile: string, work: () => Promise<T>): Promise<T> {
    return this.locks.run(profile, work)
  }
  protected profile(agentId: string): { profile: string; home: string } {
    const parsed = ProfileNameSchema.safeParse(agentId)
    const home = parsed.success ? this.homeOf(parsed.data) : null
    if (!parsed.success || !home) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return { profile: parsed.data, home }
  }
  protected async mutate(profile: string, args: string[], timeoutMs = 15000): Promise<void> {
    const result = await this.runner(['-p', profile, ...args], {
      timeoutMs,
      hermesHome: this.hermesHome,
    }).catch(() => ({ exitCode: -1 }))
    this.invalidate(profile)
    if (result.exitCode !== 0)
      throw new HttpError(
        result.exitCode < 0 ? 502 : 409,
        result.exitCode < 0 ? 'hermes_unavailable' : 'conflict',
        'Hermes didn’t accept the change.',
      )
  }
}

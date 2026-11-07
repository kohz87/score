import { PluginIdSchema, type PluginItem } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { AgentTabsTools } from './agent-tabs-tools.ts'
import { isBridgePlugin, readPlugins } from './agent-config.ts'

/** Plugin listing and toggles for one Hermes profile. */
export abstract class AgentTabsPlugins extends AgentTabsTools {
  async listPlugins(agentId: string): Promise<PluginItem[]> {
    const { profile } = this.profile(agentId)
    const plugins = await readPlugins(this.runner, this.hermesHome, profile)
    if (!plugins)
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t list the plugins from Hermes.')
    return plugins
  }
  /** `plugins enable|disable <name>`, then a re-read to verify. The Score bridge is never touched. */
  async setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<PluginItem> {
    PluginIdSchema.parse(id)
    const { profile } = this.profile(agentId)
    if (isBridgePlugin(id))
      throw new HttpError(
        409,
        'conflict',
        'Score’s plugin stays on: Score needs it to see what this agent does.',
      )
    return this.serial(profile, async () => {
      const before = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!before) throw new HttpError(404, 'not_found', 'Couldn’t find that plugin.')
      if (before.enabled !== enabled)
        await this.mutate(profile, ['plugins', enabled ? 'enable' : 'disable', id])
      const after = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes didn’t apply the change.')
      return after
    })
  }
}
